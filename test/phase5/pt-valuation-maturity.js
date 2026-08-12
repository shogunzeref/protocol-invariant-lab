// PT valuation: the four distinct values, and how they behave across the
// maturity sweep required by the brief (365/180/90/30/14/7/1 days).

const assert = require("assert");

const val = require("../../models/pendle-pt-valuation");
const amm = require("../../models/pendle-amm");
const scen = require("../../models/phase5-scenarios");

const HORIZONS = [365, 180, 90, 30, 14, 7, 1];

describe("phase5: PT valuation and maturity behaviour", () => {
  const anchor = scen.largestTwapScenario();
  const blockTime = scen.scenarioBlockTime(anchor);
  const at = (days) =>
    scen.reshape(anchor.market, { timeToMaturitySeconds: days * 86400, blockTime });

  it("keeps the four valuations distinct and correctly ordered", () => {
    // redemption >= market-implied >= realizable, and the oracle sits somewhere
    // among them depending on its design. Collapsing any pair of these would
    // hide the entire question being investigated.
    for (const days of HORIZONS) {
      const market = at(days);
      const snap = val.valuationSnapshot({
        market,
        blockTime,
        oracle: { kind: "PendleChainlinkOracle", twapLnImpliedRate: market.lastLnImpliedRate },
        liquidationSize: market.totalPt * 0.01,
      });

      assert.ok(
        val.REDEMPTION_CEILING >= snap.marketImpliedValue,
        `${days}d: market-implied ${snap.marketImpliedValue} exceeded redemption value`
      );
      assert.ok(
        snap.marketImpliedValue > snap.realizableValue,
        `${days}d: realizable ${snap.realizableValue} not below market-implied ${snap.marketImpliedValue}`
      );
    }
  });

  it("converges every valuation to par as maturity approaches", () => {
    let previousGap = Infinity;
    for (const days of HORIZONS) {
      const market = at(days);
      const gap = val.REDEMPTION_CEILING - val.marketImpliedValue(market, blockTime);
      assert.ok(gap > 0, `${days}d: no discount at all`);
      assert.ok(gap < previousGap, `${days}d: discount ${gap} did not shrink from ${previousGap}`);
      previousGap = gap;
    }
    assert.ok(previousGap < 1e-3, `1d discount ${previousGap} implausibly wide`);
  });

  it("shrinks the oracle-vs-realizable gap toward maturity rather than widening it", () => {
    // This is the direction the brief asks about explicitly. The gap is driven by
    // the price impact of unwinding, and price impact falls as the curve
    // flattens near expiry.
    let previous = Infinity;
    for (const days of HORIZONS) {
      const market = at(days);
      const snap = val.valuationSnapshot({
        market,
        blockTime,
        oracle: { kind: "PendleChainlinkOracle", twapLnImpliedRate: market.lastLnImpliedRate },
        liquidationSize: market.totalPt * 0.01,
      });
      const gap = snap.oracleOvervaluationVsRealizable;
      assert.ok(gap > 0, `${days}d: oracle did not exceed realizable value`);
      assert.ok(gap < previous, `${days}d: gap ${gap} did not shrink from ${previous}`);
      previous = gap;
    }
  });

  it("has the linear-discount oracle undervalue the PT at every horizon", () => {
    // PendleSparkLinearDiscountOracle reports 1 - discount * T, a straight line
    // below the exponential the market prices. Since it is a floor rather than a
    // tracker, it cannot be pushed up by trading at all -- but it also means
    // borrowers on those markets get less capacity than the PT is worth.
    for (const days of HORIZONS) {
      const market = at(days);
      const marketValue = val.marketImpliedValue(market, blockTime);
      for (const discount of [0.2, 0.3]) {
        const oracleValue = val.linearDiscountOracleValue({
          timeToMaturity: days * 86400,
          baseDiscountPerYear: discount,
        });
        assert.ok(
          oracleValue < marketValue,
          `${days}d @ ${discount}/yr: oracle ${oracleValue} >= market ${marketValue}`
        );
        assert.ok(oracleValue > 0 && oracleValue <= val.REDEMPTION_CEILING);
      }
    }
  });

  it("makes the linear-discount oracle completely insensitive to AMM state", () => {
    // Buying half the pool must not move it by a single wei-equivalent.
    const market = at(90);
    const before = val.linearDiscountOracleValue({ timeToMaturity: 90 * 86400, baseDiscountPerYear: 0.2 });
    amm.executeTrade(market, market.totalPt * 0.5, blockTime);
    const after = val.linearDiscountOracleValue({ timeToMaturity: 90 * 86400, baseDiscountPerYear: 0.2 });
    assert.strictEqual(before, after);
  });

  it("dilutes a displacement in proportion to the fraction of the TWAP window held", () => {
    // A PendleChainlinkOracle averages ln(implied rate) over `twapDuration`, so
    // holding a displacement for t of a w-second window transmits t/w of it. A
    // single-block displacement against a 900s window transmits ~1/75.
    const duration = 900;
    const base = 0.1;
    const displaced = 0.05; // lower implied rate == higher PT price

    for (const held of [12, 90, 225, 450, 900]) {
      const diluted = amm.dilutedTwap(base, displaced, held, duration);
      const expected = base + ((displaced - base) * held) / duration;
      assert.ok(Math.abs(diluted - expected) < 1e-12, `held ${held}: ${diluted} vs ${expected}`);
    }

    // Holding beyond one full window cannot transmit more than 100%.
    assert.ok(Math.abs(amm.dilutedTwap(base, displaced, 3600, duration) - displaced) < 1e-12);
  });

  it("takes the minimum across legs, so the cheapest leg cannot raise the price", () => {
    // The Ojo PT feeds observed on live markets aggregate legs with min(). An
    // attacker who displaces the AMM leg upward changes nothing unless it was
    // already the low leg -- and then only until it stops being.
    assert.strictEqual(val.minAggregatedOracleValue([0.97, 0.94]), 0.94);
    assert.strictEqual(val.minAggregatedOracleValue([0.99, 0.94]), 0.94);
    // Pushing the high leg higher still yields the low leg.
    assert.strictEqual(val.minAggregatedOracleValue([1.0, 0.94]), 0.94);
  });

  it("reports a matured PT at par and refuses to discount it further", () => {
    assert.strictEqual(val.redemptionValue({ timeToMaturity: 0 }), val.REDEMPTION_CEILING);
    assert.strictEqual(val.redemptionValue({ timeToMaturity: -86400 }), val.REDEMPTION_CEILING);
    assert.strictEqual(
      val.linearDiscountOracleValue({ timeToMaturity: 0, baseDiscountPerYear: 0.3 }),
      val.REDEMPTION_CEILING
    );
  });
});

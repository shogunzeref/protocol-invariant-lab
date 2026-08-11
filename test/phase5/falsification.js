// Explicit falsification of hypotheses A-E from the Phase 5 brief.
//
// Each test states the hypothesis, then records the outcome the model produces.
// A hypothesis that fails is a result, not a failure of the test: the assertions
// below assert the FINDING, so if the underlying economics ever change the test
// breaks and the finding has to be revisited.

const assert = require("assert");

const morpho = require("../../models/morpho-market");
const val = require("../../models/pendle-pt-valuation");
const cost = require("../../models/pt-displacement-cost");
const lev = require("../../models/pt-recursive-leverage");
const scen = require("../../models/phase5-scenarios");

describe("phase5: falsification of hypotheses A-E", () => {
  const anchor = scen.largestTwapScenario();
  const blockTime = scen.scenarioBlockTime(anchor);
  const basePrice = val.marketImpliedValue(anchor.market, blockTime);
  const lltv = anchor.lltv;
  const at = (days, liquidityScale = 1) =>
    scen.reshape(anchor.market, { timeToMaturitySeconds: days * 86400, liquidityScale, blockTime });

  describe("A: a small price displacement materially increases Morpho borrowing power", () => {
    it("SUPPORTED in mechanism -- capacity is exactly proportional to the oracle price", () => {
      const collateral = 1e6;
      const base = morpho.maxBorrow({ collateral, price: basePrice, lltv });
      const moved = morpho.maxBorrow({ collateral, price: basePrice * 1.005, lltv });
      const gain = moved - base;

      assert.ok(gain > 0);
      // Exactly 0.5% more capacity: Morpho interposes no cap, band or damping
      // between price() and the health check.
      assert.ok(Math.abs(gain / base - 0.005) < 1e-9, `gain fraction ${gain / base}`);
    });

    it("QUALIFIED -- the gain is capacity, not value, and is bounded by the LLTV haircut", () => {
      // Extra capacity is extra DEBT. It only becomes an attacker gain if the
      // debt can exceed the independent value of the collateral, which needs a
      // displacement above 1/LLTV - 1.
      const threshold = morpho.insolvencyDisplacementThreshold(lltv);
      assert.ok(threshold > 0.09, `threshold ${threshold} unexpectedly small at lltv ${lltv}`);
      assert.ok(0.005 < threshold, "a 0.5% displacement should not breach the haircut");
    });
  });

  describe("B: the displacement can be produced economically", () => {
    it("FALSIFIED near maturity -- the par ceiling makes it impossible at any price", () => {
      for (const days of [30, 14, 7, 1]) {
        const r = cost.solveDisplacement(at(days), blockTime, 0.01);
        assert.strictEqual(r.achievable, false, `${days}d: a 1% displacement was achievable`);
        assert.strictEqual(r.bindingConstraint, "PT_PAR_CEILING");
      }
    });

    it("FALSIFIED at long maturity -- achievable, but only by taking down much of the pool", () => {
      const r = cost.solveDisplacement(at(365), blockTime, 0.005);
      assert.strictEqual(r.achievable, true);
      // A displacement this visible is not a stealth operation: it requires a
      // double-digit percentage of the pool's PT.
      assert.ok(r.ptFractionOfPool > 0.1, `needed only ${r.ptFractionOfPool} of the pool`);
      assert.ok(r.cost > 0);
    });

    it("FALSIFIED against the TWAP -- a single-block displacement barely reaches the oracle", () => {
      const displaced = cost.solveDisplacement(at(365), blockTime, 0.005);
      const transmitted = cost.oracleDisplacement({
        oracle: { kind: "PendleChainlinkOracle", twapDuration: anchor.twapDuration || 900 },
        marketDisplacement: displaced,
        heldSeconds: 12,
        market: at(365),
        blockTime,
      });
      // ~1/75 of a 900s window: a 0.5% market move becomes well under 1bp of
      // oracle move, while costing the full round trip.
      assert.ok(transmitted.transmitted < 0.0001, `transmitted ${transmitted.transmitted}`);
    });
  });

  describe("C: recursive looping creates insolvency", () => {
    it("FALSIFIED -- looping raises exposure and debt together, never crossing the haircut", () => {
      for (const depth of lev.LOOP_DEPTHS) {
        const loop = lev.runLoop({
          initialPt: anchor.market.totalPt * 0.01,
          market: anchor.market,
          oraclePrice: basePrice,
          lltv,
          depth,
          blockTime,
        });
        const settled = lev.settleLoop({
          loop,
          oraclePrice: basePrice,
          referencePricePerPt: basePrice,
          lltv,
          blockTime,
          initialPtCost: anchor.market.totalPt * 0.01 * basePrice,
        });
        assert.strictEqual(settled.solventUnderReferenceMark, true, `depth ${depth}`);
        assert.strictEqual(settled.protocolShortfall, 0, `depth ${depth}`);
      }
    });

    it("FALSIFIED with displacement too -- the achievable displacement is far below the haircut", () => {
      // 0.5% is the most this market yields at a 365d horizon; the haircut is
      // ~9.3%. Combining leverage with displacement does not close that gap,
      // because leverage scales collateral and debt by the same factor.
      const achievable = 0.005;
      const threshold = morpho.insolvencyDisplacementThreshold(lltv);
      assert.ok(achievable < threshold / 10);

      const loop = lev.runLoop({
        initialPt: anchor.market.totalPt * 0.01,
        market: anchor.market,
        oraclePrice: basePrice * (1 + achievable),
        lltv,
        depth: 20,
        blockTime,
      });
      const settled = lev.settleLoop({
        loop,
        oraclePrice: basePrice * (1 + achievable),
        referencePricePerPt: basePrice,
        lltv,
        blockTime,
        initialPtCost: anchor.market.totalPt * 0.01 * basePrice,
      });
      assert.strictEqual(settled.solventUnderReferenceMark, true);
      assert.strictEqual(settled.protocolShortfall, 0);
    });
  });

  describe("D: the collateral cannot be liquidated at the oracle-marked value", () => {
    it("SUPPORTED in part -- there is always a real, quantifiable unwind discount", () => {
      // This is the one hypothesis with a genuine positive result: the oracle
      // marks PT at the curve price, but a liquidator unwinding a large position
      // realises less. The gap is real -- it is just far smaller than the
      // liquidation incentive at these sizes.
      const loop = lev.runLoop({
        initialPt: anchor.market.totalPt * 0.01,
        market: anchor.market,
        oraclePrice: basePrice,
        lltv,
        depth: 20,
        blockTime,
      });
      const realizable = val.realizableValuePerPt(loop.market, loop.collateralPt, blockTime);
      assert.ok(realizable < basePrice, "no unwind discount at all");

      const settled = lev.settleLoop({
        loop,
        oraclePrice: basePrice,
        referencePricePerPt: basePrice,
        lltv,
        blockTime,
        initialPtCost: anchor.market.totalPt * 0.01 * basePrice,
      });
      assert.ok(settled.oracleOvervaluationVsRealizable > 0);
    });

    it("FALSIFIED as an attack -- the discount stays inside the liquidation incentive", () => {
      const loop = lev.runLoop({
        initialPt: anchor.market.totalPt * 0.01,
        market: anchor.market,
        oraclePrice: basePrice,
        lltv,
        depth: 20,
        blockTime,
      });
      const realizable = val.realizableValuePerPt(loop.market, loop.collateralPt, blockTime);
      const lif = morpho.liquidationIncentiveFactor(lltv);

      // Liquidators pay price/LIF and sell at `realizable`; they participate
      // while realizable > price/LIF.
      assert.ok(
        realizable > basePrice / lif,
        `unwind discount ${basePrice - realizable} exceeded the incentive margin ${basePrice - basePrice / lif}`
      );
    });
  });

  describe("E: manipulation remains viable net of all costs", () => {
    it("FALSIFIED -- the attacker's independent PnL is negative in every reachable configuration", () => {
      const initialPt = anchor.market.totalPt * 0.01;
      let evaluated = 0;

      for (const displacement of [0, 0.005]) {
        for (const depth of lev.LOOP_DEPTHS) {
          const oraclePrice = basePrice * (1 + displacement);
          const loop = lev.runLoop({ initialPt, market: anchor.market, oraclePrice, lltv, depth, blockTime });
          const settled = lev.settleLoop({
            loop,
            oraclePrice,
            referencePricePerPt: basePrice,
            lltv,
            blockTime,
            initialPtCost: initialPt * basePrice,
          });

          // Charge the attacker the cost of producing the displacement too.
          const manipulation =
            displacement === 0 ? 0 : (cost.solveDisplacement(anchor.market, blockTime, displacement).cost ?? 0);
          const net = settled.attackerPnL - manipulation;

          assert.ok(
            net < 0,
            `displacement ${displacement}, depth ${depth}: attacker netted ${net}`
          );
          evaluated++;
        }
      }
      assert.ok(evaluated === 12);
    });

    it("FALSIFIED structurally on every live market -- the PT trades above the LLTV", () => {
      // Available displacement is capped at 1/P - 1 by the redemption ceiling;
      // required displacement is 1/LLTV - 1. So an attack needs P < LLTV,
      // independent of capital, liquidity and loop depth.
      const reach = morpho.displacementInsolvencyReachable({ truePrice: basePrice, lltv });
      assert.strictEqual(reach.reachable, false);
      assert.ok(reach.priceHeadroom > 0, `headroom ${reach.priceHeadroom}`);

      // Every live market sits on the safe side of that boundary. This is a fact
      // about the current set of markets, NOT a general property -- see
      // test/phase5/regime-boundary.js, where a 365d horizon at this same implied
      // rate crosses it with no credit event, and protection passes to the
      // curve's proportion cap instead.
      for (const s of scen.liveScenarios()) {
        if (!s.lltv) continue;
        const t = scen.scenarioBlockTime(s);
        if (s.market.expiry <= t) continue;
        const price = val.marketImpliedValue(s.market, t);
        const r = morpho.displacementInsolvencyReachable({ truePrice: price, lltv: s.lltv });
        assert.strictEqual(
          r.reachable,
          false,
          `${s.label}: PT at ${price} vs LLTV ${s.lltv} is inside the reachable regime`
        );
      }
    });
  });
});

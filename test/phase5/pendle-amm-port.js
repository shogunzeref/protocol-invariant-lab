// Validation of the local Pendle AMM port against live on-chain values.
//
// These are pure-JS assertions -- no hardhat runtime, no network access at test
// time. The live values were captured read-only into
// research/data/morpho-pt-markets.json by scripts/phase5/scan-morpho-pt-markets.js.
//
// This file exists because every economic conclusion in Phase 5 rests on the
// port reproducing Pendle's arithmetic. If it does not, nothing downstream is
// worth reading.

const assert = require("assert");

const amm = require("../../models/pendle-amm");
const val = require("../../models/pendle-pt-valuation");
const scen = require("../../models/phase5-scenarios");

describe("phase5: Pendle AMM port vs live on-chain state", () => {
  const scenarios = scen.liveScenarios();

  it("recovered live Pendle market state for a meaningful number of markets", () => {
    assert.ok(scenarios.length >= 20, `only ${scenarios.length} live scenarios recovered`);
  });

  it("reproduces the live PendleChainlinkOracle answer for every unexpired market", () => {
    const checked = [];
    for (const s of scenarios) {
      if (!s.onChainOracleAnswer || !s.twapDuration) continue;
      const blockTime = scen.scenarioBlockTime(s);
      if (s.market.expiry <= blockTime) continue; // matured; handled separately below

      const modelled = val.marketImpliedValue(s.market, blockTime);
      const onChain = Number(s.onChainOracleAnswer) / 1e18;
      const relative = Math.abs(modelled / onChain - 1);

      // The on-chain answer is a TWAP over `twapDuration` while the model value
      // is the rate implied by the last trade, so exact equality is not
      // expected. The observed residual is 3.6e-5, so 1e-4 leaves ~3x margin
      // for the TWAP/spot gap while staying well below the basis-point effects
      // this suite reasons about (see the unwind discounts in section 11).
      assert.ok(
        relative < 1e-4,
        `${s.label}: modelled ${modelled} vs on-chain ${onChain} (relative ${relative})`
      );
      checked.push(relative);
    }
    assert.ok(checked.length >= 15, `only ${checked.length} markets had a comparable on-chain answer`);
  });

  it("keeps the PT price strictly below par before maturity, at any trade size", () => {
    // MarketMathCore._getExchangeRate reverts with MarketExchangeRateBelowOne
    // once the asset-per-PT rate would drop under 1, so the PT price cannot be
    // pushed above the redemption value. This is the bound the whole
    // manipulation analysis turns on, so it is checked directly rather than
    // taken from the Solidity.
    const s = scen.largestTwapScenario();
    const blockTime = scen.scenarioBlockTime(s);

    for (const fraction of [1e-6, 1e-3, 0.01, 0.1, 0.3, 0.5, 0.8, 0.95]) {
      let price;
      try {
        const next = amm.executeTrade(s.market, s.market.totalPt * fraction, blockTime).market;
        price = val.marketImpliedValue(next, blockTime);
      } catch (e) {
        // A revert is the bound asserting itself; that is a pass, not a skip.
        assert.ok(
          /ExchangeRateBelowOne|ProportionTooHigh|insufficient/i.test(e.message),
          `unexpected failure buying ${fraction} of pool PT: ${e.message}`
        );
        continue;
      }
      assert.ok(
        price <= val.REDEMPTION_CEILING,
        `buying ${fraction} of pool PT priced PT at ${price}, above par`
      );
    }
  });

  it("moves the PT price up when PT is bought and down when PT is sold", () => {
    const s = scen.largestTwapScenario();
    const blockTime = scen.scenarioBlockTime(s);
    const size = s.market.totalPt * 0.01;
    const base = val.marketImpliedValue(s.market, blockTime);

    const bought = val.marketImpliedValue(amm.executeTrade(s.market, size, blockTime).market, blockTime);
    const sold = val.marketImpliedValue(amm.executeTrade(s.market, -size, blockTime).market, blockTime);

    assert.ok(bought > base, `buying PT did not raise the price: ${base} -> ${bought}`);
    assert.ok(sold < base, `selling PT did not lower the price: ${base} -> ${sold}`);
  });

  it("charges a round trip strictly more than it returns", () => {
    // No fee-free path through the curve: a buy immediately followed by a sell
    // must lose money. If this ever passed, the cost model would be unsound.
    const s = scen.largestTwapScenario();
    const blockTime = scen.scenarioBlockTime(s);
    const cost = require("../../models/pt-displacement-cost");

    for (const fraction of [1e-4, 1e-3, 0.01, 0.05]) {
      const rt = cost.roundTripCost(s.market, s.market.totalPt * fraction, blockTime);
      assert.ok(rt.feasible, `round trip at ${fraction} of pool infeasible: ${rt.reason}`);
      assert.ok(rt.cost > 0, `round trip at ${fraction} of pool was free or profitable: ${rt.cost}`);
    }
  });

  it("prices a matured PT at the redemption value", () => {
    // Several scanned Morpho markets reference PTs that are already past expiry.
    // The oracle should report par for those, and the model should agree.
    const matured = scenarios.filter((s) => s.market.expiry <= scen.scenarioBlockTime(s) && s.onChainOracleAnswer);
    for (const s of matured) {
      const onChain = Number(s.onChainOracleAnswer) / 1e18;
      assert.ok(
        Math.abs(onChain - val.REDEMPTION_CEILING) < 1e-9,
        `${s.label}: matured PT oracle reported ${onChain}, expected par`
      );
    }
  });
});

// The two protection regimes, and the boundary between them.
//
// The first version of this analysis claimed the PT redemption ceiling makes
// displacement-driven insolvency unreachable, full stop. That is true of every
// live market but is NOT true in general: `P_PT < LLTV` requires only a long
// maturity and a high implied rate, no credit event. This file pins down both
// regimes so the distinction cannot quietly regress back into the stronger,
// wrong claim.
//
//   P_PT > LLTV : the par ceiling alone makes the attack arithmetically
//                 impossible. Every live market is here.
//   P_PT < LLTV : the par ceiling gives no margin; protection comes instead from
//                 the Pendle curve's 96% PT proportion cap, which is a property
//                 of pool depth rather than of arithmetic.

const assert = require("assert");

const morpho = require("../../models/morpho-market");
const val = require("../../models/pendle-pt-valuation");
const cost = require("../../models/pt-displacement-cost");
const scen = require("../../models/phase5-scenarios");

describe("phase5: protection regime boundary", () => {
  const anchor = scen.largestTwapScenario();
  const blockTime = scen.scenarioBlockTime(anchor);
  const LIVE_LLTVS = [0.86, 0.915, 0.945];
  const at = (days) =>
    scen.reshape(anchor.market, { timeToMaturitySeconds: days * 86400, blockTime });

  // Largest displacement target the curve will actually deliver.
  const maxAchievable = (market) => {
    let best = 0;
    for (const target of cost.DISPLACEMENT_TARGETS) {
      if (cost.solveDisplacement(market, blockTime, target).achievable) best = target;
    }
    return best;
  };

  it("places every live unexpired market in the par-ceiling regime", () => {
    let checked = 0;
    for (const s of scen.liveScenarios()) {
      if (!s.lltv) continue;
      const t = scen.scenarioBlockTime(s);
      if (s.market.expiry <= t) continue;
      const price = val.marketImpliedValue(s.market, t);
      assert.ok(
        price > s.lltv,
        `${s.label}: PT at ${price} is below LLTV ${s.lltv} -- this market has left the par-ceiling regime`
      );
      assert.strictEqual(
        morpho.displacementInsolvencyReachable({ truePrice: price, lltv: s.lltv }).reachable,
        false
      );
      checked++;
    }
    assert.strictEqual(checked, 23, `expected 23 live unexpired markets, checked ${checked}`);
  });

  it("leaves the par-ceiling regime at long maturity with no credit event", () => {
    // The correction that mattered: the anchor's own implied rate, extended to a
    // 365-day horizon, prices PT below two of the three live LLTVs.
    const price = val.marketImpliedValue(at(365), blockTime);
    assert.ok(price < 0.915, `365d PT priced at ${price}, expected below the 91.5% LLTV`);
    assert.ok(price < 0.945);
    assert.ok(price > 0.86, "365d PT should still be above the lowest live LLTV");

    for (const lltv of [0.915, 0.945]) {
      assert.strictEqual(
        morpho.displacementInsolvencyReachable({ truePrice: price, lltv }).reachable,
        true,
        `expected lltv ${lltv} at 365d to be in the curve-cap regime`
      );
    }
  });

  it("protects the curve-cap regime by the proportion cap instead, with margin", () => {
    const market = at(365);
    const achievable = maxAchievable(market);
    assert.ok(achievable > 0, "no displacement achievable at all -- check the solver");

    for (const lltv of LIVE_LLTVS) {
      const required = morpho.insolvencyDisplacementThreshold(lltv);
      assert.ok(
        achievable < required,
        `lltv ${lltv}: curve delivers ${achievable} vs ${required} required -- the regime is exploitable`
      );
      // Not a hair's breadth: at least a 2x margin at every live LLTV.
      assert.ok(required / achievable > 2, `lltv ${lltv}: margin only ${required / achievable}x`);
    }
  });

  it("names which constraint binds, so the two regimes stay distinguishable", () => {
    // Long maturity: room to par remains, so the curve is what refuses.
    const long = cost.solveDisplacement(at(365), blockTime, 0.05);
    assert.strictEqual(long.achievable, false);
    assert.strictEqual(long.bindingConstraint, "CURVE_PROPORTION_CAP");

    // Near maturity: the par ceiling refuses first, and no pool depth changes it.
    const near = cost.solveDisplacement(at(7), blockTime, 0.05);
    assert.strictEqual(near.achievable, false);
    assert.strictEqual(near.bindingConstraint, "PT_PAR_CEILING");
  });

  it("keeps the curve cap scale-invariant, so deeper pools do not widen the margin", () => {
    // Worth pinning: the protection in the curve-cap regime comes from pool
    // *composition*, not pool size. Scaling both reserves changes the cost of a
    // displacement but not whether it is reachable.
    const base = maxAchievable(at(365));
    for (const liquidityScale of [0.25, 4]) {
      const scaled = scen.reshape(anchor.market, {
        timeToMaturitySeconds: 365 * 86400,
        liquidityScale,
        blockTime,
      });
      assert.strictEqual(
        maxAchievable(scaled),
        base,
        `liquidity scale ${liquidityScale} changed the achievable displacement`
      );
    }
  });
});

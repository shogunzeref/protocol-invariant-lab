// Cost of displacing a live Pendle PT price, and how much of that displacement
// a Morpho oracle actually sees.

const assert = require("assert");

const cost = require("../../models/pt-displacement-cost");
const val = require("../../models/pendle-pt-valuation");
const scen = require("../../models/phase5-scenarios");

describe("phase5: PT/SY displacement cost", () => {
  const anchor = scen.largestTwapScenario();
  const blockTime = scen.scenarioBlockTime(anchor);
  const at = (days, liquidityScale = 1) =>
    scen.reshape(anchor.market, { timeToMaturitySeconds: days * 86400, liquidityScale, blockTime });

  it("evaluates every displacement target the brief requires", () => {
    assert.deepStrictEqual(cost.DISPLACEMENT_TARGETS, [0.005, 0.01, 0.02, 0.03, 0.05, 0.1, 0.2]);
    assert.deepStrictEqual(cost.MATURITY_HORIZONS_DAYS, [365, 180, 90, 30, 14, 7, 1]);
  });

  it("reports the par ceiling as the binding constraint near maturity", () => {
    // The available upward displacement is 1/P - 1, and P -> 1 as T -> 0. So
    // near maturity even a 0.5% target is not merely expensive, it is
    // arithmetically impossible.
    const near = cost.solveDisplacement(at(7), blockTime, 0.005);
    assert.strictEqual(near.achievable, false);
    assert.strictEqual(near.bindingConstraint, "PT_PAR_CEILING");
    assert.ok(near.maxUpwardDisplacement < 0.005);
    assert.strictEqual(near.cost, null);

    const oneDay = cost.solveDisplacement(at(1), blockTime, 0.005);
    assert.strictEqual(oneDay.bindingConstraint, "PT_PAR_CEILING");
    assert.ok(
      oneDay.maxUpwardDisplacement < near.maxUpwardDisplacement,
      "headroom should keep shrinking toward maturity"
    );
  });

  it("shrinks the available displacement monotonically toward maturity", () => {
    let previous = Infinity;
    for (const days of cost.MATURITY_HORIZONS_DAYS) {
      const market = at(days);
      const available = 1 / val.marketImpliedValue(market, blockTime) - 1;
      assert.ok(available < previous, `${days}d: headroom ${available} did not shrink from ${previous}`);
      previous = available;
    }
    assert.ok(previous < 0.001, `1d headroom ${previous} unexpectedly large`);
  });

  it("charges a strictly positive, increasing cost for larger achievable displacements", () => {
    const market = at(365);
    let previousCost = 0;
    let achieved = 0;
    for (const target of cost.DISPLACEMENT_TARGETS) {
      const r = cost.solveDisplacement(market, blockTime, target);
      if (!r.achievable) continue;
      achieved++;
      assert.ok(r.cost > previousCost, `target ${target}: cost ${r.cost} not above ${previousCost}`);
      assert.ok(r.capitalRequired > r.cost, `target ${target}: cost exceeded capital deployed`);
      assert.ok(r.achievedFraction >= target * 0.999, `target ${target}: only reached ${r.achievedFraction}`);
      previousCost = r.cost;
    }
    assert.ok(achieved >= 2, "expected at least two achievable targets at a 365d horizon");
  });

  it("requires a large share of the pool's PT even for a 0.5% move", () => {
    // The economically relevant statement is not the dollar cost but the share
    // of the pool an attacker must take down, because that share is what
    // arbitrageurs and the proportion cap react to.
    const r = cost.solveDisplacement(at(365), blockTime, 0.005);
    assert.ok(r.achievable);
    assert.ok(r.ptFractionOfPool > 0.05, `0.5% move needed only ${r.ptFractionOfPool} of the pool`);
  });

  it("makes displacement more expensive as liquidity deepens", () => {
    const target = 0.005;
    const shallow = cost.solveDisplacement(at(365, 0.25), blockTime, target);
    const deep = cost.solveDisplacement(at(365, 4), blockTime, target);
    assert.ok(shallow.achievable && deep.achievable);
    assert.ok(deep.cost > shallow.cost, `deep ${deep.cost} not costlier than shallow ${shallow.cost}`);
    // Depth changes the absolute cost but not the fraction of the pool needed:
    // the curve is scale-invariant in the reserves.
    assert.ok(Math.abs(deep.ptFractionOfPool - shallow.ptFractionOfPool) < 1e-6);
  });

  it("transmits only the held fraction of the TWAP window into the oracle", () => {
    const displaced = cost.solveDisplacement(at(365), blockTime, 0.005);
    assert.ok(displaced.achievable);

    const oneBlock = cost.oracleDisplacement({
      oracle: { kind: "PendleChainlinkOracle", twapDuration: 900 },
      marketDisplacement: displaced,
      heldSeconds: 12,
      market: at(365),
      blockTime,
    });
    const fullWindow = cost.oracleDisplacement({
      oracle: { kind: "PendleChainlinkOracle", twapDuration: 900 },
      marketDisplacement: displaced,
      heldSeconds: 900,
      market: at(365),
      blockTime,
    });

    assert.ok(oneBlock.transmissionFactor < 0.02, `single block transmitted ${oneBlock.transmissionFactor}`);
    assert.ok(Math.abs(fullWindow.transmissionFactor - 1) < 1e-9);
    assert.ok(fullWindow.transmitted > oneBlock.transmitted * 50);
  });

  it("transmits nothing at all through a linear-discount oracle", () => {
    const displaced = cost.solveDisplacement(at(365), blockTime, 0.005);
    const out = cost.oracleDisplacement({
      oracle: { kind: "PendleSparkLinearDiscountOracle", baseDiscountPerYear: 0.2 },
      marketDisplacement: displaced,
      heldSeconds: 86400,
      market: at(365),
      blockTime,
    });
    assert.strictEqual(out.transmitted, 0);
    assert.strictEqual(out.transmissionFactor, 0);
  });

  it("produces a fully populated C(dP, T, L) surface", () => {
    const surface = cost.costSurface({
      makeMarketAt: (T, scale) =>
        scen.reshape(anchor.market, { timeToMaturitySeconds: T, liquidityScale: scale, blockTime }),
      blockTime,
      horizonsDays: [365, 90, 7],
      liquidityScales: [1, 4],
      targets: [0.005, 0.05],
    });

    assert.strictEqual(surface.length, 3 * 2 * 2);
    for (const row of surface) {
      assert.ok(typeof row.timeToMaturityDays === "number");
      assert.ok(typeof row.liquidityScale === "number");
      assert.ok(typeof row.achievable === "boolean");
      // Unachievable rows must say which constraint bound, so no row is silently
      // ambiguous.
      if (!row.achievable) assert.ok(row.bindingConstraint, "unachievable row lacked a binding constraint");
    }
  });
});

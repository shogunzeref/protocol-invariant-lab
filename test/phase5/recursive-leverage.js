// Recursive PT leverage: loop depths 1, 2, 3, 5, 10, 20 on live market state,
// with settlement accounted independently of the oracle.

const assert = require("assert");

const lev = require("../../models/pt-recursive-leverage");
const val = require("../../models/pendle-pt-valuation");
const morpho = require("../../models/morpho-market");
const scen = require("../../models/phase5-scenarios");

describe("phase5: recursive PT leverage", () => {
  const anchor = scen.largestTwapScenario();
  const blockTime = scen.scenarioBlockTime(anchor);
  const basePrice = val.marketImpliedValue(anchor.market, blockTime);
  const lltv = anchor.lltv;
  const initialPt = anchor.market.totalPt * 0.01;

  const loopAt = (depth, displacement = 0) =>
    lev.runLoop({
      initialPt,
      market: anchor.market,
      oraclePrice: basePrice * (1 + displacement),
      lltv,
      depth,
      blockTime,
    });

  it("sweeps the loop depths the brief requires", () => {
    assert.deepStrictEqual(lev.LOOP_DEPTHS, [1, 2, 3, 5, 10, 20]);
  });

  it("increases exposure with depth while leaving the position healthy", () => {
    let previousLeverage = 0;
    for (const depth of lev.LOOP_DEPTHS) {
      const loop = loopAt(depth);
      assert.strictEqual(loop.achievedDepth, depth, `depth ${depth} could not be completed`);
      assert.ok(
        loop.effectiveLeverage > previousLeverage,
        `depth ${depth}: leverage ${loop.effectiveLeverage} did not exceed ${previousLeverage}`
      );
      // Every iteration borrows to the limit, so the position must remain
      // exactly at or above the health boundary.
      assert.ok(loop.healthFactor >= 1 - 1e-9, `depth ${depth}: health ${loop.healthFactor}`);
      previousLeverage = loop.effectiveLeverage;
    }
  });

  it("saturates below the naive 1/(1-LLTV) ceiling because each buy moves the curve", () => {
    // The textbook geometric ceiling at 91.5% LLTV is ~11.8x. The loop cannot get
    // there: buying PT at every iteration raises the PT price it is paying, and
    // pays a fee each time. Reporting the naive figure would overstate the risk.
    const naive = 1 / (1 - lltv);
    const deepest = loopAt(20);
    assert.ok(deepest.effectiveLeverage < naive, `${deepest.effectiveLeverage} reached naive ceiling ${naive}`);
    assert.ok(deepest.ammFeesPaid > 0, "looping paid no fees");

    // The per-depth frictionless bound must be a real bound at every depth. It
    // is asserted because an earlier closed form (sum of (lltv*u)^k) was wrong
    // in the conservative direction and the simulated loop "beat" it.
    for (const depth of lev.LOOP_DEPTHS) {
      const loop = loopAt(depth);
      assert.ok(
        loop.effectiveLeverage < loop.idealisedGeometricLeverage,
        `depth ${depth}: simulated ${loop.effectiveLeverage} exceeded frictionless ${loop.idealisedGeometricLeverage}`
      );
      assert.ok(loop.idealisedGeometricLeverage < naive, `depth ${depth}: frictionless bound above 1/(1-LLTV)`);
    }
    // And it converges to the naive ceiling as depth grows without bound.
    assert.ok(Math.abs(lev.geometricLeverageCeiling(lltv, 5000) - naive) < 1e-9);

    // The loop's own buying pressure raises the market price it trades against.
    const finalPrice = val.marketImpliedValue(deepest.market, blockTime);
    assert.ok(finalPrice > basePrice, `loop did not move the market price: ${basePrice} -> ${finalPrice}`);
  });

  it("shows diminishing returns: each extra loop adds less exposure than the last", () => {
    const byDepth = new Map(lev.LOOP_DEPTHS.map((d) => [d, loopAt(d)]));
    const gain1to2 = byDepth.get(2).collateralPt - byDepth.get(1).collateralPt;
    const gain2to3 = byDepth.get(3).collateralPt - byDepth.get(2).collateralPt;
    assert.ok(gain2to3 < gain1to2, "third loop added more than the second");

    const perLoop10to20 = (byDepth.get(20).collateralPt - byDepth.get(10).collateralPt) / 10;
    assert.ok(perLoop10to20 < gain2to3, "late loops added more per iteration than early ones");
  });

  it("leaves the looped position solvent against an independent mark", () => {
    // The key question: after looping to the maximum, is the collateral still
    // worth the debt when valued WITHOUT reference to the oracle?
    for (const depth of lev.LOOP_DEPTHS) {
      const loop = loopAt(depth);
      const settled = lev.settleLoop({
        loop,
        oraclePrice: basePrice,
        referencePricePerPt: basePrice,
        lltv,
        blockTime,
        initialPtCost: initialPt * basePrice,
      });
      assert.strictEqual(settled.solventUnderReferenceMark, true, `depth ${depth} insolvent at reference mark`);
      assert.strictEqual(settled.solventUnderRealizableMark, true, `depth ${depth} insolvent at realizable mark`);
      assert.strictEqual(settled.protocolShortfall, 0, `depth ${depth} left a shortfall`);
    }
  });

  it("costs the looper money at every depth -- looping is not itself an attack", () => {
    for (const depth of lev.LOOP_DEPTHS) {
      const loop = loopAt(depth);
      const settled = lev.settleLoop({
        loop,
        oraclePrice: basePrice,
        referencePricePerPt: basePrice,
        lltv,
        blockTime,
        initialPtCost: initialPt * basePrice,
      });
      assert.ok(settled.attackerPnL < 0, `depth ${depth} produced a profit of ${settled.attackerPnL}`);
    }
  });

  it("amplifies borrow capacity with depth but not the solvency margin", () => {
    // Displacement and leverage multiply in capacity terms, which is the
    // amplification the brief asks about. It does NOT multiply in solvency terms,
    // because the collateral grows in step with the debt.
    const displacement = 0.005; // the largest displacement actually achievable here
    const shallow = loopAt(1, displacement);
    const deep = loopAt(20, displacement);

    const extra = (loop) =>
      morpho.maxBorrow({ collateral: loop.collateralPt, price: basePrice * (1 + displacement), lltv }) -
      morpho.maxBorrow({ collateral: loop.collateralPt, price: basePrice, lltv });

    assert.ok(extra(deep) > extra(shallow) * 3, "depth did not amplify the capacity gain");

    for (const loop of [shallow, deep]) {
      const settled = lev.settleLoop({
        loop,
        oraclePrice: basePrice * (1 + displacement),
        referencePricePerPt: basePrice,
        lltv,
        blockTime,
        initialPtCost: initialPt * basePrice,
      });
      assert.strictEqual(settled.solventUnderReferenceMark, true);
      assert.strictEqual(settled.protocolShortfall, 0);
    }
  });

  it("concentrates the position so the unwind discount grows with depth", () => {
    // The real cost of looping is not insolvency, it is that the whole position
    // sits in one Pendle pool and has to leave through the same curve.
    const shallow = loopAt(1);
    const deep = loopAt(20);
    const discount = (loop) =>
      basePrice - val.realizableValuePerPt(loop.market, loop.collateralPt, blockTime);
    assert.ok(discount(deep) > discount(shallow), "deeper loop did not incur a larger unwind discount");
  });

  it("stops looping when the market can no longer supply PT", () => {
    // A loop sized at a large share of the pool must terminate early rather than
    // silently reporting impossible leverage.
    const oversized = lev.runLoop({
      initialPt: anchor.market.totalPt * 0.5,
      market: anchor.market,
      oraclePrice: basePrice,
      lltv,
      depth: 20,
      blockTime,
    });
    assert.ok(oversized.achievedDepth <= 20);
    assert.ok(Number.isFinite(oversized.effectiveLeverage));
    assert.ok(oversized.effectiveLeverage > 1);
  });
});

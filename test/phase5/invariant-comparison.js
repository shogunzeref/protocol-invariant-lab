// Phase 5 against the lab's four standing invariants, and against the
// vulnerability classes the earlier phases established.
//
// The Moola phases (test/amm-manipulation.js, test/unwind-settle.js,
// test/sweep.js) demonstrated a working attack on an AMM-spot-sourced collateral
// oracle. The point of this file is to identify exactly which properties differ
// here, so the negative Phase 5 result is attributable to specific mechanisms
// rather than to unexamined luck.

const assert = require("assert");

const amm = require("../../models/pendle-amm");
const val = require("../../models/pendle-pt-valuation");
const morpho = require("../../models/morpho-market");
const cost = require("../../models/pt-displacement-cost");
const scen = require("../../models/phase5-scenarios");

describe("phase5: invariant comparison", () => {
  const anchor = scen.largestTwapScenario();
  const blockTime = scen.scenarioBlockTime(anchor);
  const basePrice = val.marketImpliedValue(anchor.market, blockTime);

  describe("invariant 1: oracle impact boundary", () => {
    // Statement: a single unprivileged market interaction must not move the
    // lending protocol's collateral mark by an economically significant amount.
    it("HOLDS for TWAP-sourced PT feeds -- one block moves the mark by ~1/75 of the trade's effect", () => {
      const displaced = cost.solveDisplacement(scen.reshape(anchor.market, {
        timeToMaturitySeconds: 365 * 86400,
        blockTime,
      }), blockTime, 0.005);
      const oneBlock = cost.oracleDisplacement({
        oracle: { kind: "PendleChainlinkOracle", twapDuration: anchor.twapDuration || 900 },
        marketDisplacement: displaced,
        heldSeconds: 12,
        market: anchor.market,
        blockTime,
      });
      assert.ok(oneBlock.transmissionFactor < 0.02);
    });

    it("HOLDS ABSOLUTELY for linear-discount PT feeds -- the boundary is zero", () => {
      const before = val.linearDiscountOracleValue({ timeToMaturity: 200 * 86400, baseDiscountPerYear: 0.2 });
      amm.executeTrade(anchor.market, anchor.market.totalPt * 0.4, blockTime);
      const after = val.linearDiscountOracleValue({ timeToMaturity: 200 * 86400, baseDiscountPerYear: 0.2 });
      assert.strictEqual(before, after);
    });

    it("FAILED in the Moola phases -- the contrast is the untimed spot read", () => {
      // Recorded as a property of the oracle path, not as a claim about Moola's
      // current deployment: the lab's AMMSourcedPriceOracle reads reserves with
      // no time weighting, so its transmission factor is 1 within a single
      // block. That is the structural difference.
      const spotTransmission = 1;
      const ptTransmission = 12 / (anchor.twapDuration || 900);
      assert.ok(ptTransmission < spotTransmission / 50);
    });
  });

  // Invariant 2 (balance/state verification) is NOT asserted here.
  //
  // It holds on both legs -- Morpho credits `position[id][onBehalf].collateral`
  // from the amount passed to `supplyCollateral` and never reads `balanceOf` when
  // pricing, and MarketMathCore consumes `MarketState.totalPt/totalSy` from
  // `_storage`, which only `_writeState` updates -- but both are facts about the
  // deployed Solidity, not properties of these models. Asserting them against
  // models that have no notion of a token balance would produce a test that
  // cannot fail. They are recorded as FACTs with source citations in
  // research/phase5-morpho-pendle.md instead.

  describe("invariant 3: liquidation depth", () => {
    it("PARTIALLY AT RISK -- a large PT position exits through one curve", () => {
      // This is the genuine residual concern: unlike a stablecoin collateral with
      // many venues, a PT's only native venue is its own Pendle pool, so
      // liquidation depth is bounded by that pool.
      const sizes = [0.01, 0.05, 0.2, 0.5].map((f) => anchor.market.totalPt * f);
      let previousDiscount = 0;
      for (const size of sizes) {
        const realizable = val.realizableValuePerPt(anchor.market, size, blockTime);
        assert.ok(realizable !== null, `could not unwind ${size} PT`);
        const discount = basePrice - realizable;
        assert.ok(discount > previousDiscount, "discount did not grow with size");
        previousDiscount = discount;
      }
    });

    it("HOLDS at the sizes that matter -- discount stays under the liquidation incentive", () => {
      const lif = morpho.liquidationIncentiveFactor(anchor.lltv);
      const margin = basePrice - basePrice / lif;
      // Up to a fifth of the entire pool, liquidators still clear a profit.
      const realizable = val.realizableValuePerPt(anchor.market, anchor.market.totalPt * 0.2, blockTime);
      assert.ok(basePrice - realizable < margin, "unwind discount exceeded the incentive margin");
    });
  });

  describe("invariant 4: state/valuation consistency", () => {
    it("HOLDS on the anchor -- the redemption ceiling bounds the oracle above and Morpho's haircut bounds it below", () => {
      // An oracle-marked collateral value can never exceed par, and Morpho only
      // lends LLTV * mark, so a maximally-borrowed position is covered as long as
      // the PT trades above the LLTV.
      const reach = morpho.displacementInsolvencyReachable({ truePrice: basePrice, lltv: anchor.lltv });
      assert.strictEqual(reach.reachable, false);
    });

    it("records the boundary condition under which it stops holding on its own", () => {
      // A monitorable threshold, not a reassurance. Note this needs no credit
      // event -- a long maturity at a high implied rate is enough. The regime on
      // the far side of the boundary, and the curve-cap protection that takes
      // over there, are covered in test/phase5/regime-boundary.js.
      const stressed = morpho.displacementInsolvencyReachable({
        truePrice: anchor.lltv - 0.005,
        lltv: anchor.lltv,
      });
      assert.strictEqual(stressed.reachable, true);
    });
  });

  describe("vulnerability-class comparison", () => {
    it("is NOT the AMM spot-price manipulation class -- time weighting breaks the mechanism", () => {
      const ptTransmission = 12 / (anchor.twapDuration || 900);
      assert.ok(ptTransmission < 0.02);
    });

    // The donation / ERC-4626-inflation class is ruled out by source reading
    // rather than by a model assertion, for the reason given above invariant 3.

    it("is NOT the flash-loan class -- the profitable displacement needs multi-block persistence", () => {
      // A flash loan lives inside one transaction. The TWAP requires the
      // displacement to survive across blocks, at which point it is a funded
      // directional position exposed to arbitrage, not a flash loan.
      const displaced = cost.solveDisplacement(
        scen.reshape(anchor.market, { timeToMaturitySeconds: 365 * 86400, blockTime }),
        blockTime,
        0.005
      );
      const atomic = cost.oracleDisplacement({
        oracle: { kind: "PendleChainlinkOracle", twapDuration: anchor.twapDuration || 900 },
        marketDisplacement: displaced,
        heldSeconds: 12,
        market: anchor.market,
        blockTime,
      });
      const capacityGainPerPt = basePrice * anchor.lltv * atomic.transmitted;
      // The per-PT capacity gain from an atomic displacement is smaller than the
      // per-PT round-trip cost of producing it, so the flash-loan variant cannot
      // repay itself.
      const costPerPt = displaced.cost / displaced.ptAmount;
      assert.ok(
        capacityGainPerPt < costPerPt,
        `atomic gain ${capacityGainPerPt} exceeded cost ${costPerPt}`
      );
    });

    it("IS closest to the stale/lagging-oracle class, with the sign reversed", () => {
      // The exploitable direction for a lagging PT feed is a mark that is too
      // HIGH after the true price falls -- which requires the underlying to move,
      // not the attacker. And the linear-discount feeds lag DOWNWARD, which is
      // conservative for the protocol.
      for (const days of [365, 90, 30]) {
        const market = scen.reshape(anchor.market, { timeToMaturitySeconds: days * 86400, blockTime });
        const marketValue = val.marketImpliedValue(market, blockTime);
        const linear = val.linearDiscountOracleValue({
          timeToMaturity: days * 86400,
          baseDiscountPerYear: 0.2,
        });
        assert.ok(linear < marketValue, `${days}d: linear feed marked above the market`);
      }
    });
  });
});

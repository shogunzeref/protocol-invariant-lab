// Morpho Blue collateral accounting, checked against the semantics in
// morpho-blue/src/Morpho.sol and libraries/MathLib.sol rather than against a
// generic LTV formula.

const assert = require("assert");
const morpho = require("../../models/morpho-market");

const LIVE_LLTVS = [0.86, 0.915, 0.945]; // observed on live PT markets

describe("phase5: Morpho Blue collateral propagation", () => {
  it("scales the 1e36 oracle price by the decimals differential", () => {
    // IOracle.price() quotes collateral in loan token scaled by 1e36 *and*
    // absorbs the token decimals differential. A 6-decimal PT against an
    // 18-decimal loan token is the case where getting this wrong is a 1e12
    // error, so it is pinned explicitly.
    const scaled = morpho.toScaledPrice(0.97, 6, 18);
    assert.strictEqual(scaled, 0.97 * 1e36 * 1e12);
    assert.ok(Math.abs(morpho.fromScaledPrice(scaled, 6, 18) - 0.97) < 1e-12);

    // Equal decimals must be a plain 1e36 scaling.
    assert.strictEqual(morpho.toScaledPrice(0.97, 18, 18), 0.97 * 1e36);
  });

  it("makes borrow capacity exactly linear in the oracle price -- no cap or damping", () => {
    // Morpho applies `collateral * price / 1e36 * lltv` with nothing between the
    // oracle and the capacity. Any displacement therefore transmits at
    // elasticity 1, which is the single most important propagation fact.
    for (const lltv of LIVE_LLTVS) {
      const base = morpho.maxBorrow({ collateral: 1e6, price: 0.95, lltv });
      for (const d of [0.005, 0.01, 0.05, 0.2]) {
        const moved = morpho.maxBorrow({ collateral: 1e6, price: 0.95 * (1 + d), lltv });
        const elasticity = (moved / base - 1) / d;
        assert.ok(Math.abs(elasticity - 1) < 1e-9, `lltv ${lltv}, d ${d}: elasticity ${elasticity}`);
      }
    }
  });

  it("reproduces the bounded liquidation incentive factor", () => {
    // LIF = min(1.15, 1 / (1 - 0.3 * (1 - lltv))).
    for (const lltv of LIVE_LLTVS) {
      const expected = Math.min(1.15, 1 / (1 - 0.3 * (1 - lltv)));
      assert.ok(Math.abs(morpho.liquidationIncentiveFactor(lltv) - expected) < 1e-12);
    }
    // The cap binds only at very low LLTVs; at PT-market LLTVs the incentive is
    // small, which is why liquidators are so sensitive to oracle error here.
    assert.ok(morpho.liquidationIncentiveFactor(0.945) < 1.02);
    assert.strictEqual(morpho.liquidationIncentiveFactor(0.1), 1.15);
  });

  it("treats the LLTV haircut as the deductible an attacker must exceed", () => {
    // Insolvency needs (1 + d) * lltv > 1. Verified against the position
    // arithmetic rather than trusting the closed form.
    for (const lltv of LIVE_LLTVS) {
      const threshold = morpho.insolvencyDisplacementThreshold(lltv);
      const truePrice = 0.95;
      const collateral = 1e6;

      for (const [d, expectInsolvent] of [
        [threshold * 0.9, false],
        [threshold * 1.1, true],
      ]) {
        const debt = morpho.maxBorrow({ collateral, price: truePrice * (1 + d), lltv });
        const independentValue = collateral * truePrice;
        assert.strictEqual(
          debt > independentValue,
          expectInsolvent,
          `lltv ${lltv}, d ${d}: debt ${debt} vs independent value ${independentValue}`
        );
      }
    }
  });

  it("finds displacement-driven insolvency unreachable while the PT trades above the LLTV", () => {
    // With the PT price capped at par, available displacement is 1/P - 1 and
    // required displacement is 1/lltv - 1, so reachability reduces to P < lltv.
    for (const lltv of LIVE_LLTVS) {
      const above = morpho.displacementInsolvencyReachable({ truePrice: lltv + 0.01, lltv });
      assert.strictEqual(above.reachable, false);
      assert.ok(above.priceHeadroom > 0);

      const below = morpho.displacementInsolvencyReachable({ truePrice: lltv - 0.01, lltv });
      assert.strictEqual(below.reachable, true);
      assert.ok(below.priceHeadroom < 0);
    }
  });

  it("declines liquidation once the oracle over-marks by more than the incentive", () => {
    const lltv = 0.915;
    const realizable = 0.95;
    const lif = morpho.liquidationIncentiveFactor(lltv);

    // A liquidator pays oraclePrice / LIF per unit seized. Break-even is at
    // oraclePrice = realizable * LIF.
    const breakEven = realizable * lif;
    const belowBreakEven = morpho.liquidationOutcome({
      collateral: 1e6,
      debt: 9e5,
      oraclePrice: breakEven * 0.99,
      realizablePricePerUnit: realizable,
      lltv,
    });
    const aboveBreakEven = morpho.liquidationOutcome({
      collateral: 1e6,
      debt: 9e5,
      oraclePrice: breakEven * 1.01,
      realizablePricePerUnit: realizable,
      lltv,
    });

    assert.strictEqual(belowBreakEven.liquidationProfitable, true);
    assert.strictEqual(belowBreakEven.protocolShortfall, 0);
    assert.strictEqual(aboveBreakEven.liquidationProfitable, false);
    assert.ok(aboveBreakEven.protocolShortfall > 0);
  });

  it("recovers the debt whenever the collateral is independently worth it", () => {
    // At an undisplaced oracle the position is always cleared, so a displacement
    // that ends leaves no lasting shortfall as long as the collateral covers the
    // debt at its realizable price.
    const lltv = 0.915;
    const out = morpho.liquidationOutcome({
      collateral: 1e6,
      debt: 8.5e5,
      oraclePrice: 0.95,
      realizablePricePerUnit: 0.95,
      lltv,
    });
    assert.strictEqual(out.liquidationProfitable, true);
    assert.strictEqual(out.protocolShortfall, 0);
    assert.ok(out.seized <= 1e6);
  });
});

// Recursive PT leverage ("PT looping") through a Morpho Blue market, and what
// an oracle displacement does to the resulting position.
//
// The loop being modelled:
//
//   supply PT as collateral
//     -> borrow loan asset up to the market's capacity
//     -> buy PT with the borrowed asset (through the Pendle AMM)
//     -> supply that PT
//     -> borrow again ... repeat
//
// The amplification is NOT taken from the textbook geometric series
// 1/(1 - LLTV). That formula assumes each round-trip preserves value, and here
// it does not: every loop iteration buys PT through the AMM and therefore pays
// the swap fee and moves the curve, and the oracle may mark the acquired PT at
// something other than what was paid for it. Both effects are carried through
// explicitly, and the realised leverage is measured from the simulated ledger.

const amm = require("./pendle-amm");
const val = require("./pendle-pt-valuation");
const morpho = require("./morpho-market");

/** Loop depths required by the Phase 5 brief. */
const LOOP_DEPTHS = [1, 2, 3, 5, 10, 20];

/**
 * Run the loop.
 *
 * @param initialPt      PT supplied from the attacker's own capital
 * @param market         Pendle market state (mutated only locally, via copies)
 * @param oraclePrice    what Morpho reads, loan-token per PT (may be displaced)
 * @param lltv           market LLTV as a fraction
 * @param depth          number of borrow->buy->supply iterations
 * @param blockTime      timestamp for maturity maths
 * @param borrowUtilisation fraction of remaining capacity used per iteration.
 *        1.0 borrows to exactly HF=1, which no real position does because it is
 *        instantly liquidatable; the default 0.98 leaves the usual thin buffer.
 * @param loanAssetPerAsset price of the loan token in Pendle-asset units.
 *        1.0 for the stablecoin PT markets observed live.
 */
function runLoop({
  initialPt,
  market,
  oraclePrice,
  lltv,
  depth,
  blockTime,
  borrowUtilisation = 0.98,
  loanAssetPerAsset = 1,
}) {
  let collateralPt = initialPt;
  let debt = 0;
  let currentMarket = market;
  let ammFeesPaid = 0;
  let assetSpentBuyingPt = 0;
  const iterations = [];

  for (let i = 0; i < depth; i++) {
    const capacity = morpho.maxBorrow({ collateral: collateralPt, price: oraclePrice, lltv });
    const headroom = capacity - debt;
    if (headroom <= 0) break;

    const borrow = headroom * borrowUtilisation;
    // Loan token -> Pendle accounting asset.
    const assetAvailable = borrow / loanAssetPerAsset;

    // Buy as much PT as `assetAvailable` affords. Bisect on PT size because
    // calcTrade maps PT -> asset, not the reverse.
    const ptBought = solvePtForAsset(currentMarket, assetAvailable, blockTime);
    if (ptBought === null || ptBought <= 0) break;

    const exec = amm.executeTrade(currentMarket, ptBought, blockTime);
    const assetPaid = -exec.trade.netAssetToAccount;

    currentMarket = exec.market;
    ammFeesPaid += exec.trade.netAssetFee;
    assetSpentBuyingPt += assetPaid;
    collateralPt += ptBought;
    debt += borrow;

    iterations.push({
      i: i + 1,
      borrowed: borrow,
      ptBought,
      assetPaid,
      effectivePricePaid: assetPaid / ptBought,
      collateralPt,
      debt,
      healthFactor: morpho.healthFactor({ collateral: collateralPt, price: oraclePrice, lltv, borrowed: debt }),
      // The loop is self-limiting: each purchase pushes the market PT price up,
      // so later iterations buy fewer PT per unit borrowed.
      marketPriceAfter: val.marketImpliedValue(currentMarket, blockTime),
    });
  }

  return {
    depth,
    achievedDepth: iterations.length,
    initialPt,
    collateralPt,
    debt,
    ammFeesPaid,
    assetSpentBuyingPt,
    // Measured, not assumed: PT exposure per unit of own capital.
    effectiveLeverage: collateralPt / initialPt,
    // Frictionless upper bound for this depth, reported so the cost of the real
    // curve (fees plus the loop's own price impact) is visible in the results.
    idealisedGeometricLeverage: geometricLeverageCeiling(lltv, depth, borrowUtilisation),
    oracleCollateralValue: collateralPt * oraclePrice,
    debtToOracleCollateral: debt / (collateralPt * oraclePrice),
    healthFactor: morpho.healthFactor({ collateral: collateralPt, price: oraclePrice, lltv, borrowed: debt }),
    market: currentMarket,
    iterations,
  };
}

/** Largest PT purchase whose asset cost does not exceed `assetBudget`. */
function solvePtForAsset(market, assetBudget, blockTime, maxIter = 120) {
  const cost = (pt) => {
    try {
      return -amm.calcTrade(market, amm.marketPreCompute(market, blockTime), pt).netAssetToAccount;
    } catch (e) {
      return null;
    }
  };

  let hi = assetBudget; // PT price <= 1 asset, so this always over-shoots.
  let c = cost(hi);
  for (let i = 0; i < 60 && (c === null || c < assetBudget); i++) {
    hi *= 2;
    c = cost(hi);
    if (hi > market.totalPt * 0.999) break;
  }
  if (c === null || c < assetBudget) {
    // Even the whole feasible range costs less than the budget: the pool cannot
    // absorb this much asset.
    let lo = 0;
    let probe = market.totalPt * 0.5;
    for (let i = 0; i < maxIter; i++) {
      const pc = cost(probe);
      if (pc === null) probe = (lo + probe) / 2;
      else {
        lo = probe;
        probe = (probe + market.totalPt) / 2;
      }
    }
    return lo > 0 ? lo : null;
  }

  let lo = 0;
  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2;
    const mc = cost(mid);
    if (mc === null || mc > assetBudget) hi = mid;
    else lo = mid;
    if ((hi - lo) / Math.max(hi, 1e-30) < 1e-12) break;
  }
  return lo;
}

/**
 * Frictionless leverage after `depth` iterations: what the loop would reach if
 * PT could be bought at the oracle price with no fee and no slippage. Reported
 * alongside the simulated result to quantify the cost of the real curve.
 *
 * NOT the textbook sum of (lltv*u)^k. Each iteration borrows `u` of the
 * *remaining* headroom `lltv*C - D`, and both C and D rise by that same amount,
 * so the headroom decays by q = 1 - u*(1 - lltv) per iteration rather than by
 * lltv*u. The sum of (lltv*u)^k understates the result badly enough that the
 * simulated loop appears to exceed it, which is how this was caught.
 *
 *   x_0 = lltv,  x_{k+1} = q * x_k,  C_n = 1 + u * x_0 * (1 - q^n)/(1 - q)
 *
 * As depth -> infinity this converges to 1/(1 - lltv) for any u > 0, which is
 * the naive ceiling; `u` changes only how fast it is approached.
 */
function geometricLeverageCeiling(lltv, depth, borrowUtilisation = 1) {
  const q = 1 - borrowUtilisation * (1 - lltv);
  if (q >= 1) return Infinity; // lltv >= 1: no haircut, no bound
  return 1 + (borrowUtilisation * lltv * (1 - q ** depth)) / (1 - q);
}

/**
 * Value the looped position with an INDEPENDENT mark and compute what happens
 * when it is liquidated.
 *
 * `referencePricePerPt` is the honest mark (bounded above by the redemption
 * ceiling of 1.0 asset/PT). `realizable` additionally charges the slippage of
 * actually unwinding the whole PT inventory through the pool -- which for a
 * looped position is large precisely because the loop itself concentrated the
 * position in one pool.
 */
function settleLoop({ loop, oraclePrice, referencePricePerPt, lltv, blockTime, initialPtCost }) {
  const realizablePerPt = val.realizableValuePerPt(loop.market, loop.collateralPt, blockTime);
  const realizable = realizablePerPt === null ? 0 : realizablePerPt;
  const oracleValue = loop.collateralPt * oraclePrice;
  const referenceValue = loop.collateralPt * referencePricePerPt;

  // Two liquidation scenarios, because they answer different questions and give
  // very different shortfalls.
  //
  //  (a) the oracle stays displaced. Liquidators must pay the inflated oracle
  //      value (less the incentive) for collateral they can only sell at the
  //      realizable value, so above a certain displacement they simply decline
  //      and the debt sits unrecovered.
  //  (b) the displacement ends and the oracle returns to the reference price --
  //      which is what actually happens, since holding an AMM displaced costs
  //      money every block. This is the scenario that determines whether the
  //      protocol takes a REAL loss.
  const atDisplacedOracle = morpho.liquidationOutcome({
    collateral: loop.collateralPt,
    debt: loop.debt,
    oraclePrice,
    realizablePricePerUnit: realizable,
    lltv,
  });
  const afterOracleReverts = morpho.liquidationOutcome({
    collateral: loop.collateralPt,
    debt: loop.debt,
    oraclePrice: referencePricePerPt,
    realizablePricePerUnit: realizable,
    lltv,
  });

  // Attacker accounting, computed entirely from independent marks -- the oracle
  // price appears nowhere in it.
  //
  // Best case for the attacker is to abandon the position: keep whatever
  // borrowed loan asset was not spent acquiring PT, and forfeit the collateral.
  // Any collateral liquidators decline to seize is still the attacker's, so it
  // is credited back at the realizable price.
  const attackerOwnCapital = initialPtCost ?? loop.initialPt * referencePricePerPt;
  const cashRetained = loop.debt - loop.assetSpentBuyingPt;
  const collateralRecovered = afterOracleReverts.collateralRemaining * realizable;
  const attackerPnL = cashRetained + collateralRecovered - attackerOwnCapital;

  return {
    oracleCollateralValue: oracleValue,
    referenceCollateralValue: referenceValue,
    realizableValuePerPt: realizablePerPt,
    realizableCollateralValue: loop.collateralPt * realizable,
    oracleOvervaluation: oracleValue - referenceValue,
    oracleOvervaluationVsRealizable: loop.collateralPt * (oraclePrice - realizable),
    // An oracle price above 1.0 asset/PT is above the redemption ceiling, so no
    // AMM-sourced displacement can produce it (MarketMathCore bounds the PT
    // price at par) and a min()-aggregated feed cannot report it either. Rows
    // flagged here are counterfactual and must not be read as reachable.
    oraclePriceExceedsRedemptionCeiling: oraclePrice > val.REDEMPTION_CEILING,
    debt: loop.debt,
    // Solvency measured against independent marks, never the oracle.
    solventUnderReferenceMark: referenceValue >= loop.debt,
    solventUnderRealizableMark: loop.collateralPt * realizable >= loop.debt,
    liquidation: atDisplacedOracle,
    liquidationAfterOracleReverts: afterOracleReverts,
    // Headline shortfall is the one that survives the displacement ending.
    protocolShortfall: afterOracleReverts.protocolShortfall,
    protocolShortfallWhileOracleDisplaced: atDisplacedOracle.protocolShortfall,
    attackerPnL,
    attackerOwnCapital,
    cashRetained,
  };
}

module.exports = {
  LOOP_DEPTHS,
  runLoop,
  solvePtForAsset,
  geometricLeverageCeiling,
  settleLoop,
};

// Economic cost of displacing a Pendle PT price, and of getting that
// displacement into a Morpho oracle.
//
// NON-DEPLOYABLE BY CONSTRUCTION. This file solves for numbers: how much asset
// must flow through a Pendle market to move its implied rate by a target
// amount, what that flow costs after fees and slippage, and how much of the
// resulting displacement survives the oracle's time-weighting. It contains no
// calldata, no transaction sequencing, no contract, and no signer. It cannot be
// executed against anything.
//
// Two separate quantities are computed and deliberately never conflated:
//
//   costToDisplaceMarket(dP)   -- cost of moving the AMM's own PT price by dP.
//   costToDisplaceOracle(dP)   -- cost of moving what MORPHO READS by dP,
//                                 which additionally requires (a) surviving the
//                                 TWAP dilution and (b) beating any min()
//                                 aggregation, and which for a linear-discount
//                                 feed is undefined at any price.

const amm = require("./pendle-amm");
const val = require("./pendle-pt-valuation");

/** Displacement targets required by the Phase 5 brief. */
const DISPLACEMENT_TARGETS = [0.005, 0.01, 0.02, 0.03, 0.05, 0.1, 0.2];

/** Maturity horizons required by the Phase 5 brief, in seconds. */
const MATURITY_HORIZONS_DAYS = [365, 180, 90, 30, 14, 7, 1];

/**
 * Round-trip cost of buying `ptAmount` PT out of the pool and immediately
 * selling it back, which is what an attacker who only wants a temporary price
 * displacement actually pays. Cost = fees + curve slippage, i.e. the asset the
 * pool keeps.
 *
 * Returns null if the trade is not feasible on the curve at all.
 */
function roundTripCost(market, ptAmount, blockTime) {
  try {
    const buy = amm.executeTrade(market, ptAmount, blockTime);
    const assetIn = -buy.trade.netAssetToAccount; // positive: paid by attacker
    const sell = amm.executeTrade(buy.market, -ptAmount, blockTime);
    const assetOut = sell.trade.netAssetToAccount; // positive: returned
    return {
      feasible: true,
      ptAmount,
      assetIn,
      assetOut,
      cost: assetIn - assetOut,
      capitalRequired: assetIn,
      displacedMarket: buy.market,
      feePaid: buy.trade.netAssetFee + sell.trade.netAssetFee,
      restoredMarket: sell.market,
    };
  } catch (e) {
    return { feasible: false, reason: e.message, ptAmount };
  }
}

/**
 * Minimum PT purchase that raises the market's PT/asset price by at least
 * `targetFraction` (relative). Buying PT pushes the implied rate DOWN, which
 * pushes the PT price UP -- that is the direction an attacker inflating
 * collateral needs.
 *
 * Solved by bisection on the AMM rather than by an inverted closed form,
 * because the re-anchoring step in getMarketPreCompute makes the price a
 * function of reserves and stored rate jointly.
 */
function solveDisplacement(market, blockTime, targetFraction, { maxIter = 200 } = {}) {
  const p0 = val.marketImpliedValue(market, blockTime);
  const target = p0 * (1 + targetFraction);

  // HARD STRUCTURAL BOUND, checked before spending any effort on the curve.
  //
  // MarketMathCore._getExchangeRate reverts with MarketExchangeRateBelowOne
  // whenever the asset-per-PT exchange rate would fall below 1. Since the PT
  // price is the reciprocal of that rate, the AMM cannot price a PT above 1.0
  // asset AT ANY COST. So the maximum upward displacement available on a Pendle
  // market is exactly 1/P0 - 1, which collapses to zero as the PT price
  // converges to par near maturity. No amount of capital buys past it.
  const maxUpwardDisplacement = 1 / p0 - 1;
  if (targetFraction > maxUpwardDisplacement) {
    return {
      target: targetFraction,
      achievable: false,
      bindingConstraint: "PT_PAR_CEILING",
      reason:
        `PT price is bounded above by 1.0 asset (MarketMathCore reverts with ` +
        `MarketExchangeRateBelowOne); max upward displacement here is ` +
        `${(maxUpwardDisplacement * 100).toFixed(4)}%`,
      basePrice: p0,
      maxUpwardDisplacement,
      cost: null,
      capitalRequired: null,
    };
  }

  const priceAfter = (ptAmount) => {
    try {
      const next = amm.executeTrade(market, ptAmount, blockTime).market;
      return val.marketImpliedValue(next, blockTime);
    } catch (e) {
      return null;
    }
  };

  // Bracket: grow until the target is reached or the curve refuses the size.
  // The pool cannot sell more than its PT reserve, and the 96% proportion cap
  // binds well before that.
  let hi = market.totalPt * 1e-6;
  let feasibleHi = null;
  for (let i = 0; i < 80; i++) {
    const p = priceAfter(hi);
    if (p === null) break;
    if (p >= target) {
      feasibleHi = hi;
      break;
    }
    hi *= 2;
    if (hi > market.totalPt * 0.999) break;
  }
  if (feasibleHi === null) {
    return {
      target: targetFraction,
      achievable: false,
      bindingConstraint: "CURVE_PROPORTION_CAP",
      reason:
        "target below the par ceiling but unreachable on this curve: the 96% PT " +
        "proportion cap (MarketProportionTooHigh) binds first",
      basePrice: p0,
      maxUpwardDisplacement,
      cost: null,
      capitalRequired: null,
    };
  }

  let lo = 0;
  hi = feasibleHi;
  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2;
    const p = priceAfter(mid);
    if (p !== null && p >= target) hi = mid;
    else lo = mid;
    if ((hi - lo) / Math.max(hi, 1e-30) < 1e-12) break;
  }

  const rt = roundTripCost(market, hi, blockTime);
  const achievedPrice = priceAfter(hi);
  return {
    target: targetFraction,
    achievable: true,
    bindingConstraint: null,
    maxUpwardDisplacement,
    basePrice: p0,
    targetPrice: target,
    achievedPrice,
    achievedFraction: achievedPrice / p0 - 1,
    ptAmount: hi,
    ptFractionOfPool: hi / market.totalPt,
    capitalRequired: rt.feasible ? rt.capitalRequired : null,
    // Round-trip cost is the honest cost of a TEMPORARY displacement. An
    // attacker who instead keeps the PT pays the (larger) mark-to-market loss
    // on an inflated inventory, which is bounded below by this number.
    cost: rt.feasible ? rt.cost : null,
    feePaid: rt.feasible ? rt.feePaid : null,
    costAsFractionOfCapital: rt.feasible ? rt.cost / rt.capitalRequired : null,
    displacedLnImpliedRate: amm.executeTrade(market, hi, blockTime).market.lastLnImpliedRate,
  };
}

/**
 * Cost surface C(dP, T, L): displacement x time-to-maturity x liquidity.
 *
 * `makeMarketAt(timeToMaturitySeconds, liquidityScale)` must return a market
 * state; scaling liquidity means scaling both reserves, which leaves the
 * implied rate (and hence the price) unchanged while changing depth -- that is
 * the correct way to isolate L from P.
 */
function costSurface({ makeMarketAt, blockTime, horizonsDays = MATURITY_HORIZONS_DAYS, liquidityScales = [0.25, 1, 4], targets = DISPLACEMENT_TARGETS }) {
  const rows = [];
  for (const days of horizonsDays) {
    for (const scale of liquidityScales) {
      const market = makeMarketAt(days * 86400, scale);
      for (const target of targets) {
        const r = solveDisplacement(market, blockTime, target);
        rows.push({
          timeToMaturityDays: days,
          liquidityScale: scale,
          totalPt: market.totalPt,
          totalSy: market.totalSy,
          ...r,
        });
      }
    }
  }
  return rows;
}

/**
 * What a market displacement is worth to an attacker AFTER the oracle stage.
 *
 * This is where most of the manipulation value is destroyed, and the reason
 * differs per design:
 *
 *  - PendleSparkLinearDiscountOracle: the feed has no market inputs, so
 *    `oracleDisplacement` is exactly 0 for ANY spend. Reported as
 *    achievable:false with an infinite cost ratio rather than a large number,
 *    because the quantity is not "expensive", it is undefined.
 *  - PendleChainlinkOracle: OracleLib time-weights, so holding the displaced
 *    rate for `heldSeconds` of a `twapDuration` window transmits only
 *    heldSeconds/twapDuration of it -- and the attacker pays the round-trip
 *    cost for every window they hold it, while being exposed to arbitrage the
 *    whole time.
 *  - OjoPTFeed: min() over legs, so the transmitted displacement is capped by
 *    the *lowest* leg. If either leg is a linear-discount feed, the answer
 *    cannot be raised above that leg's value at all.
 */
function oracleDisplacement({ oracle, marketDisplacement, heldSeconds, market, blockTime }) {
  switch (oracle.kind) {
    case "PendleSparkLinearDiscountOracle":
      return {
        transmitted: 0,
        transmissionFactor: 0,
        note: "feed reads no market state; displacement cannot propagate",
      };

    case "PendleChainlinkOracle": {
      const timeToMaturity = market.expiry - blockTime;
      const base = market.lastLnImpliedRate;
      const displaced = marketDisplacement.displacedLnImpliedRate;
      const twap = amm.dilutedTwap(base, displaced, heldSeconds, oracle.twapDuration);
      const p0 = val.twapOracleValue({ twapLnImpliedRate: base, timeToMaturity, syIndex: 1, pyIndex: 1 });
      const p1 = val.twapOracleValue({ twapLnImpliedRate: twap, timeToMaturity, syIndex: 1, pyIndex: 1 });
      return {
        transmitted: p1 / p0 - 1,
        transmissionFactor: Math.min(heldSeconds, oracle.twapDuration) / oracle.twapDuration,
        twapLnImpliedRate: twap,
        note: `TWAP dilution over ${oracle.twapDuration}s`,
      };
    }

    case "OjoPTFeed": {
      // Only the manipulable legs move; min() then re-binds.
      const before = Math.min(...oracle.legAnswers);
      const after = Math.min(
        ...oracle.legAnswers.map((a, i) =>
          oracle.legManipulable[i] ? a * (1 + marketDisplacement.achievedFraction) : a
        )
      );
      return {
        transmitted: after / before - 1,
        transmissionFactor: before === 0 ? 0 : (after / before - 1) / (marketDisplacement.achievedFraction || 1),
        bindingLeg: oracle.legAnswers.indexOf(before),
        note: "min() aggregation: transmitted displacement bounded by the lowest leg",
      };
    }

    default:
      throw new Error(`unmodelled oracle kind: ${oracle.kind}`);
  }
}

module.exports = {
  DISPLACEMENT_TARGETS,
  MATURITY_HORIZONS_DAYS,
  roundTripCost,
  solveDisplacement,
  costSurface,
  oracleDisplacement,
};

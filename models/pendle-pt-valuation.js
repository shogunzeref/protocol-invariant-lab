// Phase 5 deliverable: the PT valuation relationship.
//
// (The task named `models/pendle-pt-valuation.ts`; this project is JavaScript
// throughout -- Hardhat + mocha, no TS toolchain -- so it is `.js`.)
//
// The single most important thing this file does is keep FOUR different numbers
// apart, because collapsing any two of them is what makes PT-collateral
// analysis go wrong:
//
//   A. redemptionValue      -- what 1 PT is contractually worth at maturity,
//                              in units of the SY's underlying asset. Pendle
//                              PTs redeem 1:1 for the accounting asset, so this
//                              is 1.0 asset per PT AT maturity, and *before*
//                              maturity holding a PT to maturity yields 1.0
//                              asset at a known future time.
//   B. marketImpliedValue   -- what the Pendle AMM says 1 PT is worth right
//                              now: 1 / e^(r*t) for the market's implied rate r.
//   C. oracleValue          -- what Morpho actually consumes. This is a
//                              function of the specific oracle deployed for
//                              that market, and for two of the three live
//                              designs it is NOT (B).
//   D. realizableValue      -- what a liquidator can actually get for the PT
//                              right now, i.e. (B) after the slippage and fees
//                              of unwinding a position of the relevant size.
//
// Morpho's risk is governed by (C) vs (D), not (B) vs (A).

const amm = require("./pendle-amm");

const YEAR = amm.YEAR;

/**
 * A. Deterministic redemption value.
 *
 * At maturity, 1 PT redeems for 1 unit of the SY's accounting asset
 * (PendleYieldToken redemption; PendlePYOracleLib returns PMath.ONE once
 * `expiry <= block.timestamp`). Before maturity the PT is a zero-coupon claim
 * on that unit, so its fundamental value depends on the discount rate a holder
 * requires -- there is no single "correct" pre-maturity number, only a bound:
 *
 *   redemptionValue(T, r) = 1 / e^(r*T)   and   value <= 1 for r >= 0
 *
 * The 1.0 ceiling is the load-bearing property: no honest valuation of a
 * (non-defaulted) PT can exceed the redemption value of its asset.
 */
function redemptionValue({ timeToMaturity, discountRate = 0 }) {
  if (timeToMaturity <= 0) return 1;
  return Math.exp((-discountRate * timeToMaturity) / YEAR);
}

/** Ceiling on any honest PT valuation, in asset units. */
const REDEMPTION_CEILING = 1;

/**
 * B. Market-implied value: PT/asset from the Pendle market's implied rate.
 * `market` is a models/pendle-amm.js market state.
 */
function marketImpliedValue(market, blockTime) {
  const timeToExpiry = market.expiry - blockTime;
  return amm.ptToAssetRate({
    lnImpliedRate: market.lastLnImpliedRate,
    timeToExpiry,
    syIndex: market.syIndex ?? market.index,
    pyIndex: market.pyIndex ?? market.index,
  });
}

/**
 * C-1. `PendleSparkLinearDiscountOracle` (verified deployed source):
 *
 *   timeLeft = max(0, maturity - now)
 *   discount = timeLeft * baseDiscountPerYear / SECONDS_PER_YEAR
 *   answer   = 1e18 - discount      (reverts if discount > 1e18)
 *
 * Properties that matter, all of them structural rather than incidental:
 *  - It reads NO market state at all. Pool reserves, implied rate, trade
 *    history and liquidity are not inputs, so no amount of AMM trading changes
 *    what this feed reports. The manipulation surface is empty.
 *  - It is LINEAR in time, whereas the honest discount is exponential; and it
 *    is a *floor* discount, so the reported price sits below the market price
 *    whenever the market's implied rate is under `baseDiscountPerYear`.
 *  - Its only time dependence is monotone upward toward 1.0 at maturity.
 */
function linearDiscountOracleValue({ timeToMaturity, baseDiscountPerYear }) {
  const timeLeft = Math.max(0, timeToMaturity);
  const discount = (timeLeft * baseDiscountPerYear) / YEAR;
  if (discount > 1) throw new Error("discount overflow"); // matches the require()
  return 1 - discount;
}

/**
 * C-2. `PendleChainlinkOracle` (verified deployed source) over
 * `PendlePYOracleLib.getPtToAssetRate` / `getPtToSyRate`:
 *
 *   lnImpliedRate = TWAP of the market's lnImpliedRate over `twapDuration`
 *   assetToPt     = e^(lnImpliedRate * timeToExpiry / YEAR)
 *   answer        = 1 / assetToPt        (haircut by syIndex/pyIndex if the SY
 *                                        exchange rate has fallen)
 *
 * This one DOES read the AMM -- but through the OracleLib accumulator, so the
 * input is a time-weighted mean rate, never a spot reserve ratio.
 */
function twapOracleValue({ twapLnImpliedRate, timeToMaturity, syIndex, pyIndex }) {
  return amm.ptToAssetRate({
    lnImpliedRate: twapLnImpliedRate,
    timeToExpiry: timeToMaturity,
    syIndex,
    pyIndex,
  });
}

/**
 * C-3. `OjoPTFeed` (verified deployed source): reports
 * `min(FEED_1.answer, FEED_2.answer)` with a 24h staleness revert on either leg.
 *
 * Taking the minimum is asymmetric in exactly the direction that matters for a
 * lending market: an attacker who inflates ONE leg cannot raise the reported
 * price at all, because the other leg still binds. To move this feed up, every
 * leg has to be moved up.
 */
function minAggregatedOracleValue(legAnswers) {
  if (!legAnswers.length) throw new Error("no legs");
  return Math.min(...legAnswers);
}

/**
 * C-4. `MetaOracleDeviationTimelock` (verified deployed source): reports the
 * currently-selected oracle, and only switches primary->backup after the
 * deviation has EXCEEDED `deviationThreshold` continuously for
 * `challengeTimelockDuration` and someone has called challenge() then
 * acceptChallenge().
 *
 * For manipulation analysis the important reading is the reverse of the
 * intended one: the meta-oracle does not clamp the primary's value. If the
 * primary is displaced, `price()` returns the displaced value immediately; the
 * timelock only governs the eventual *switch away* from the primary. So this
 * layer adds resilience against a primary that breaks and stays broken, not
 * against a short displacement.
 */
function metaOracleValue({ primary, backup, current = "primary" }) {
  return current === "primary" ? primary : backup;
}

function metaOracleDeviation({ primary, backup }) {
  if (backup === 0) return primary === 0 ? 0 : Infinity;
  return Math.abs(primary - backup) / backup;
}

/**
 * D. Realizable value: what unwinding `ptAmount` into the asset actually
 * returns per PT, through the Pendle AMM, after curve slippage and swap fees.
 *
 * This is the number a liquidator faces, and it is strictly below the
 * market-implied value for any non-infinitesimal size. Returns null when the
 * size cannot be unwound through the pool at all (the curve's 96% proportion
 * cap, or an exchange rate driven below 1).
 */
function realizableValuePerPt(market, ptAmount, blockTime) {
  if (ptAmount <= 0) return marketImpliedValue(market, blockTime);
  try {
    // Selling PT into the pool = negative netPtToAccount.
    const { trade } = amm.executeTrade(market, -ptAmount, blockTime);
    return trade.netAssetToAccount / ptAmount;
  } catch (e) {
    return null;
  }
}

/**
 * Full valuation snapshot for one market at one point in time. Every field is
 * labelled with which of A/B/C/D it is so downstream models cannot accidentally
 * substitute one for another.
 */
function valuationSnapshot({ market, blockTime, oracle, liquidationSize }) {
  const timeToMaturity = market.expiry - blockTime;

  const A = redemptionValue({ timeToMaturity, discountRate: 0 });
  const B = marketImpliedValue(market, blockTime);

  let C;
  switch (oracle.kind) {
    case "PendleSparkLinearDiscountOracle":
      C = linearDiscountOracleValue({ timeToMaturity, baseDiscountPerYear: oracle.baseDiscountPerYear });
      break;
    case "PendleChainlinkOracle":
      C = twapOracleValue({
        twapLnImpliedRate: oracle.twapLnImpliedRate ?? market.lastLnImpliedRate,
        timeToMaturity,
        syIndex: market.syIndex ?? market.index,
        pyIndex: market.pyIndex ?? market.index,
      });
      break;
    case "OjoPTFeed":
      C = minAggregatedOracleValue(oracle.legAnswers);
      break;
    case "MetaOracleDeviationTimelock":
      C = metaOracleValue(oracle);
      break;
    default:
      throw new Error(`unmodelled oracle kind: ${oracle.kind}`);
  }

  const D = liquidationSize ? realizableValuePerPt(market, liquidationSize, blockTime) : B;

  return {
    timeToMaturity,
    timeToMaturityDays: timeToMaturity / 86400,
    redemptionValue: A,
    marketImpliedValue: B,
    oracleValue: C,
    realizableValue: D,
    // Signed gaps. Positive oracleOvervaluation means Morpho is marking the
    // collateral above what the market says it is worth.
    oracleOvervaluationVsMarket: C - B,
    oracleOvervaluationVsRedemptionCeiling: C - REDEMPTION_CEILING,
    oracleOvervaluationVsRealizable: D === null ? null : C - D,
    oracleTracksMarket: Math.abs(C - B) < 1e-12,
  };
}

module.exports = {
  YEAR,
  REDEMPTION_CEILING,
  redemptionValue,
  marketImpliedValue,
  linearDiscountOracleValue,
  twapOracleValue,
  minAggregatedOracleValue,
  metaOracleValue,
  metaOracleDeviation,
  realizableValuePerPt,
  valuationSnapshot,
};

// Local, non-deployable model of the Pendle V2 PT/SY AMM and of its
// implied-rate TWAP oracle accumulator.
//
// This is a direct transcription of
//   pendle-core-v2-public/contracts/core/Market/MarketMathCore.sol
//   pendle-core-v2-public/contracts/core/Market/OracleLib.sol
//   pendle-core-v2-public/contracts/oracles/PtYtLpOracle/PendlePYOracleLib.sol
//   pendle-core-v2-public/contracts/core/StandardizedYield/SYUtils.sol
// (commit recorded in research/phase5-morpho-pendle-sources.md).
//
// PRECISION: the on-chain code is 18-decimal fixed point over Balancer's
// LogExpMath. This model uses IEEE-754 doubles with Math.log/Math.exp instead.
// That is a deliberate trade: it makes the maturity/liquidity/displacement
// sweeps tractable, and the relative error (~1e-15) is many orders of magnitude
// below the 0.5%-20% price displacements being studied. The error is not
// assumed to be negligible -- test/phase5/pendle-amm-port.js validates this
// model against the live on-chain oracle answers recorded in
// research/data/morpho-pt-markets.json and asserts the residual.
//
// NOTHING HERE IS DEPLOYABLE OR EXECUTABLE AGAINST A LIVE PROTOCOL: this file
// contains no transaction construction, no calldata, no signer and no ordering
// of live calls. It computes numbers.

const YEAR = 365 * 86400;
const MAX_MARKET_PROPORTION = 0.96;

/** MarketMathCore._getRateScalar */
function rateScalar(scalarRoot, timeToExpiry) {
  return (scalarRoot * YEAR) / timeToExpiry;
}

/** MarketMathCore._logProportion: ln(p / (1 - p)) */
function logProportion(proportion) {
  if (proportion === 1) throw new Error("MarketProportionMustNotEqualOne");
  return Math.log(proportion / (1 - proportion));
}

/** MarketMathCore._getExchangeRateFromImpliedRate: E = e^(r*t) */
function exchangeRateFromImpliedRate(lnImpliedRate, timeToExpiry) {
  return Math.exp((lnImpliedRate * timeToExpiry) / YEAR);
}

/** SYUtils.syToAsset */
function syToAsset(index, syAmount) {
  return syAmount * index;
}

/** SYUtils.assetToSy */
function assetToSy(index, assetAmount) {
  return assetAmount / index;
}

/**
 * PendlePYOracleLib.getSYandPYIndexCurrent -- the index the AMM values SY at.
 * `pyIndex` is monotone: max(syExchangeRate, pyIndexStored).
 */
function pyIndexCurrent({ syExchangeRate, pyIndexStored }) {
  return Math.max(syExchangeRate, pyIndexStored ?? 0);
}

/**
 * A market state sufficient to reproduce MarketMathCore. Amounts are in
 * human units (not wei); `index` is the SY->asset exchange rate as a ratio.
 */
function makeMarket({ totalPt, totalSy, index, scalarRoot, lnFeeRateRoot, lastLnImpliedRate, expiry }) {
  return { totalPt, totalSy, index, scalarRoot, lnFeeRateRoot, lastLnImpliedRate, expiry };
}

/** MarketMathCore.getMarketPreCompute */
function marketPreCompute(market, blockTime) {
  const timeToExpiry = market.expiry - blockTime;
  if (timeToExpiry <= 0) throw new Error("MarketExpired");

  const scalar = rateScalar(market.scalarRoot, timeToExpiry);
  const totalAsset = syToAsset(market.index, market.totalSy);
  if (market.totalPt === 0 || totalAsset === 0) throw new Error("MarketZeroTotalPtOrTotalAsset");

  // _getRateAnchor: re-anchors the curve so that, at the CURRENT reserves, the
  // curve reproduces `lastLnImpliedRate`. This is why the market's price is a
  // function of (reserves, lastLnImpliedRate) jointly rather than reserves
  // alone -- the constant-product intuition from the Moola AMM does not carry
  // over.
  const newExchangeRate = exchangeRateFromImpliedRate(market.lastLnImpliedRate, timeToExpiry);
  if (newExchangeRate < 1) throw new Error("MarketExchangeRateBelowOne");
  const proportion = market.totalPt / (market.totalPt + totalAsset);
  const rateAnchor = newExchangeRate - logProportion(proportion) / scalar;

  const feeRate = exchangeRateFromImpliedRate(market.lnFeeRateRoot, timeToExpiry);

  return { rateScalar: scalar, totalAsset, rateAnchor, feeRate, timeToExpiry };
}

/**
 * MarketMathCore._getExchangeRate -- asset-per-PT exchange rate the trade would
 * execute at, before fees. `netPtToAccount > 0` means the trader is buying PT
 * out of the pool.
 */
function exchangeRate(market, comp, netPtToAccount) {
  const numerator = market.totalPt - netPtToAccount;
  if (numerator < 0) throw new Error("negative PT reserve");
  const proportion = numerator / (market.totalPt + comp.totalAsset);
  if (proportion > MAX_MARKET_PROPORTION) throw new Error("MarketProportionTooHigh");
  const rate = logProportion(proportion) / comp.rateScalar + comp.rateAnchor;
  if (rate < 1) throw new Error("MarketExchangeRateBelowOne");
  return rate;
}

/**
 * MarketMathCore.calcTrade. Returns amounts in asset terms as well as SY, plus
 * the fee, so the manipulation cost model can charge the fee explicitly.
 */
function calcTrade(market, comp, netPtToAccount) {
  const preFeeExchangeRate = exchangeRate(market, comp, netPtToAccount);
  const preFeeAssetToAccount = -netPtToAccount / preFeeExchangeRate;
  const f = comp.feeRate;

  let fee;
  if (netPtToAccount > 0) {
    // Buying PT: fee widens the effective rate. Reverts if post-fee rate < 1.
    const postFeeExchangeRate = preFeeExchangeRate / f;
    if (postFeeExchangeRate < 1) throw new Error("MarketExchangeRateBelowOne(postFee)");
    fee = preFeeAssetToAccount * (1 - f);
  } else {
    fee = -((preFeeAssetToAccount * (1 - f)) / f);
  }

  const netAssetToAccount = preFeeAssetToAccount - fee;
  return {
    preFeeExchangeRate,
    netAssetToAccount,
    netSyToAccount: assetToSy(market.index, netAssetToAccount),
    netAssetFee: fee,
    netSyFee: assetToSy(market.index, fee),
  };
}

/** MarketMathCore._getLnImpliedRate, evaluated at the post-trade reserves. */
function lnImpliedRateAt(totalPt, totalAsset, comp) {
  const proportion = totalPt / (totalPt + totalAsset);
  if (proportion > MAX_MARKET_PROPORTION) throw new Error("MarketProportionTooHigh");
  const rate = logProportion(proportion) / comp.rateScalar + comp.rateAnchor;
  if (rate < 1) throw new Error("MarketExchangeRateBelowOne");
  return (Math.log(rate) * YEAR) / comp.timeToExpiry;
}

/**
 * MarketMathCore.executeTradeCore + _setNewMarketStateTrade. Pure: returns the
 * post-trade market rather than mutating the input, so sweeps can branch.
 */
function executeTrade(market, netPtToAccount, blockTime) {
  const comp = marketPreCompute(market, blockTime);
  const trade = calcTrade(market, comp, netPtToAccount);

  // reserveFeePercent is ignored here: it only splits the fee between LPs and
  // the Pendle treasury and does not change what the trader pays. Charging the
  // full fee to the pool is the conservative direction for a cost model.
  const totalPt = market.totalPt - netPtToAccount;
  const totalSy = market.totalSy - trade.netSyToAccount;
  const totalAsset = syToAsset(market.index, totalSy);

  const next = { ...market, totalPt, totalSy };
  next.lastLnImpliedRate = lnImpliedRateAt(totalPt, totalAsset, comp);

  return { market: next, trade, comp };
}

/**
 * PendlePYOracleLib.getPtToAssetRateRaw at twap duration 0, i.e. the spot
 * (post-last-trade) PT/asset rate the market's stored implied rate encodes.
 *
 * NOTE this is NOT a reserve ratio. It is 1 / e^(r*t) where r is the stored
 * implied rate. That distinction is the whole reason a Pendle PT feed cannot be
 * treated like the constant-product spot oracle in the Moola control case.
 */
function ptToAssetRateFromLnImpliedRate(lnImpliedRate, timeToExpiry) {
  if (timeToExpiry <= 0) return 1;
  return 1 / exchangeRateFromImpliedRate(lnImpliedRate, timeToExpiry);
}

/** PendlePYOracleLib.getPtToAssetRate: raw rate, haircut if SY is insolvent. */
function ptToAssetRate({ lnImpliedRate, timeToExpiry, syIndex, pyIndex }) {
  const raw = ptToAssetRateFromLnImpliedRate(lnImpliedRate, timeToExpiry);
  if (syIndex === undefined || pyIndex === undefined || syIndex >= pyIndex) return raw;
  return (raw * syIndex) / pyIndex;
}

/** PendlePYOracleLib.getPtToSyRate. */
function ptToSyRate({ lnImpliedRate, timeToExpiry, syIndex, pyIndex }) {
  const raw = ptToAssetRateFromLnImpliedRate(lnImpliedRate, timeToExpiry);
  return syIndex >= pyIndex ? raw / syIndex : raw / pyIndex;
}

/**
 * Model of OracleLib's accumulator, which is the reason atomic manipulation of
 * a Pendle feed does not work.
 *
 * `write` stores `lnImpliedRateCumulative += lastLnImpliedRate * dt`, using the
 * rate that prevailed BEFORE this update, and early-returns if an observation
 * was already written in the current block. So a rate only enters the TWAP in
 * proportion to the wall-clock time it persists, and a manipulate-and-revert
 * inside one block contributes exactly zero.
 *
 * @param segments [{ lnImpliedRate, seconds }] in chronological order
 * @param duration TWAP window in seconds
 * @returns time-weighted mean lnImpliedRate over the last `duration` seconds
 */
function twapLnImpliedRate(segments, duration) {
  let remaining = duration;
  let weighted = 0;
  for (let i = segments.length - 1; i >= 0 && remaining > 0; i--) {
    const take = Math.min(segments[i].seconds, remaining);
    weighted += segments[i].lnImpliedRate * take;
    remaining -= take;
  }
  if (remaining > 0) throw new Error("OracleTargetTooOld: window exceeds provided history");
  return weighted / duration;
}

/**
 * The TWAP an attacker achieves by holding a displaced rate for `heldSeconds`
 * of a `duration`-second window that was otherwise at `baseLnImpliedRate`.
 * Linear in heldSeconds/duration -- this is the dilution factor that bounds
 * every AMM-sourced displacement of a Pendle feed.
 */
function dilutedTwap(baseLnImpliedRate, displacedLnImpliedRate, heldSeconds, duration) {
  const held = Math.min(heldSeconds, duration);
  return (baseLnImpliedRate * (duration - held) + displacedLnImpliedRate * held) / duration;
}

module.exports = {
  YEAR,
  MAX_MARKET_PROPORTION,
  rateScalar,
  logProportion,
  exchangeRateFromImpliedRate,
  syToAsset,
  assetToSy,
  pyIndexCurrent,
  makeMarket,
  marketPreCompute,
  exchangeRate,
  calcTrade,
  lnImpliedRateAt,
  executeTrade,
  ptToAssetRateFromLnImpliedRate,
  ptToAssetRate,
  ptToSyRate,
  twapLnImpliedRate,
  dilutedTwap,
};

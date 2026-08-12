// Local model of Morpho Blue's collateral accounting, health check and
// liquidation mechanics.
//
// Transcribed from morpho-blue/src/Morpho.sol and
// morpho-blue/src/libraries/ConstantsLib.sol at the commit recorded in
// research/phase5-morpho-pendle-sources.md. The formulas are NOT a generic
// "collateral * LTV" stand-in -- Morpho Blue differs from the Aave-V2-shaped
// pool used in the Moola phases in three ways that matter to this research:
//
//   1. `price` is a single number: collateral quoted in loan token, scaled by
//      ORACLE_PRICE_SCALE = 1e36 (IOracle.sol). There is no per-asset oracle
//      lookup and no shared numeraire, so a market's collateral valuation
//      cannot be perturbed via the loan asset's own feed.
//   2. There is ONE risk parameter per market. `lltv` is simultaneously the max
//      LTV and the liquidation threshold -- there is no "borrow at 70%,
//      liquidate at 75%" buffer to absorb an oracle error.
//   3. The liquidation bonus is derived from lltv, not configured:
//        LIF = min(1.15, 1 / (1 - 0.3 * (1 - lltv)))
//      so high-LLTV markets (the PT markets run at 0.86-0.945) hand
//      liquidators a *smaller* bonus, which is what makes liquidation depth
//      rather than oracle displacement the binding constraint (Invariant C).

const ORACLE_PRICE_SCALE = 1e36;
const WAD = 1e18;
const LIQUIDATION_CURSOR = 0.3;
const MAX_LIQUIDATION_INCENTIVE_FACTOR = 1.15;

/**
 * Morpho.sol `_isHealthy`:
 *   maxBorrow = collateral.mulDivDown(collateralPrice, ORACLE_PRICE_SCALE)
 *                         .wMulDown(lltv)
 *
 * Expressed in ratio terms (price as loan-token per collateral-token, lltv as a
 * fraction) this is collateral * price * lltv, which this model uses; the 1e36
 * and WAD scalings are unit bookkeeping, not economics. `toScaledPrice` below
 * converts between the two representations so the model can be checked against
 * on-chain `IOracle.price()` values.
 */
function maxBorrow({ collateral, price, lltv }) {
  return collateral * price * lltv;
}

function isHealthy({ collateral, price, lltv, borrowed }) {
  return maxBorrow({ collateral, price, lltv }) >= borrowed;
}

/** Health factor. < 1 means liquidatable. Infinite when there is no debt. */
function healthFactor({ collateral, price, lltv, borrowed }) {
  if (borrowed === 0) return Infinity;
  return maxBorrow({ collateral, price, lltv }) / borrowed;
}

/**
 * Morpho.sol liquidate():
 *   LIF = min(MAX_LIQUIDATION_INCENTIVE_FACTOR,
 *             WAD / (WAD - LIQUIDATION_CURSOR * (WAD - lltv)))
 */
function liquidationIncentiveFactor(lltv) {
  return Math.min(MAX_LIQUIDATION_INCENTIVE_FACTOR, 1 / (1 - LIQUIDATION_CURSOR * (1 - lltv)));
}

/**
 * Morpho.sol liquidate(), `seizedAssets > 0` branch:
 *   repaid = seizedAssets * price / ORACLE_PRICE_SCALE / LIF
 * i.e. the liquidator repays the oracle value of what it seizes, discounted by
 * the incentive factor. Note the price used is the ORACLE price, which is the
 * mechanism by which a wrong oracle turns into a real transfer of value.
 */
function repaidForSeized({ seizedAssets, price, lltv }) {
  return (seizedAssets * price) / liquidationIncentiveFactor(lltv);
}

/**
 * Morpho.sol liquidate(), `repaidShares > 0` branch:
 *   seized = repaid * LIF * ORACLE_PRICE_SCALE / price
 */
function seizedForRepaid({ repaid, price, lltv }) {
  return (repaid * liquidationIncentiveFactor(lltv)) / price;
}

/**
 * Collateral a liquidator must seize to clear `debt` entirely, at `price`.
 * If this exceeds the borrower's collateral the position cannot be fully
 * liquidated and the residue is protocol bad debt -- Morpho has no
 * seize-everything backstop in `liquidate`, so the shortfall stays on the
 * market's books.
 */
function collateralToClearDebt({ debt, price, lltv }) {
  return seizedForRepaid({ repaid: debt, price, lltv });
}

/**
 * Bad debt left on the market after liquidators do everything profitable, given
 * an oracle price and an INDEPENDENT realizable value for the collateral.
 *
 * `oraclePrice` decides how much debt a given seizure repays (protocol-side
 * accounting), while `realizableValue` decides whether a liquidator is actually
 * willing to do it (economic-side). Computing shortfall from the oracle price
 * alone is the accounting error the Moola phases were designed to avoid, so it
 * is kept explicit here.
 */
function liquidationOutcome({ collateral, debt, oraclePrice, realizablePricePerUnit, lltv }) {
  const lif = liquidationIncentiveFactor(lltv);

  // A liquidator pays `seized * oraclePrice / lif` of loan token and receives
  // collateral it can only sell for `seized * realizablePricePerUnit`. It
  // participates only while that is profitable.
  const profitPerUnitSeized = realizablePricePerUnit - oraclePrice / lif;
  const liquidationProfitable = profitPerUnitSeized > 0;

  const collateralNeeded = collateralToClearDebt({ debt, price: oraclePrice, lltv });
  const seized = liquidationProfitable ? Math.min(collateral, collateralNeeded) : 0;
  const repaid = repaidForSeized({ seizedAssets: seized, price: oraclePrice, lltv });
  const collateralRemaining = collateral - seized;

  // `collateralToClearDebt` and `repaidForSeized` are exact inverses, so when
  // enough collateral exists the residual is algebraically zero and any nonzero
  // value is double-rounding in the reciprocal. Dust below 1e-9 of the debt is
  // discarded so it cannot be mistaken for a real shortfall; anything larger is
  // reported untouched.
  const rawRemaining = Math.max(0, debt - repaid);
  const debtRemaining = rawRemaining < Math.abs(debt) * 1e-9 ? 0 : rawRemaining;

  // Residual collateral is worthless to the market: Morpho only releases
  // collateral through `liquidate` (priced by the oracle) or the borrower's own
  // `withdrawCollateral`, so anything liquidators decline to take does not
  // offset the debt.
  return {
    liquidationIncentiveFactor: lif,
    liquidationProfitable,
    profitPerUnitSeized,
    collateralNeeded,
    seized,
    repaid,
    debtRemaining,
    collateralRemaining,
    collateralRemainingRealizableValue: collateralRemaining * realizablePricePerUnit,
    protocolShortfall: debtRemaining,
  };
}

/**
 * The oracle overvaluation required before a maximally-borrowed position can be
 * insolvent against an independent mark.
 *
 * A borrower at Morpho's limit owes `C * P_oracle * LLTV`. Marked independently
 * the same collateral is worth `C * P_true`. So the debt exceeds the collateral
 * exactly when
 *
 *     P_oracle * LLTV > P_true   <=>   (1 + d) * LLTV > 1   <=>   d > 1/LLTV - 1
 *
 * where `d` is the fractional overvaluation. The LLTV haircut is, in other
 * words, a deductible the attacker must burn through before any loss lands on
 * the protocol rather than on the attacker's own equity.
 */
function insolvencyDisplacementThreshold(lltv) {
  return 1 / lltv - 1;
}

/**
 * Whether displacing an oracle can make a position insolvent AT ALL, given a
 * hard ceiling on the price the oracle can be pushed to.
 *
 * For Pendle PT collateral the ceiling is the redemption value: the AMM cannot
 * price a PT above par, so `maxPrice = 1` asset and the largest available
 * overvaluation is `1/P_true - 1`. Combining with the threshold above, an
 * attacker needs
 *
 *     1/P_true - 1 > 1/LLTV - 1   <=>   P_true < LLTV
 *
 * i.e. insolvency is only reachable when the PT already trades BELOW the
 * market's LLTV. That is a property of the pair (price, LLTV) alone -- capital,
 * loop depth and liquidity do not enter it.
 */
function displacementInsolvencyReachable({ truePrice, lltv, maxPrice = 1 }) {
  const required = insolvencyDisplacementThreshold(lltv);
  const available = maxPrice / truePrice - 1;
  return {
    requiredDisplacement: required,
    availableDisplacement: available,
    reachable: available > required,
    // Distance to the regime boundary, in the same units as the PT price.
    priceHeadroom: truePrice - lltv * maxPrice,
  };
}

/** Convert a ratio price into the 1e36-scaled integer `IOracle.price()` returns. */
function toScaledPrice(priceRatio, collateralDecimals, loanDecimals) {
  return priceRatio * ORACLE_PRICE_SCALE * 10 ** (loanDecimals - collateralDecimals);
}

/** Inverse of toScaledPrice: interpret an on-chain `price()` as a ratio. */
function fromScaledPrice(scaledPrice, collateralDecimals, loanDecimals) {
  return Number(scaledPrice) / (ORACLE_PRICE_SCALE * 10 ** (loanDecimals - collateralDecimals));
}

module.exports = {
  ORACLE_PRICE_SCALE,
  WAD,
  LIQUIDATION_CURSOR,
  MAX_LIQUIDATION_INCENTIVE_FACTOR,
  maxBorrow,
  isHealthy,
  healthFactor,
  liquidationIncentiveFactor,
  repaidForSeized,
  seizedForRepaid,
  collateralToClearDebt,
  liquidationOutcome,
  insolvencyDisplacementThreshold,
  displacementInsolvencyReachable,
  toScaledPrice,
  fromScaledPrice,
};

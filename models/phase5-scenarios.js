// Scenario construction for the Phase 5 sweeps.
//
// Market states are built from the LIVE state recorded in
// research/data/morpho-pt-markets.json wherever possible, so the sweeps are
// anchored to real reserves, real implied rates, real LLTVs and real TWAP
// windows rather than to invented round numbers. Where a sweep dimension has to
// vary a live value (maturity, liquidity), it varies it explicitly and says so.

const fs = require("fs");
const path = require("path");
const amm = require("./pendle-amm");

const DATA_PATH = path.join(__dirname, "../research/data/morpho-pt-markets.json");

let cached = null;
function loadScan() {
  if (cached) return cached;
  cached = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  return cached;
}

/** Wei-string -> Number in human units. */
function fromWei(x, decimals = 18) {
  return Number(x) / 10 ** decimals;
}

/**
 * Turn a probed Pendle market record into a models/pendle-amm.js market state.
 * Returns null if the record is missing the fields the model needs.
 *
 * DECIMALS. Across the live markets, PT/SY decimals and the SY's *asset*
 * decimals do not agree (observed: an SY with 18 decimals over a 6-decimal
 * asset, whose `exchangeRate` is therefore ~1e6 rather than ~1e18). So the
 * reserves are rescaled to whole tokens and the SY index is rescaled to
 * asset-per-SY in whole-token terms:
 *
 *   totalPt_h = totalPt / 10^ptDec
 *   totalSy_h = totalSy / 10^syDec
 *   index_h   = (exchangeRate / 1e18) * 10^syDec / 10^assetDec
 *
 * This preserves both quantities the AMM math depends on -- `totalSy_h *
 * index_h` is the asset reserve in whole asset tokens, and `proportion` is
 * unchanged because it is dimensionless -- while making every amount the models
 * emit directly readable as tokens. Correctness of the rescaling is not assumed:
 * test/phase5/pendle-amm-port.js checks the resulting PT price against the live
 * on-chain oracle answers.
 */
function marketFromScan(pendleMarket) {
  const required = ["totalPt", "totalSy", "lastLnImpliedRate", "expiry", "scalarRoot", "lnFeeRateRoot", "syExchangeRate"];
  if (required.some((k) => pendleMarket[k] === undefined)) return null;

  const syDecimals = pendleMarket.syDecimals ?? 18;
  const ptDecimals = pendleMarket.ptDecimals ?? syDecimals;
  const assetDecimals = pendleMarket.assetDecimals ?? syDecimals;
  const decimalsAdjust = 10 ** (syDecimals - assetDecimals);

  const index = fromWei(pendleMarket.syExchangeRate, 18) * decimalsAdjust;
  const pyIndex = pendleMarket.pyIndexStored ? fromWei(pendleMarket.pyIndexStored, 18) * decimalsAdjust : index;

  return {
    ...amm.makeMarket({
      totalPt: fromWei(pendleMarket.totalPt, ptDecimals),
      totalSy: fromWei(pendleMarket.totalSy, syDecimals),
      // PYIndexLib.pyIndexCurrent is monotone: max(exchangeRate, stored).
      index: Math.max(index, pyIndex),
      scalarRoot: fromWei(pendleMarket.scalarRoot, 18),
      lnFeeRateRoot: fromWei(pendleMarket.lnFeeRateRoot, 18),
      lastLnImpliedRate: fromWei(pendleMarket.lastLnImpliedRate, 18),
      expiry: pendleMarket.expiry,
    }),
    syIndex: index,
    pyIndex,
    address: pendleMarket.address,
    ptDecimals,
    syDecimals,
    assetDecimals,
  };
}

/**
 * Every scanned Morpho market that has a usable live Pendle market attached,
 * paired with its Morpho risk parameters. These are the anchors for the sweeps.
 */
function liveScenarios() {
  const scan = loadScan();
  const out = [];
  for (const m of scan.markets || []) {
    if (m.error || !m.pendleMarkets) continue;
    for (const [address, pm] of Object.entries(m.pendleMarkets)) {
      const market = marketFromScan(pm);
      if (!market) continue;
      const twapLeaf = (m.ptPriceLeaves || []).find((l) => l.kind === "PendleChainlinkOracle" && l.market === address);
      out.push({
        label: `${m.chain} ${m.collateral.symbol}/${m.loan.symbol}`,
        marketId: m.marketId,
        chain: m.chain,
        chainId: m.chainId,
        lltv: m.lltvFraction,
        collateralDecimals: m.collateral.decimals,
        loanDecimals: m.loan.decimals,
        twapDuration: twapLeaf ? twapLeaf.twapDuration : null,
        onChainOracleAnswer: twapLeaf && twapLeaf.round ? twapLeaf.round.answer : null,
        ptPriceMechanism: m.ptPriceMechanism,
        defences: m.defences,
        collateralAssetsUsd: m.state ? m.state.collateralAssetsUsd : null,
        borrowAssetsUsd: m.state ? m.state.borrowAssetsUsd : null,
        scanTimestamp: m.state ? m.state.timestamp : null,
        pendleMarketAddress: address,
        market,
      });
    }
  }
  return out;
}

/**
 * The single largest live PT market with a TWAP oracle -- the most favourable
 * real target for an attacker, and therefore the right anchor for the headline
 * sweeps. Picking the deepest market is conservative for a *defensive*
 * conclusion and adversarial for the attack hypotheses, which is the direction
 * this research should err in.
 */
function largestTwapScenario() {
  const candidates = liveScenarios().filter((s) => s.twapDuration);
  if (!candidates.length) throw new Error("no live TWAP scenario in scan data");
  return candidates.sort((a, b) => (b.collateralAssetsUsd || 0) - (a.collateralAssetsUsd || 0))[0];
}

/**
 * Re-express a live market at a different time to maturity and liquidity depth,
 * holding the implied rate (and therefore the PT price) fixed.
 *
 * Maturity is varied by moving `expiry`, not by moving `blockTime`, so the
 * reserve *composition* is preserved. Scaling liquidity scales both reserves,
 * which leaves the proportion -- and hence the price -- unchanged while changing
 * depth. Both are the changes that isolate T and L from P.
 */
function reshape(market, { timeToMaturitySeconds, liquidityScale = 1, blockTime }) {
  return {
    ...market,
    totalPt: market.totalPt * liquidityScale,
    totalSy: market.totalSy * liquidityScale,
    expiry: blockTime + timeToMaturitySeconds,
  };
}

/** Reference block time: the scan's own observation timestamp where available. */
function scenarioBlockTime(scenario) {
  return scenario.scanTimestamp || Math.floor(Date.now() / 1000);
}

module.exports = {
  DATA_PATH,
  loadScan,
  fromWei,
  marketFromScan,
  liveScenarios,
  largestTwapScenario,
  reshape,
  scenarioBlockTime,
};

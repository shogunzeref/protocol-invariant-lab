// Phase 5 market reconnaissance. STRICTLY READ-ONLY.
//
// Enumerates live Morpho Blue markets whose collateral is a Pendle PT, then for
// each one walks the deployed oracle contracts to DETERMINE (not assume) what
// price Morpho actually consumes, and pulls the live Pendle market state the
// local models need.
//
// The Morpho indexer is used for market discovery only. The oracle path is
// resolved by probing the adapter contract itself, so a market is still fully
// classified when the indexer does not recognise its oracle shape.
//
//   node scripts/phase5/scan-morpho-pt-markets.js [--top N] [--out path]
//
// Output: research/data/morpho-pt-markets.json

const fs = require("fs");
const path = require("path");
const { fetchPtMarkets } = require("./lib/morpho-api");
const {
  classifyOracleNode,
  collectPtLeaves,
  describePath,
  walk,
  readPendleMarket,
  readObservations,
} = require("./lib/oracle-probe");
const { blockNumber, CHAIN_NAMES } = require("./lib/rpc");

function parseArgs(argv) {
  const args = { top: 20, out: path.join(__dirname, "../../research/data/morpho-pt-markets.json") };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--top") args.top = Number(argv[++i]);
    else if (argv[i] === "--out") args.out = argv[++i];
  }
  return args;
}

/**
 * Enumerate the manipulation-resistance layers present in a classified path.
 *
 * `spotMarketReads` is the count of legs that read live market state WITHOUT
 * time-weighting. For the Moola control phases that count was 1 (the
 * constant-product spot oracle) and that is what made the whole class of attack
 * work; it is reported here so the comparison is quantitative rather than
 * rhetorical.
 */
function summariseDefences(root) {
  const d = {
    twapWindows: [],
    marketIndependentFeeds: 0,
    minAggregations: 0,
    yieldCaps: [],
    deviationTimelocks: [],
    stalenessGuards: [],
    spotMarketReads: 0,
  };
  walk(root, (node) => {
    switch (node.kind) {
      case "PendleChainlinkOracle":
        // Time-weighted: contributes to the TWAP window list, not to spot reads.
        if (node.twapDuration === 0) d.spotMarketReads++;
        else d.twapWindows.push(node.twapDuration);
        break;
      case "PendleSparkLinearDiscountOracle":
        d.marketIndependentFeeds++;
        break;
      case "OjoPTFeed":
        d.minAggregations++;
        if (node.stalenessThreshold) d.stalenessGuards.push(node.stalenessThreshold);
        break;
      case "OjoYieldRiskEngineV2":
        d.yieldCaps.push({
          annualYieldCap: node.annualYieldCap,
          maxAllowedPrice: node.maxAllowedPrice,
          latestAnswer: node.round ? node.round.answer : null,
        });
        break;
      case "MetaOracleDeviationTimelock":
        d.deviationTimelocks.push({
          deviationThreshold: node.deviationThreshold,
          challengeTimelockDuration: node.challengeTimelockDuration,
          healingTimelockDuration: node.healingTimelockDuration,
          currentDeviation: node.currentDeviation,
          isPrimary: node.isPrimary,
        });
        break;
      default:
        break;
    }
  });
  return d;
}

async function inspectMarket(m, pendleMarketCache) {
  const chainId = Number(m.chain.id);
  const rec = {
    marketId: m.marketId,
    chainId,
    chain: m.chain.network,
    lltv: m.lltv,
    lltvFraction: Number(m.lltv) / 1e18,
    irm: m.irmAddress,
    creationTimestamp: m.creationTimestamp,
    collateral: m.collateralAsset,
    loan: m.loanAsset,
    oracleAdapter: m.oracle ? m.oracle.address : null,
    indexerOracleShape: m.oracle && m.oracle.data ? m.oracle.data.__typename : null,
    state: m.state,
  };

  if (!rec.oracleAdapter) {
    rec.ptPriceMechanism = "UNKNOWN";
    return rec;
  }

  rec.oraclePath = await classifyOracleNode(chainId, rec.oracleAdapter);
  rec.oraclePathKinds = describePath(rec.oraclePath);

  const leaves = collectPtLeaves(rec.oraclePath);
  rec.ptPriceLeaves = leaves;
  const mechanisms = [...new Set(leaves.map((l) => l.kind))];
  rec.ptPriceMechanism =
    mechanisms.length === 0 ? "UNKNOWN" : mechanisms.length === 1 ? mechanisms[0] : mechanisms.sort().join("+");

  // Which manipulation-resistance layers sit between the AMM and Morpho, and
  // whether ANY leg of the path is a spot (non-time-weighted) read of market
  // state. This is the summary the falsification tests key off.
  rec.defences = summariseDefences(rec.oraclePath);
  // No Pendle PT feed anywhere in the path means the market does not apply a
  // PT-vs-underlying discount at all: it marks PT at the underlying's price.
  rec.appliesPtDiscount = leaves.length > 0;

  // Live Pendle market state, for every distinct AMM-reading leaf. The cache
  // matters: several Morpho markets share one Pendle market, and each read is
  // ~10 eth_calls against rate-limited public endpoints.
  rec.pendleMarkets = {};
  for (const leaf of leaves) {
    if (leaf.kind !== "PendleChainlinkOracle" || !leaf.market) continue;
    const key = `${chainId}:${leaf.market.toLowerCase()}`;
    if (!pendleMarketCache.has(key)) {
      const state = await readPendleMarket(chainId, leaf.market);
      if (leaf.twapDuration) {
        state.observations = await readObservations(chainId, leaf.market, leaf.twapDuration);
      }
      pendleMarketCache.set(key, state);
    }
    rec.pendleMarkets[leaf.market] = pendleMarketCache.get(key);
  }

  return rec;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log("Fetching Morpho markets with Pendle PT collateral (read-only)...");
  const all = await fetchPtMarkets(500);

  // The indexer returns one row per (market, vault-listing); collapse to unique
  // market ids so `--top N` means N distinct markets.
  const unique = [];
  const seen = new Set();
  for (const m of all) {
    const key = `${m.chain.id}:${m.marketId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(m);
  }
  console.log(`  ${all.length} rows -> ${unique.length} distinct PT markets`);

  const selected = unique.slice(0, args.top);
  const pendleMarketCache = new Map();
  const results = [];
  for (const m of selected) {
    const label = `${m.chain.network} ${m.collateralAsset.symbol}/${m.loanAsset.symbol}`;
    process.stdout.write(`  probing ${label} ... `);
    try {
      const rec = await inspectMarket(m, pendleMarketCache);
      results.push(rec);
      console.log(`${rec.ptPriceMechanism}  [${(rec.oraclePathKinds || []).join(" > ")}]`);
    } catch (e) {
      results.push({ marketId: m.marketId, chainId: Number(m.chain.id), chain: m.chain.network, error: e.message });
      console.log(`ERROR ${e.message}`);
    }
  }

  const heads = {};
  for (const chainId of new Set(results.map((r) => r.chainId))) {
    heads[CHAIN_NAMES[chainId] || chainId] = await blockNumber(chainId);
  }

  const byMechanism = {};
  for (const r of results) {
    const k = r.ptPriceMechanism || "ERROR";
    byMechanism[k] = (byMechanism[k] || 0) + 1;
  }

  const out = {
    generatedAt: new Date().toISOString(),
    note:
      "Read-only reconnaissance. Market discovery via blue-api.morpho.org; every oracle mechanism re-derived " +
      "by probing the deployed contracts through public RPC (eth_call only).",
    chainHeads: heads,
    distinctPtMarkets: unique.length,
    inspected: results.length,
    mechanismDistribution: byMechanism,
    markets: results,
  };

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(out, null, 2) + "\n");
  console.log(`\nWrote ${args.out}`);
  console.log("PT price mechanism distribution:", byMechanism);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

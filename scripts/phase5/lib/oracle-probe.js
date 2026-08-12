// Read-only, recursive classification of the price path a Morpho Blue market
// actually consumes for Pendle PT collateral, plus recovery of the live Pendle
// market state the local models need.
//
// The whole point of this module is that the mechanism is DETERMINED, not
// assumed. Each candidate contract shape is identified by probing the getters
// that ONLY that shape has, and the probe then recurses through every
// composition layer (Morpho adapter -> meta-oracle -> aggregator -> Pendle
// feed) until it reaches leaves. Anything that matches no known shape is
// reported as UNKNOWN, never guessed at from a token name or a description
// string.
//
// Shapes and their provenance are recorded in
// research/phase5-morpho-pendle-sources.md.

const { call } = require("./rpc");

const ZERO = "0x0000000000000000000000000000000000000000";

// PendleChainlinkOracle.baseOracleType -> PendleOracleType
// (pendle-core-v2-public contracts/interfaces/IPPYLpOracle.sol)
const PENDLE_ORACLE_TYPE = ["PT_TO_SY", "PT_TO_ASSET", "LP_TO_SY", "LP_TO_ASSET"];

// Mechanisms that terminate the recursion: these are the leaves that actually
// produce a PT valuation, and each has materially different manipulation
// properties (see research/phase5-morpho-pendle.md section 4).
const PT_LEAF_KINDS = new Set(["PendleSparkLinearDiscountOracle", "PendleChainlinkOracle"]);

async function tryRead(chainId, addr, sig, types) {
  const r = await call(chainId, addr, sig, types);
  return r.ok ? r.value : null;
}

async function readRound(chainId, addr) {
  const r = await call(chainId, addr, "latestRoundData()", [
    "uint80", "int256", "uint256", "uint256", "uint80",
  ]);
  if (!r.ok) return null;
  return { answer: r.value[1].toString(), updatedAt: Number(r.value[3]) };
}

/**
 * Classify one node of the price path and recurse into its children.
 *
 * Returns { kind, address, ...shape-specific fields, children?: {...} }.
 * `kind === "UNKNOWN"` is a real, reportable result.
 */
async function classifyOracleNode(chainId, addr, depth = 0) {
  if (!addr || addr === ZERO || depth > 5) return null;

  const node = { address: addr, kind: "UNKNOWN" };
  const [description, decimals] = await Promise.all([
    tryRead(chainId, addr, "description()", ["string"]),
    tryRead(chainId, addr, "decimals()", ["uint8"]),
  ]);
  if (description !== null) node.description = description;
  if (decimals !== null) node.decimals = Number(decimals);

  // --- Pendle deterministic linear-discount feed (time-only, AMM-independent)
  const [discount, maturity] = await Promise.all([
    tryRead(chainId, addr, "baseDiscountPerYear()", ["uint256"]),
    tryRead(chainId, addr, "maturity()", ["uint256"]),
  ]);
  if (discount !== null && maturity !== null) {
    node.kind = "PendleSparkLinearDiscountOracle";
    node.baseDiscountPerYear = discount.toString();
    node.maturity = Number(maturity);
    const pt = await tryRead(chainId, addr, "PT()", ["address"]);
    if (pt !== null) node.pt = pt;
    node.round = await readRound(chainId, addr);
    return node;
  }

  // --- Pendle implied-rate TWAP feed (reads the Pendle AMM, time-weighted)
  const [twapDuration, market] = await Promise.all([
    tryRead(chainId, addr, "twapDuration()", ["uint32"]),
    tryRead(chainId, addr, "market()", ["address"]),
  ]);
  if (twapDuration !== null && market !== null) {
    node.kind = "PendleChainlinkOracle";
    node.twapDuration = Number(twapDuration);
    node.market = market;
    const t = await tryRead(chainId, addr, "baseOracleType()", ["uint8"]);
    if (t !== null) {
      node.baseOracleType = Number(t);
      node.baseOracleTypeName = PENDLE_ORACLE_TYPE[node.baseOracleType] ?? "UNKNOWN";
    }
    node.round = await readRound(chainId, addr);
    return node;
  }

  // --- Morpho's own composite adapter: price() = (base legs) / (quote legs),
  //     scaled so the result is 1e36-normalised for Morpho.
  const baseFeedOne = await tryRead(chainId, addr, "BASE_FEED_1()", ["address"]);
  const scaleFactor = await tryRead(chainId, addr, "SCALE_FACTOR()", ["uint256"]);
  if (baseFeedOne !== null && scaleFactor !== null) {
    node.kind = "MorphoChainlinkOracleV2";
    node.scaleFactor = scaleFactor.toString();
    const legs = {
      BASE_FEED_1: baseFeedOne,
      BASE_FEED_2: await tryRead(chainId, addr, "BASE_FEED_2()", ["address"]),
      QUOTE_FEED_1: await tryRead(chainId, addr, "QUOTE_FEED_1()", ["address"]),
      QUOTE_FEED_2: await tryRead(chainId, addr, "QUOTE_FEED_2()", ["address"]),
    };
    for (const [k, v] of Object.entries({
      baseVault: await tryRead(chainId, addr, "BASE_VAULT()", ["address"]),
      quoteVault: await tryRead(chainId, addr, "QUOTE_VAULT()", ["address"]),
      baseVaultConversionSample: await tryRead(chainId, addr, "BASE_VAULT_CONVERSION_SAMPLE()", ["uint256"]),
      quoteVaultConversionSample: await tryRead(chainId, addr, "QUOTE_VAULT_CONVERSION_SAMPLE()", ["uint256"]),
    })) {
      if (v !== null && v !== ZERO) node[k] = v.toString();
    }
    node.children = {};
    for (const [leg, feed] of Object.entries(legs)) {
      if (!feed || feed === ZERO) continue;
      node.children[leg] = await classifyOracleNode(chainId, feed, depth + 1);
    }
    const price = await tryRead(chainId, addr, "price()", ["uint256"]);
    if (price !== null) node.price = price.toString();
    return node;
  }

  // --- Steakhouse meta-oracle: selects primary vs backup on sustained
  //     deviation, gated by challenge/healing timelocks.
  const [primary, backup] = await Promise.all([
    tryRead(chainId, addr, "primaryOracle()", ["address"]),
    tryRead(chainId, addr, "backupOracle()", ["address"]),
  ]);
  if (primary !== null && backup !== null) {
    node.kind = "MetaOracleDeviationTimelock";
    const [threshold, challengeDur, healingDur, current, isPrimary, deviation, price] = await Promise.all([
      tryRead(chainId, addr, "deviationThreshold()", ["uint256"]),
      tryRead(chainId, addr, "challengeTimelockDuration()", ["uint256"]),
      tryRead(chainId, addr, "healingTimelockDuration()", ["uint256"]),
      tryRead(chainId, addr, "currentOracle()", ["address"]),
      tryRead(chainId, addr, "isPrimary()", ["bool"]),
      tryRead(chainId, addr, "getDeviation()", ["uint256"]),
      tryRead(chainId, addr, "price()", ["uint256"]),
    ]);
    if (threshold !== null) node.deviationThreshold = threshold.toString();
    if (challengeDur !== null) node.challengeTimelockDuration = Number(challengeDur);
    if (healingDur !== null) node.healingTimelockDuration = Number(healingDur);
    if (current !== null) node.currentOracle = current;
    if (isPrimary !== null) node.isPrimary = isPrimary;
    if (deviation !== null) node.currentDeviation = deviation.toString();
    if (price !== null) node.price = price.toString();
    node.children = {
      primaryOracle: await classifyOracleNode(chainId, primary, depth + 1),
      backupOracle: await classifyOracleNode(chainId, backup, depth + 1),
    };
    return node;
  }

  // --- Ojo yield risk engine: hard upper cap on the reported price. The cap
  //     compounds at `annualYieldCap` from an (initialPrice, initialTimestamp)
  //     anchor fixed at initialize(), and the answer is min(raw, cap). This is
  //     an absolute ceiling on upward displacement, independent of the
  //     underlying feed's own manipulation resistance.
  const [basePriceFeed, annualYieldCap] = await Promise.all([
    tryRead(chainId, addr, "basePriceFeed()", ["address"]),
    tryRead(chainId, addr, "annualYieldCap()", ["uint256"]),
  ]);
  if (basePriceFeed !== null && annualYieldCap !== null) {
    node.kind = "OjoYieldRiskEngineV2";
    node.aggregation = "min(raw, compounding cap)";
    node.annualYieldCap = annualYieldCap.toString();
    const [initialTimestamp, initialPrice, maxAllowed] = await Promise.all([
      tryRead(chainId, addr, "initialTimestamp()", ["uint256"]),
      tryRead(chainId, addr, "initialPrice()", ["int256"]),
      call(chainId, addr, "getCurrentMaxAllowedPrice()", ["int256", "uint256"]),
    ]);
    if (initialTimestamp !== null) node.initialTimestamp = Number(initialTimestamp);
    if (initialPrice !== null) node.initialPrice = initialPrice.toString();
    if (maxAllowed.ok) {
      node.maxAllowedPrice = maxAllowed.value[0].toString();
      node.currentYieldPercent = maxAllowed.value[1].toString();
    }
    node.round = await readRound(chainId, addr);
    node.children = { basePriceFeed: await classifyOracleNode(chainId, basePriceFeed, depth + 1) };
    return node;
  }

  // --- Ojo aggregator: reports min(FEED_1, FEED_2) with a staleness guard.
  const [feed1, feed2] = await Promise.all([
    tryRead(chainId, addr, "FEED_1()", ["address"]),
    tryRead(chainId, addr, "FEED_2()", ["address"]),
  ]);
  if (feed1 !== null && feed2 !== null) {
    node.kind = "OjoPTFeed";
    node.aggregation = "min";
    const [staleness, active] = await Promise.all([
      tryRead(chainId, addr, "STALENESS_THRESHOLD()", ["uint256"]),
      tryRead(chainId, addr, "getActiveOracle()", ["address"]),
    ]);
    if (staleness !== null) node.stalenessThreshold = Number(staleness);
    if (active !== null) node.activeFeed = active;
    node.round = await readRound(chainId, addr);
    node.children = {
      FEED_1: await classifyOracleNode(chainId, feed1, depth + 1),
      FEED_2: await classifyOracleNode(chainId, feed2, depth + 1),
    };
    return node;
  }

  // --- Thin pass-through wrapper (only rewrites `updatedAt`).
  const inner = await tryRead(chainId, addr, "innerOracle()", ["address"]);
  if (inner !== null && inner !== ZERO) {
    node.kind = "PendleLinearDiscountOracleWrapper";
    node.children = { innerOracle: await classifyOracleNode(chainId, inner, depth + 1) };
    return node;
  }

  // --- Plain Chainlink aggregator (the quote leg of most of these markets:
  //     e.g. USDC/USD). Not a PT price source, but worth naming so the market
  //     map does not report the quote side as UNKNOWN.
  node.round = await readRound(chainId, addr);
  const aggregator = await tryRead(chainId, addr, "aggregator()", ["address"]);
  if (node.round !== null && (aggregator !== null || node.description !== undefined)) {
    node.kind = "ChainlinkAggregator";
    if (aggregator !== null) node.aggregator = aggregator;
    return node;
  }

  // Unrecognised. Record what little is observable and label it UNKNOWN.
  const price = await tryRead(chainId, addr, "price()", ["uint256"]);
  if (price !== null) node.price = price.toString();
  return node;
}

/** Depth-first walk of a classified tree. */
function walk(node, visit, pathParts = []) {
  if (!node) return;
  visit(node, pathParts.join(" > "));
  for (const [leg, child] of Object.entries(node.children || {})) {
    walk(child, visit, [...pathParts, `${leg}:${child ? child.kind : "null"}`]);
  }
}

/** Every PT-pricing leaf reachable from `root`, with the path taken to reach it. */
function collectPtLeaves(root) {
  const leaves = [];
  walk(root, (node, path) => {
    if (PT_LEAF_KINDS.has(node.kind)) leaves.push({ path, ...node });
  }, [root ? root.kind : "null"]);
  return leaves;
}

/** Flat list of every distinct `kind` in the tree, for the market map summary. */
function describePath(root) {
  const kinds = [];
  walk(root, (node) => kinds.push(node.kind));
  return kinds;
}

/**
 * Recover the live state of a Pendle market: everything MarketMathCore and
 * PendlePYOracleLib need to reproduce the on-chain PT price locally.
 */
async function readPendleMarket(chainId, market) {
  const out = { address: market, chainId };

  // `readState(router)` returns the whole MarketState struct, including the
  // immutables (`scalarRoot`) and the fee actually in force for that router.
  // Router 0x0 gets the non-overridden fee, which is the conservative choice for
  // a cost model: a fee override can only make trading cheaper for a
  // whitelisted router, never dearer.
  const [state, storage, tokens] = await Promise.all([
    call(
      chainId,
      market,
      "readState(address)",
      ["int256", "int256", "int256", "address", "int256", "uint256", "uint256", "uint256", "uint256"],
      [ZERO],
      ["address"]
    ),
    call(chainId, market, "_storage()", ["int128", "int128", "uint96", "uint16", "uint16", "uint16"]),
    call(chainId, market, "readTokens()", ["address", "address", "address"]),
  ]);

  if (!state.ok) return { ...out, error: `readState() failed: ${state.error}` };

  const [totalPt, totalSy, totalLp, treasury, scalarRoot, expiry, lnFeeRateRoot, reserveFeePercent, lastLnImpliedRate] =
    state.value;
  Object.assign(out, {
    totalPt: totalPt.toString(),
    totalSy: totalSy.toString(),
    totalLp: totalLp.toString(),
    treasury,
    scalarRoot: scalarRoot.toString(),
    expiry: Number(expiry),
    lnFeeRateRoot: lnFeeRateRoot.toString(),
    reserveFeePercent: Number(reserveFeePercent),
    lastLnImpliedRate: lastLnImpliedRate.toString(),
  });

  if (storage.ok) {
    out.observationIndex = Number(storage.value[3]);
    out.observationCardinality = Number(storage.value[4]);
    out.observationCardinalityNext = Number(storage.value[5]);
  }

  if (tokens.ok) {
    const [sy, pt, yt] = tokens.value;
    Object.assign(out, { sy, pt, yt });
    const [syRate, pyIndex, syDecimals, ptDecimals, assetInfo] = await Promise.all([
      call(chainId, sy, "exchangeRate()", ["uint256"]),
      call(chainId, yt, "pyIndexStored()", ["uint256"]),
      call(chainId, sy, "decimals()", ["uint8"]),
      call(chainId, pt, "decimals()", ["uint8"]),
      call(chainId, sy, "assetInfo()", ["uint8", "address", "uint8"]),
    ]);
    if (syRate.ok) out.syExchangeRate = syRate.value.toString();
    if (pyIndex.ok) out.pyIndexStored = pyIndex.value.toString();
    if (syDecimals.ok) out.syDecimals = Number(syDecimals.value);
    if (ptDecimals.ok) out.ptDecimals = Number(ptDecimals.value);
    if (assetInfo.ok) {
      out.assetType = Number(assetInfo.value[0]);
      out.assetAddress = assetInfo.value[1];
      out.assetDecimals = Number(assetInfo.value[2]);
    }
  }

  return out;
}

/**
 * Read the market's TWAP accumulator now and `duration` seconds ago -- exactly
 * the input PendlePYOracleLib.getMarketLnImpliedRate consumes -- so the local
 * TWAP model can be validated against live observations.
 */
async function readObservations(chainId, market, duration) {
  const r = await call(chainId, market, "observe(uint32[])", ["uint216[]"], [[duration, 0]], ["uint32[]"]);
  if (!r.ok) return { ok: false, error: r.error };
  const [older, newer] = r.value;
  return {
    ok: true,
    duration,
    cumulativeOlder: older.toString(),
    cumulativeNewer: newer.toString(),
    twapLnImpliedRate: ((newer - older) / BigInt(duration)).toString(),
  };
}

module.exports = {
  classifyOracleNode,
  collectPtLeaves,
  describePath,
  walk,
  readPendleMarket,
  readObservations,
  PENDLE_ORACLE_TYPE,
  PT_LEAF_KINDS,
};

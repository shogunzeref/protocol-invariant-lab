// Read-only Morpho Blue indexer (blue-api.morpho.org) client, used to
// enumerate live Morpho markets whose collateral token is a Pendle PT.
//
// The API is used ONLY as a market *discovery* index. Every risk-relevant
// value the research relies on (oracle mechanism, oracle parameters, LLTV
// semantics, AMM state) is re-derived from contract source or read back
// directly from chain via scripts/phase5/lib/rpc.js -- see
// research/phase5-morpho-pendle-sources.md.

const ENDPOINT = "https://blue-api.morpho.org/graphql";

const MARKETS_QUERY = `
query PtMarkets($first: Int!) {
  markets(first: $first, where: { search: "PT-", listed: true },
          orderBy: SupplyAssetsUsd, orderDirection: Desc) {
    items {
      marketId
      lltv
      irmAddress
      creationTimestamp
      chain { id network }
      collateralAsset { address symbol decimals }
      loanAsset { address symbol decimals }
      oracle {
        address
        data {
          __typename
          ... on MorphoChainlinkOracleV2Data {
            baseFeedOne { address decimals }
            baseFeedTwo { address decimals }
            quoteFeedOne { address decimals }
            quoteFeedTwo { address decimals }
            scaleFactor
            baseVaultConversionSample
            quoteVaultConversionSample
            baseOracleVault { address }
            quoteOracleVault { address }
          }
        }
      }
      state {
        blockNumber
        timestamp
        price
        supplyAssets
        borrowAssets
        collateralAssets
        supplyAssetsUsd
        borrowAssetsUsd
        collateralAssetsUsd
        utilization
        borrowApy
      }
    }
  }
}`;

async function query(q, variables) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: q, variables }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Morpho API HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(`Morpho API: ${JSON.stringify(json.errors)}`);
  return json.data;
}

async function fetchPtMarkets(first = 500) {
  const data = await query(MARKETS_QUERY, { first });
  return data.markets.items.filter(
    (m) => m.collateralAsset && /^PT[-_]/i.test(m.collateralAsset.symbol)
  );
}

module.exports = { fetchPtMarkets, query, ENDPOINT };

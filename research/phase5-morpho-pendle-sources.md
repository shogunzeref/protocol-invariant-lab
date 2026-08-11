# Phase 5 — Source provenance

Every claim in `research/phase5-morpho-pendle.md` and every formula in `models/`
traces back to one of the artifacts below. Anything that could not be resolved
to a verified source is marked `UNKNOWN` rather than inferred.

Acquired: 2026-08-11. Acquisition was `git clone --depth 1` plus read-only
`eth_call` / Blockscout API reads. No transaction was signed or submitted at any
point in this phase.

---

## 1. Reference repositories

### 1.1 Morpho Blue

| Field | Value |
| --- | --- |
| Repository | `https://github.com/morpho-org/morpho-blue` |
| Branch | `main` |
| Commit | `d09dd1c4b9c7d9d05f976faa7ebfdc424dae5e8c` |
| Commit date | 2026-07-28T12:40:20+02:00 |
| Local clone | `/home/ubuntu/vendor/morpho-blue` (inspection only, not vendored into this repo) |
| Solidity pragma — core | `pragma solidity 0.8.19;` (exact, `src/Morpho.sol` and all of `src/libraries/`) |
| Solidity pragma — interfaces | `pragma solidity >=0.5.0;` |

Contracts read for this phase:

| Path | What was taken from it |
| --- | --- |
| `src/Morpho.sol` | `_isHealthy`, `borrow`, `liquidate`, collateral accounting |
| `src/interfaces/IOracle.sol` | `price()` semantics and the `1e36` scaling contract |
| `src/libraries/ConstantsLib.sol` | `ORACLE_PRICE_SCALE`, `LIQUIDATION_CURSOR`, `MAX_LIQUIDATION_INCENTIVE_FACTOR` |
| `src/libraries/MathLib.sol` | `wMulDown` / `wDivDown` rounding directions |
| `src/libraries/SharesMathLib.sol` | share/asset conversion used by `liquidate` |

### 1.2 Pendle Core V2

| Field | Value |
| --- | --- |
| Repository | `https://github.com/pendle-finance/pendle-core-v2-public` |
| Branch | `main` |
| Commit | `0fcebf79fa7d9eced3137c8d09829e315ed50b3c` |
| Commit date | 2026-08-06T21:33:25+07:00 |
| Local clone | `/home/ubuntu/vendor/pendle-core-v2-public` (inspection only) |
| Solidity pragmas | `^0.8.0` (math/SY/market libs), `^0.8.17`, `^0.8.19` (oracles) |
| Build config | `foundry.toml` sets `via_ir = true` |

Contracts read for this phase:

| Path | What was taken from it |
| --- | --- |
| `contracts/core/Market/MarketMathCore.sol` | `getMarketPreCompute`, `_getRateAnchor`, `_getRateScalar`, `_getExchangeRate`, `calcTrade`, `_getLnImpliedRate` |
| `contracts/core/Market/OracleLib.sol` | the observation accumulator (`lnImpliedRateCumulative`), one-write-per-block rule |
| `contracts/core/Market/PendleMarketV7.sol` | `_storage()`, `observe()`, `readTokens()` layout used by the probe |
| `contracts/core/StandardizedYield/SYUtils.sol` | `syToAsset` / `assetToSy` |
| `contracts/core/StandardizedYield/PYIndex.sol` | `pyIndexCurrent` monotonicity |
| `contracts/oracles/PtYtLpOracle/PendlePYOracleLib.sol` | `getPtToAssetRate`, `getPtToSyRate`, `getPtToAssetRateRaw`, the `syIndex < pyIndex` haircut, the post-expiry `= ONE` branch |
| `contracts/oracles/PtYtLpOracle/chainlink/PendleChainlinkOracle.sol` | `latestRoundData`, `twapDuration`, `baseOracleType` |
| `contracts/oracles/internal/PendleSparkLinearDiscountOracle.sol` | the linear-discount formula and its `require` bound |
| `contracts/oracles/StatelessWrapper/PendleLinearDiscountOracleWrapper.sol` | pass-through behaviour |
| `contracts/interfaces/IPPYLpOracle.sol` | `PendleOracleType` enum ordering used to decode `baseOracleType` |

`CLAUDE.md` in the Pendle repo documents `forge build -C <subfolder> --sizes
--via-ir` as the build command. **No build was performed**: this phase reads
Pendle source to transcribe formulas, and Foundry is not installed in this
environment (`forge`/`cast` absent). Nothing in this phase depends on compiling
Pendle. Recorded here so the omission is explicit rather than silent.

---

## 2. Deployed contracts — verified source

Identified by probing the deployed contract for the getters unique to each shape
(`scripts/phase5/lib/oracle-probe.js`) and cross-checked against verified source
from the Blockscout API. Contract *names* below come from verified source, not
from bytecode heuristics or naming conventions.

| Contract | Author / origin | Compiler | Role |
| --- | --- | --- | --- |
| `MorphoChainlinkOracleV2` | Morpho | — | Adapter Morpho reads. Composes up to 4 Chainlink-shaped feeds plus 2 ERC-4626 vault conversions into the `1e36` price. |
| `MetaOracleDeviationTimelock` | Steakhouse Financial | `v0.8.28+commit.7893614a` | Primary/backup selector with a deviation threshold and challenge/healing timelocks. Behind an EIP-1167 minimal proxy; implementation `0xcC319eF091BC520cf6835565826212024B2D25EC` (also `0x9B4655239E91dc9E1f7599bB88FBA41B4542de5B`). |
| `OjoPTFeed` | Ojo | `v0.8.22+commit.4fc1097e` | Reports `min(FEED_1, FEED_2)` with a 24 h staleness revert on either leg. Behind an EIP-1167 proxy; implementation `0x5AAb95E3C6F9bA0CCfa0a17c2C7235633C7C6585`. |
| `PendleChainlinkOracle` | Pendle | — | Implied-rate TWAP feed over `PendlePYOracleLib`. |
| `PendleSparkLinearDiscountOracle` | Pendle | — | Deterministic linear-discount feed. Reads no market state. |
| `PendleLinearDiscountOracleWrapper` | Pendle | — | Thin pass-through over a linear-discount oracle. |

`OjoPTFeed` source, quoted because the aggregation direction is load-bearing for
the falsification results:

```solidity
if (answer1 <= answer2) {
    return (roundId1, answer1, startedAt1, updatedAt1, answeredInRound1);
} else {
    return (roundId2, answer2, startedAt2, updatedAt2, answeredInRound2);
}
```

and its staleness guard:

```solidity
uint256 public constant STALENESS_THRESHOLD = 24 hours;
...
if (updatedAt1 != 0 && block.timestamp - updatedAt1 > STALENESS_THRESHOLD) {
    revert StaleOracleData(updatedAt1, STALENESS_THRESHOLD);
}
```

`MetaOracleDeviationTimelock.price()`, quoted because it shows the meta-oracle
does **not** clamp a displaced primary — it only governs the eventual switch:

```solidity
function price() public view returns (uint256) {
    try currentOracle.price() returns (uint256 currentPrice) {
        return currentPrice;
    } catch {
        if (isPrimary()) {
            return backupOracle.price();
        } else {
            return primaryOracle.price();
        }
    }
}
```

---

## 3. Read-only data sources

| Source | Endpoint | Used for |
| --- | --- | --- |
| Morpho Blue indexer | `https://blue-api.morpho.org/graphql` | Market **discovery only** (market ids, LLTV, IRM, assets, TVL). Every oracle claim is re-derived on-chain. |
| Blockscout (Ethereum) | `https://eth.blockscout.com/api/v2/smart-contracts/{address}` | Verified contract names, compiler versions, EIP-1167 implementation resolution |
| Public Ethereum RPC | `ethereum-rpc.publicnode.com`, `eth.merkle.io`, `eth.drpc.org`, `rpc.mevblocker.io`, `eth-mainnet.public.blastapi.io` | `eth_call`, `eth_blockNumber` |

Endpoint notes:

- `cloudflare-eth.com` was tried first and returned HTTP 403 / internal errors
  for `eth_call`; it is excluded from the fallback list.
- The RPC helper (`scripts/phase5/lib/rpc.js`) exposes only `eth_call` and
  `eth_blockNumber`. It has no signer, no key material, and no
  `eth_sendTransaction` / `eth_sendRawTransaction` path — read-only is enforced
  by the surface of the module, not by convention.

Reproduce the reconnaissance artifact with:

```sh
node scripts/phase5/scan-morpho-pt-markets.js --top 66
```

Output is committed at `research/data/morpho-pt-markets.json`, including the
chain head heights the reads were served at.

---

## 4. UNKNOWN

Items that could not be established from source or read-only calls, and are not
inferred anywhere in this phase:

- **Non-Ethereum verified source.** Blockscout verified-source lookup was used
  for Ethereum only. Contracts on Monad, HyperEVM, Arbitrum, Base, Katana and
  Unichain were classified by on-chain getter probing alone. The *shape* is
  therefore `FACT` (the getters exist and return consistent values); the
  *contract name and exact compiler* on those chains is `UNKNOWN`.
- **`ChainlinkAggregator` internals.** Quote-side feeds (e.g. USDC/USD) are
  identified as Chainlink-shaped aggregators. Their aggregator implementations,
  node sets, deviation thresholds and heartbeats were not enumerated — they are
  not part of the PT price path.
- **Off-chain policy.** Whether any curator monitors these markets, how quickly
  `challenge()`/`acceptChallenge()` would in practice be called on a deviant
  primary, and what the Ojo feed's off-chain update cadence is. The on-chain
  parameters are recorded; the operational behaviour is `UNKNOWN`.
- **PT redemption edge cases.** Whether any specific SY in these markets can
  fail to honour 1:1 asset redemption at maturity (SY insolvency). The
  `syIndex < pyIndex` haircut path in `PendlePYOracleLib` is modelled, but no
  live SY was found in that state, so the behaviour under it is untested against
  live data.
- **`MetaOracleDeviationTimelock` governance.** Who can call `initialize`, and
  whether any observed instance has non-default primary/backup wiring beyond
  what was read. Ownership/upgrade authority was not enumerated.

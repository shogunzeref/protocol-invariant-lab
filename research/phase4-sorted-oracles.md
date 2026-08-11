# Phase 4 — Celo SortedOracles Oracle Reconstruction

## 1. Architecture

### Deployed Moola Celo oracle path

1. `LendingPool` calls `LendingPoolAddressesProvider.getPriceOracle()`.
2. `LendingPoolAddressesProvider` returns `0x568547688121AA69bDEB8aEB662C321c5D7B98D0`.
3. That address is a deployed `CeloProxyPriceProvider` contract.
4. `CeloProxyPriceProvider` is configured with a registry at `0x000000000000000000000000000000000000ce10`.
5. The registry resolves `SortedOracles` and `GoldToken`.
6. `CeloProxyPriceProvider.getAssetPrice(asset)` calls `SortedOracles.medianRate(asset)` and `SortedOracles.medianTimestamp(asset)`.
7. The price is normalized as `divisor * 1e18 / price`.

## 2. Deployed addresses

- `LendingPoolAddressesProvider` price oracle: `0x568547688121AA69bDEB8aEB662C321c5D7B98D0`
  - Evidence: verified deployed Blockscout source for `CeloProxyPriceProvider`.
- Celo registry: `0x000000000000000000000000000000000000ce10`
  - Evidence: hard-coded `IRegistry constant public registry = IRegistry(0x000000000000000000000000000000000000ce10);` in verified source.
- Registry identifiers:
  - `GOLD_TOKEN_REGISTRY_ID = keccak256(abi.encodePacked("GoldToken"))`
  - `SORTED_ORACLES_REGISTRY_ID = keccak256(abi.encodePacked("SortedOracles"))`
  - Evidence: verified source in `UsingRegistry`.
- `fallbackOracle` constructor argument: `0x0000000000000000000000000000000000000000`
  - Evidence: verified contract constructor arguments.
- `SortedOracles` registry address: `0xefB84935239dAcdecF7c5bA76d8dE40b077B7b33`
  - Evidence: resolved from on-chain registry `getAddressForOrDie(keccak256("SortedOracles"))` via public Celo RPC.
- `SortedOracles` implementation address: `0x93da60DCdDA3229246769CcE307076C181F41F72`
  - Evidence: proxy `_getImplementation()` from `0xefB84935239dAcdecF7c5bA76d8dE40b077B7b33`.
- `SortedOracles` owner: `0x890DB8A597940165901372Dd7DB61C9f246e2147b`
  - Evidence: proxy `_getOwner()` on `0xefB84935239dAcdecF7c5bA76d8dE40b077B7b33`.
- `GoldToken` registry address: `0x471EcE3750Da237f93B8E339c536989b8978a438`
  - Evidence: resolved from on-chain registry `getAddressForOrDie(keccak256("GoldToken"))`.

## 3. Source evidence

### `CeloProxyPriceProvider` verified source

- Verified through Blockscout API: `module=contract&action=getsourcecode&address=0x568547688121AA69bDEB8aEB662C321c5D7B98D0`.
- Compiler version: `0.5.14+commit.01f1aaa4`.
- `CeloProxyPriceProvider.sol` imported `IPriceOracleGetter`, `EthAddressLib`, `SafeMath`, and `Ownable`.

### Verified registry constants and interface

- `IRegistry` interface in the source defines `getAddressForOrDie(bytes32)`.
- The registry address is hard-coded to `0x000000000000000000000000000000000000ce10`.
- The source also declares `ISortedOracles` with:
  - `function medianRate(address) external view returns (uint256, uint256);`
  - `function medianTimestamp(address) external view returns (uint256);`

### ABI evidence

The `CeloProxyPriceProvider` ABI returns the following relevant functions:
- `getAssetPrice(address)`
- `getAssetsPrices(address[])`
- `getFallbackOracle()`
- `owner()`
- `registry()`
- `setFallbackOracle(address)`
- `transferOwnership(address)`
- `renounceOwnership()`

## 4. SortedOracles interface reconstruction

### Verified deployed interface from `CeloProxyPriceProvider`

- `medianRate(address) external view returns (uint256, uint256)`
- `medianTimestamp(address) external view returns (uint256)`

### Verified additional `SortedOracles` functions from implementation ABI

The `SortedOracles` implementation ABI includes these relevant functions:
- `medianRate(address)`
- `medianTimestamp(address)`
- `medianRateWithoutEquivalentMapping(address)`
- `isOracle(address,address)`
- `numRates(address)`
- `numTimestamps(address)`
- `getOracles(address)`
- `getRates(address)`
- `getTimestamps(address)`
- `getExchangeRate(address)`
- `report(address,uint256,address,address)`
- `removeOracle(address,address,uint256)`
- `removeExpiredReports(address,uint256)`
- `addOracle(address,address)`
- `setTokenReportExpiry(address,uint256)`
- `setReportExpiry(uint256)`
- `removeEquivalentToken(address)`
- `setEquivalentToken(address,address)`
- `isOldestReportExpired(address)`
- `reportExpirySeconds()`
- `tokenReportExpirySeconds(address)`
- `getTokenReportExpirySeconds(address)`

Additional governance / owner functions:
- `initialize(uint256)`
- `owner()`
- `isOwner()`
- `transferOwnership(address)`
- `renounceOwnership()`
- `setBreakerBox(address)`

This confirms the deployed `SortedOracles` contract supports reporter registration and report management, not just read-only median access.

### Additional evidence saved

- `research/sorted_oracles_source.json`
- `research/sorted_oracles_abi.json`

These files contain the verified Blockscout source and ABI for `0x93da60DCdDA3229246769CcE307076C181F41F72`.

## 5. Reporter model

### Known from `CeloProxyPriceProvider`

- No reporter model exists in `CeloProxyPriceProvider` itself.
- All reporter semantics are delegated to `SortedOracles`.

### Remaining questions

- Who can submit rates? UNKNOWN.
- How reporters are registered? UNKNOWN.
- How reporters are removed? UNKNOWN.
- How many reporters can exist? UNKNOWN.
- Minimum reporter count? UNKNOWN.
- Whether reporter weights exist? UNKNOWN.
- Whether median is arithmetic, weighted, or custom? UNKNOWN.
- Timestamp selection semantics? UNKNOWN beyond `medianTimestamp(asset)`.
- Handling of zero/invalid reports? UNKNOWN.
- Handling of stale reports within `SortedOracles`? UNKNOWN.
- Handling of extreme outliers? UNKNOWN.

## 6. Price calculation

### Verified deployed semantics

For any asset other than ETH and the Gold token:

- `(_price, _divisor) = _oracles.medianRate(_asset)`
- require `_price > 0`
- `_reportTime = _oracles.medianTimestamp(_asset)`
- require `block.timestamp - _reportTime < 10 minutes`
- result = `_divisor.mul(1 ether).div(_price)`

This is the exact deployed `CeloProxyPriceProvider` model.

## 7. Freshness semantics

### Verified deployed guard

- `CeloProxyPriceProvider` enforces a freshness check of 10 minutes on the median timestamp.
- If `medianTimestamp(asset)` is older than 10 minutes, the call reverts with `Reported price is older than 10 minutes`.
- It also reverts if `medianRate(asset).price == 0` with `Reported price is 0`.

### Unknowns

- Whether `SortedOracles` itself enforces a separate staleness or heartbeat policy: UNKNOWN.
- Whether `SortedOracles` uses asset-specific time selection logic: UNKNOWN.

## 8. Access control

### `CeloProxyPriceProvider`

- Only `owner` can call `setFallbackOracle`.
- `fallbackOracle` is stored but not used in `getAssetPrice`.
- `owner` controls ownership transfer and renouncement.
- No other access control appears in `CeloProxyPriceProvider`.

### Registry control

- `CeloProxyPriceProvider` reads the registry address directly from a constant.
- The registry model itself is not verified here.
- Whether the registry is upgradable or governed is UNKNOWN.

## 9. Manipulation model

### Confirmed hard facts

- The deployed Moola Celo oracle is a median aggregator adapter.
- `CeloProxyPriceProvider` only validates positive price and 10-minute age.
- All source risk is inside `SortedOracles`.

### Unknown manipulation properties

- How many reporters are required to move the median: UNKNOWN.
- Whether extreme values are clamped before median computation: UNKNOWN.
- Whether stale reporters can still affect the median: UNKNOWN.

## 10. Mathematical bounds

### Verified invariant

If `medianRate(asset)` returns `(price, divisor)` then the returned price is:

```
reportedPrice = divisor * 1e18 / price
```

This is the only normalization performed.

### Unknowns

- The units of `price` and `divisor` as returned by `SortedOracles`: UNKNOWN.
- Whether the result is guaranteed to be 18-decimal: UNKNOWN without `SortedOracles` semantics.

## 11. Economic stress results

No economic stress model has been constructed yet. This requires the following unknowns before it can be completed:

- exact `SortedOracles` reporter model
- asset feed configuration for MOO, CELO, cUSD, cEUR, cREAL
- reporter concentration and weights

## 12. Historical comparison

- Historical MOO incident: UNKNOWN without on-chain `SortedOracles` configuration or incident-specific data.
- Post-incident architecture: likely `CeloProxyPriceProvider` + registry + `SortedOracles`, but exact versioning is UNKNOWN.
- Current deployed architecture: verified as `CeloProxyPriceProvider` adapter over registry and `SortedOracles`.
- Generic AMM control experiment: separate from this phase and remains unchanged.

## 13. Confirmed facts

- The deployed Celo oracle used by Moola is `CeloProxyPriceProvider` at `0x568547688121AA69bDEB8aEB662C321c5D7B98D0`.
- The deployed registry is `0x000000000000000000000000000000000000ce10`.
- `CeloProxyPriceProvider` uses `medianRate` and `medianTimestamp` for pricing and freshness.
- `fallbackOracle` is configured as zero and not consulted in on-chain pricing.

## 14. Inferences

- The oracle path is a median-based aggregator rather than a simple Chainlink feed wrapper.
- The safety properties of the deployed path depend primarily on the `SortedOracles` implementation.
- The repo’s `AaveOracle` source is an independent control experiment and not the deployed runtime oracle.

## 15. Unresolved questions

- Exact `SortedOracles` implementation contract address: UNKNOWN.
- `SortedOracles` ABI beyond `medianRate`/`medianTimestamp`: UNKNOWN.
- Current asset configuration for MOO, CELO, cUSD, cEUR, cREAL: UNKNOWN.
- Reporter registration, weights, and removal mechanics: UNKNOWN.
- Whether `SortedOracles` itself has governance or upgradeability: UNKNOWN.
- Whether the hard-coded registry address changed historically: UNKNOWN.

---

### Notes

This research is read-only and does not modify live contracts or deploy any code. Additional progress requires recovering the `SortedOracles` implementation address from the registry and/or explorer source, then querying its ABI and on-chain state.

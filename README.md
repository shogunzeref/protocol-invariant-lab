# moola-invariant-lab

Local-only research lab. No live protocol, no mainnet fork, no real funds,
no flash loan, no atomic attacker contract anywhere in this repo. Built
against a hand-copied, standalone-compiled subset of moola-v2's actual
Aave-V2-fork contracts (LendingPool, ReserveLogic/ValidationLogic/
GenericLogic, AToken/debt tokens, LendingPoolConfigurator), plus a
minimal constant-product AMM and an AMM-sourced price oracle written for
this lab (`contracts/lab/`).

## Why the toolchain looks unusual

- moola-v2's own dependencies are 2021-era (buidler/hardhat/waffle) and
  don't resolve cleanly on modern Node -- this project uses a fresh
  Hardhat 2.x + ethers v6 setup instead, with only the needed `.sol`
  files copied in.
- The sandbox this was built in can't reach `binaries.soliditylang.org`
  or a live RPC node (network is allow-listed to package registries and
  GitHub only), so compilation goes through the npm-distributed `solc`
  package directly via `scripts/compile.js`, bypassing Hardhat's own
  compiler downloader. This also means `LendingPool`'s external library
  links (`ReserveLogic`, `ValidationLogic` -> `GenericLogic`) are resolved
  by hand in `test/lib/deploy-stack.js::deployFrom`, since that linking
  normally happens inside Hardhat's own compile pipeline.

## Setup

```
npm install
node scripts/compile.js      # writes artifacts/ from contracts/
npx hardhat test --no-compile
```

(`--no-compile` skips Hardhat's own compile task, which would otherwise
try to download a compiler binary the sandbox can't reach. `artifacts/`
is already committed here so `npm install` + `npx hardhat test
--no-compile` should work standalone once dependencies are installed.)

`npm test` runs the same command. `npm run compile` regenerates
`artifacts/`.

## Phase 5: Pendle PT collateral in Morpho Blue

Phase 5 is a different shape from the Moola phases: instead of a local
Solidity stack, it reconstructs the *actual live* oracle architecture of
66 Morpho Blue markets that use Pendle PT as collateral, and tests
whether the PT/Morpho valuation mismatch is economically exploitable.

Read-only throughout -- `eth_call`, `eth_blockNumber` and a public
GraphQL indexer. No transaction, no position, no deployable exploit;
the models are plain JavaScript with no on-chain counterpart.

- `research/phase5-morpho-pendle.md` -- the main report (start here).
- `research/morpho-pendle-market-map.md` -- per-market reconnaissance,
  generated from the scan artifact.
- `research/phase5-morpho-pendle-sources.md` -- provenance: repos,
  commits, compiler versions, endpoints, and what could not be verified.
- `models/` -- `pendle-amm.js` (a port of Pendle's `MarketMathCore`,
  validated against 23 live oracle answers to <=3.6e-5),
  `pendle-pt-valuation.js`, `morpho-market.js`, `pt-displacement-cost.js`,
  `pt-recursive-leverage.js`, `phase5-scenarios.js`.
- `scripts/phase5/` -- the read-only scanner, the experiment driver, and
  the market-map renderer (`npm run phase5:scan`,
  `npm run phase5:experiments`, `npm run phase5:market-map`).
- `research/data/` -- generated artifacts. Regenerating the scan requires
  network access; the experiments and the market map run offline from it.

Headline result: the hypothesis is **not supported**. Morpho does
transmit oracle price into borrow capacity with elasticity exactly 1, but
a PT price cannot be pushed far enough to exploit it -- near maturity
because a PT cannot be priced above par, and long-dated because Pendle's
96% proportion cap binds first. See section 14 for the falsification of
each hypothesis, and section 11 for the one concern that survives
(liquidation depth relative to the PT's own Pendle pool).

## What each test file does

- `test/oracle-manipulation.js` -- first pass. Uses a directly-settable
  mock oracle (`mocks/oracle/PriceOracle.sol`, from moola-v2 itself) to
  show that IF collateral price can be moved, borrow power moves with
  it 1:1. This only proves "if the oracle lies, bad things happen" --
  it does not show the oracle *can* be made to lie without a privileged
  call.

- `test/oracle-sweep.js` -- same mock oracle, swept across price
  multipliers (1.0x-50x), with a revert-to-honest-price step that
  quantifies protocol shortfall (bad debt) as a function of price
  displacement, rather than a single hand-picked multiplier.

- `test/amm-manipulation.js` -- closes the "privileged mock" gap.
  Replaces the settable oracle with `contracts/lab/AMMSourcedPriceOracle.sol`,
  which has NO settable price at all -- its only price source is
  `contracts/lab/SimpleAMMPair.sol`, a real (if minimal) constant-product
  pool. Shows an unprivileged actor moving the lending pool's own borrow
  limit purely via an ordinary swap against a thin pool.

- `test/unwind-settle.js` -- full attacker lifecycle (acquire STABLE ->
  swap into COLL -> deposit as collateral -> borrow -> unwind swap ->
  settle), with attacker P&L and protocol shortfall computed against an
  INDEPENDENT reference price ($1.00), never the manipulated price --
  otherwise the accounting can make the attacker look profitable purely
  because the inflated price is used as both the attack mechanism and
  the valuation basis.

- `test/sweep.js` -- the same lifecycle swept across AMM liquidity depth
  (10k/50k/200k), LTV (60/70/75%), and attack capital (2k-160k), using
  `evm_snapshot`/`evm_revert` to reuse one deployment per (liquidity,
  LTV) pair instead of redeploying per grid point. Also computes an
  analytical flash-loan-financing overlay (fee-adjusted P&L, and
  whether the flash loan would even be repayable within one
  transaction) WITHOUT an actual flash-loan contract.

## Current status / what this does NOT establish

This is a validated model of a vulnerability CLASS (AMM-derived,
manipulation-resistance-free collateral oracles in Aave-V2-shaped
lending pools), run entirely against mock tokens and a hand-written AMM.
It is explicitly not yet a finding about any specific live protocol --
that would require reconstructing the real deployment's actual current
oracle architecture (TWAP? deviation limits? SortedOracles
aggregation?), actual current risk parameters, and actual current
market liquidity, none of which this repo does or is intended to do.

## Directory guide

- `contracts/protocol/`, `contracts/interfaces/`, `contracts/dependencies/`,
  `contracts/mocks/` -- copied from moolamarket/moola-v2 (Aave V2 fork).
- `contracts/lab/` -- written for this lab (`SimpleAMMPair.sol`,
  `AMMSourcedPriceOracle.sol`).
- `contracts/hardhat/console.sol` -- stub replacing the real
  `hardhat/console.sol` import (avoids pulling in the full Hardhat
  console dependency for one debug import in
  `DefaultReserveInterestRateStrategy.sol`).
- `scripts/compile.js` -- standalone solc-based compiler (see above).
- `test/lib/deploy-stack.js` -- shared deployment helper, parameterized
  by AMM liquidity depth and LTV.

# protocol-invariant-lab

A research lab for testing **collateral-valuation invariants in DeFi lending
protocols** — specifically, what happens to a lending market's solvency when the
price it uses to value collateral can be moved by someone who is not privileged
to move it.

The lab is organised as a sequence of phases, each one closing a gap in the
previous one's argument. Phases 1–4 build a *local* Aave-V2-shaped lending stack
(from moola-v2's actual contracts) and demonstrate the vulnerability class
end-to-end against a real AMM-sourced oracle. Phase 5 turns the same questions on
a *live* architecture — Pendle Principal Tokens used as collateral in Morpho Blue
— and reaches the opposite conclusion, for reasons worth reading.

Two rules hold throughout:

- **Nothing live is ever written to.** No transaction, no position, no mainnet
  fork, no real funds. Phase 5's contact with mainnet is read-only `eth_call`.
- **The attacker is never valued at their own manipulated price.** P&L and
  protocol shortfall are always computed against an independent reference price.
  Skipping this is the easiest way to manufacture a fake finding: the inflated
  price ends up used as both the attack mechanism *and* the valuation basis, and
  any position looks profitable.

## Results so far

| | Question | Answer |
| --- | --- | --- |
| **1** | If a collateral oracle lies, does borrow power follow? | Yes, 1:1 — but this assumes a privileged setter, so it proves nothing on its own. |
| **2** | How much bad debt per unit of price displacement? | Quantified as a curve, not a single hand-picked multiplier. |
| **3** | Can an *unprivileged* actor move borrow power with no settable oracle at all? | **Yes** — an ordinary swap against a thin constant-product pool does it. |
| **4** | Does the attacker actually profit after unwinding, at independent prices? | Yes at some (liquidity, LTV, capital) points; a flash-loan overlay shows where financing is even repayable. |
| **5** | Does the same reasoning break Pendle PT collateral in live Morpho Blue markets? | **No — falsified.** The mechanism is real, but the required price displacement is unreachable. |

Phase 5's negative result is the more interesting one, and the reason it's
negative is specific rather than reassuring: see
[`research/phase5-morpho-pendle.md`](research/phase5-morpho-pendle.md).

## Setup

```sh
npm install
node scripts/compile.js        # writes artifacts/ from contracts/
npm test                       # = hardhat test --no-compile  (74 tests)
```

`npm test` must stay on `--no-compile`: plain `hardhat test` tries to download a
compiler binary from `binaries.soliditylang.org`, which this lab was built
without access to. `artifacts/` is committed, so `npm install` + `npm test`
works standalone.

### Why the toolchain looks unusual

- moola-v2's own dependencies are 2021-era (buidler/hardhat/waffle) and don't
  resolve on modern Node, so this uses a fresh Hardhat 2.x + ethers v6 setup with
  only the needed `.sol` files copied in.
- Compilation goes through the npm-distributed `solc` package directly via
  `scripts/compile.js`, bypassing Hardhat's compiler downloader. A consequence:
  `LendingPool`'s external library links (`ReserveLogic`, `ValidationLogic` →
  `GenericLogic`) are resolved by hand in
  `test/lib/deploy-stack.js::deployFrom`, since that linking normally happens
  inside Hardhat's compile pipeline.

## Phases 1–4: AMM-derived collateral oracles (local Solidity)

Built against a hand-copied, standalone-compiled subset of moola-v2's actual
Aave-V2-fork contracts (`LendingPool`, `ReserveLogic`/`ValidationLogic`/
`GenericLogic`, `AToken`/debt tokens, `LendingPoolConfigurator`), plus a minimal
constant-product AMM and an AMM-sourced oracle written for this lab
(`contracts/lab/`).

- **`test/oracle-manipulation.js`** — first pass. A directly-settable mock oracle
  (`mocks/oracle/PriceOracle.sol`, from moola-v2 itself) shows that *if*
  collateral price moves, borrow power moves with it 1:1. This only establishes
  "if the oracle lies, bad things happen" — not that it *can* be made to lie
  without a privileged call.
- **`test/oracle-sweep.js`** — the same mock oracle swept across price
  multipliers (1.0x–50x), with a revert-to-honest-price step that turns protocol
  shortfall into a function of displacement rather than one anecdote.
- **`test/amm-manipulation.js`** — closes the privileged-mock gap. Replaces the
  settable oracle with `contracts/lab/AMMSourcedPriceOracle.sol`, which has **no
  settable price at all**: its only source is `contracts/lab/SimpleAMMPair.sol`, a
  real (if minimal) constant-product pool. An unprivileged actor moves the
  lending pool's own borrow limit purely by swapping.
- **`test/unwind-settle.js`** — the full attacker lifecycle (acquire STABLE → swap
  into COLL → deposit as collateral → borrow → unwind swap → settle), with P&L
  and shortfall computed against an independent $1.00 reference.
- **`test/sweep.js`** — that lifecycle swept across AMM depth (10k/50k/200k), LTV
  (60/70/75%) and attack capital (2k–160k), using `evm_snapshot`/`evm_revert` to
  reuse one deployment per (liquidity, LTV) pair. Includes an *analytical*
  flash-loan financing overlay — fee-adjusted P&L and whether the loan would be
  repayable atomically — with no flash-loan contract in the repo.

**What phases 1–4 do not establish.** This is a validated model of a
vulnerability *class* — manipulation-resistance-free, AMM-derived collateral
oracles in Aave-V2-shaped pools — run against mock tokens and a hand-written AMM.
It is deliberately not a finding about any live deployment: that requires the real
deployment's actual oracle architecture, risk parameters and market depth. Which
is exactly what Phase 5 does.

## Phase 5: Pendle PT collateral in Morpho Blue (live architecture, read-only)

Different shape from the earlier phases. There is no local Solidity stack here —
the target is live mainnet code, so Phase 5 reconstructs the **actual deployed
oracle trees** of 66 Morpho Blue markets that use Pendle PT as collateral, across
6 chains, and does the economics in local JavaScript models. Read-only
throughout: `eth_call`, `eth_blockNumber` and a public GraphQL indexer.

**The mechanism is real.** Morpho's `IOracle.price()` is collateral-in-loan-token
scaled by `1e36`, and capacity is exactly linear in it — elasticity 1, with no
buffer between the borrow check and the liquidation check, because both use the
single market `lltv`:

```
maxBorrow = collateral * price / 1e36 * lltv
```

**The exploit still isn't reachable**, and *which* constraint stops it depends on
maturity — that's the finding the report is organised around:

```
insolvency needs         P_displaced / P > 1/lltv    →  5.82% at lltv 94.5%
the par ceiling allows   1/P - 1                     →  10.79% at 365d, 0.03% at 1d
the Pendle curve allows  ~2.0%                       →  ptProportion cap ~96%,
                                                        independent of capital
```

Near maturity `P → 1`, so the par ceiling alone ends it (`MarketMathCore` reverts
with `MarketExchangeRateBelowOne`). Long-dated, `P` can sit *below* the LLTV with
no credit event at all — 0.9026 at a 365d horizon on the anchor market, under both
91.5% and 94.5% — so the par ceiling stops being a defence and Pendle's curve
proportion cap is what actually binds. Across the 720-row stress surface
(distortion × maturity × liquidity × LLTV × loop depth): **0 profitable attacker
rows, 0 protocol shortfall**, and 504 of 576 non-zero displacement targets
unreachable on the curve.

**What survives.** Liquidation depth. Unwinding PT is capped by its own Pendle
pool and the discount grows with position share — 26bp at 1% of the pool, 52bp at
20%. At tested sizes that stays inside the liquidation incentive
(`LIF = min(1.15, 1/(1 - 0.3*(1-lltv)))`, ~255bp of margin at 91.5% LLTV), but
the ratio of Morpho collateral to Pendle pool depth is the thing to monitor. It's
reported as a real discount, not as an attack.

### Reading order

1. [`research/phase5-morpho-pendle.md`](research/phase5-morpho-pendle.md) — the
   main report, 20 sections. Every claim is tagged `FACT` / `INFERENCE` /
   `HYPOTHESIS` / `UNKNOWN`; section 14 is the falsification of each hypothesis.
2. [`research/morpho-pendle-market-map.md`](research/morpho-pendle-market-map.md)
   — per-market reconnaissance for all 66 markets, generated from the scan.
3. [`research/phase5-morpho-pendle-sources.md`](research/phase5-morpho-pendle-sources.md)
   — provenance: repos, commit hashes, compiler versions, endpoints, and what
   could **not** be verified.

### Phase 5 layout

- `models/` — `pendle-amm.js` (a port of Pendle's `MarketMathCore`),
  `pendle-pt-valuation.js`, `morpho-market.js`, `pt-displacement-cost.js`,
  `pt-recursive-leverage.js`, `phase5-scenarios.js`.
- `scripts/phase5/` — the read-only scanner, the experiment driver, the
  market-map renderer.
- `research/data/` — generated artifacts (`morpho-pt-markets.json`,
  `phase5-results.json`, and a stress-surface CSV).
- `test/phase5/` — 65 tests, including `falsification.js` (hypotheses A–E),
  `regime-boundary.js` (which constraint binds where) and
  `invariant-comparison.js` (this vs. AMM spot manipulation, donation attacks,
  ERC-4626 inflation, stale oracles).

```sh
npm run phase5:experiments   # offline, from the committed scan artifact
npm run phase5:market-map    # offline, regenerates the market map
npm run phase5:scan          # the only script that needs network
```

The models use JavaScript doubles rather than Solidity fixed-point integers, so
`models/pendle-amm.js` is **validated against live oracle answers** — max relative
error 3.6e-5, guarded by `test/phase5/pendle-amm-port.js`. That validation is the
load-bearing assumption under every cost number above.

### Stated limitations

9 of the 66 oracle paths terminate in external feeds whose implementation could
not be verified (their `description()` strings are quoted as self-reported, not
confirmed). `forge`/`cast` were unavailable, so no differential fuzzing against
Pendle's Solidity was possible. Router-specific reserve-fee overrides, off-chain
MetaOracle keeper behaviour, cross-market correlated stress, and alternative
liquidator venues are all unmodelled. See section 18 of the report.

## Directory guide

| Path | Origin |
| --- | --- |
| `contracts/protocol/`, `contracts/interfaces/`, `contracts/dependencies/`, `contracts/mocks/` | copied from moolamarket/moola-v2 (Aave V2 fork) |
| `contracts/lab/` | written for this lab (`SimpleAMMPair.sol`, `AMMSourcedPriceOracle.sol`) |
| `contracts/hardhat/console.sol` | stub replacing the real `hardhat/console.sol` import, for one debug import in `DefaultReserveInterestRateStrategy.sol` |
| `scripts/compile.js` | standalone solc-based compiler (see above) |
| `test/lib/deploy-stack.js` | shared deployment helper, parameterized by AMM depth and LTV |
| `models/`, `scripts/phase5/`, `test/phase5/`, `research/` | Phase 5, written for this lab |

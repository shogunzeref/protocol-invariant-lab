// Local-only. No live protocol, no mainnet fork, no real funds.
//
// This is deliberately NOT a "does the mock oracle lying break things" test
// -- that's trivially true of any oracle-dependent system and proves
// nothing about exploitability. This test instead:
//
//   1. Establishes baseline: honest price -> collateral value -> borrow
//      limit, checked against the configured collateral factor (70% LTV).
//   2. Sweeps a range of price perturbations (1.0x .. 50x) and records,
//      at each point: reported collateral value, allowed borrow, health
//      factor, and actual STABLE extracted.
//   3. Computes the ECONOMIC CONSEQUENCE: after the attacker extracts
//      STABLE at the manipulated price, revert the oracle to the honest
//      baseline price and check whether the attacker's remaining
//      collateral actually covers what they borrowed. The gap is real,
//      uncollateralized protocol loss -- not merely "a number went up."
//
// What this test explicitly does NOT yet establish: whether an
// unprivileged actor can cause the *real* price feed to move this way.
// setAssetPrice() on this mock is a stand-in for "a price source that can
// be moved" and demonstrates protocol-side consequence, not oracle-side
// manipulability. That's a separate, harder question (see note at the
// bottom) that requires a real AMM-derived price, not a settable mock.

const { expect } = require("chai");
const { ethers } = require("hardhat");

function artifact(name) {
  const [sourcePath, contractName] = name.split(":");
  return require(`../artifacts/contracts/${sourcePath}/${contractName}.json`);
}

function linkBytecode(bytecodeHex, linkReferences, libraryAddresses) {
  let code = bytecodeHex.slice(2);
  for (const [, libs] of Object.entries(linkReferences)) {
    for (const [libName, occurrences] of Object.entries(libs)) {
      const addr = libraryAddresses[libName];
      if (!addr) throw new Error(`No deployed address provided for library ${libName}`);
      const addrHex = addr.replace(/^0x/, "").toLowerCase();
      for (const { start, length } of occurrences) {
        const from = start * 2;
        const to = from + length * 2;
        code = code.slice(0, from) + addrHex + code.slice(to);
      }
    }
  }
  return "0x" + code;
}

async function deployFrom(deployerSigner, artifactPath, args = [], libraryAddresses = {}) {
  const art = artifact(artifactPath);
  const bytecode = Object.keys(art.linkReferences || {}).length
    ? linkBytecode(art.bytecode, art.linkReferences, libraryAddresses)
    : art.bytecode;
  const factory = new ethers.ContractFactory(art.abi, bytecode, deployerSigner);
  const c = await factory.deploy(...args);
  await c.waitForDeployment();
  return c;
}

function attachAt(artifactPath, address, signer) {
  const art = artifact(artifactPath);
  return new ethers.Contract(address, art.abi, signer);
}

const RAY = 10n ** 27n;
const eth = (n) => ethers.parseEther(String(n));
const fmt = (n) => Number(ethers.formatEther(n)).toFixed(2);

describe("Oracle price sweep: baseline vs. manipulability vs. economic consequence", function () {
  let deployer, attacker;
  let addressesProvider, configurator, pool, priceOracle;
  let collateralToken, borrowToken;

  async function freshDeployment() {
    [deployer, attacker] = await ethers.getSigners();

    addressesProvider = await deployFrom(deployer, "protocol/configuration/LendingPoolAddressesProvider.sol:LendingPoolAddressesProvider", ["moola-invariant-lab"]);

    const genericLogicLib = await deployFrom(deployer, "protocol/libraries/logic/GenericLogic.sol:GenericLogic");
    const reserveLogicLib = await deployFrom(deployer, "protocol/libraries/logic/ReserveLogic.sol:ReserveLogic");
    const validationLogicLib = await deployFrom(deployer, "protocol/libraries/logic/ValidationLogic.sol:ValidationLogic", [], {
      GenericLogic: await genericLogicLib.getAddress(),
    });
    const poolImpl = await deployFrom(deployer, "protocol/lendingpool/LendingPool.sol:LendingPool", [], {
      ReserveLogic: await reserveLogicLib.getAddress(),
      ValidationLogic: await validationLogicLib.getAddress(),
    });
    await (await addressesProvider.setLendingPoolImpl(await poolImpl.getAddress())).wait();
    pool = attachAt("protocol/lendingpool/LendingPool.sol:LendingPool", await addressesProvider.getLendingPool(), deployer);

    const configuratorImpl = await deployFrom(deployer, "protocol/lendingpool/LendingPoolConfigurator.sol:LendingPoolConfigurator");
    await (await addressesProvider.setLendingPoolConfiguratorImpl(await configuratorImpl.getAddress())).wait();
    configurator = attachAt("protocol/lendingpool/LendingPoolConfigurator.sol:LendingPoolConfigurator", await addressesProvider.getLendingPoolConfigurator(), deployer);

    priceOracle = await deployFrom(deployer, "mocks/oracle/PriceOracle.sol:PriceOracle");
    await (await addressesProvider.setPriceOracle(await priceOracle.getAddress())).wait();
    const rateOracle = await deployFrom(deployer, "mocks/oracle/LendingRateOracle.sol:LendingRateOracle");
    await (await addressesProvider.setLendingRateOracle(await rateOracle.getAddress())).wait();
    await (await addressesProvider.setPoolAdmin(deployer.address)).wait();

    collateralToken = await deployFrom(deployer, "mocks/tokens/MintableERC20.sol:MintableERC20", ["Thin Liquidity Collateral", "COLL", 18]);
    borrowToken = await deployFrom(deployer, "mocks/tokens/MintableERC20.sol:MintableERC20", ["Deep Liquidity Stable", "STABLE", 18]);

    const aTokenImpl = await deployFrom(deployer, "protocol/tokenization/AToken.sol:AToken");
    const stableDebtImpl = await deployFrom(deployer, "protocol/tokenization/StableDebtToken.sol:StableDebtToken");
    const variableDebtImpl = await deployFrom(deployer, "protocol/tokenization/VariableDebtToken.sol:VariableDebtToken");
    const rateStrategy = await deployFrom(deployer, "protocol/lendingpool/DefaultReserveInterestRateStrategy.sol:DefaultReserveInterestRateStrategy", [
      await addressesProvider.getAddress(),
      (RAY * 80n) / 100n, 0n, (RAY * 4n) / 100n, (RAY * 75n) / 100n, (RAY * 2n) / 100n, (RAY * 75n) / 100n,
    ]);

    const zero = ethers.ZeroAddress;
    const tokens = [collateralToken, borrowToken];
    const initInputs = [];
    for (let i = 0; i < tokens.length; i++) {
      initInputs.push({
        aTokenImpl: await aTokenImpl.getAddress(),
        stableDebtTokenImpl: await stableDebtImpl.getAddress(),
        variableDebtTokenImpl: await variableDebtImpl.getAddress(),
        underlyingAssetDecimals: 18,
        interestRateStrategyAddress: await rateStrategy.getAddress(),
        underlyingAsset: await tokens[i].getAddress(),
        treasury: deployer.address,
        incentivesController: zero,
        underlyingAssetName: i === 0 ? "COLL" : "STABLE",
        aTokenName: i === 0 ? "aCOLL" : "aSTABLE",
        aTokenSymbol: i === 0 ? "aCOLL" : "aSTABLE",
        variableDebtTokenName: i === 0 ? "vdCOLL" : "vdSTABLE",
        variableDebtTokenSymbol: i === 0 ? "vdCOLL" : "vdSTABLE",
        stableDebtTokenName: i === 0 ? "sdCOLL" : "sdSTABLE",
        stableDebtTokenSymbol: i === 0 ? "sdCOLL" : "sdSTABLE",
        params: "0x10",
      });
    }
    await (await configurator.batchInitReserve(initInputs)).wait();
    await (await configurator.configureReserveAsCollateral(await collateralToken.getAddress(), 7000, 7500, 10500)).wait();
    await (await configurator.enableBorrowingOnReserve(await borrowToken.getAddress(), false)).wait();

    await (await priceOracle.setAssetPrice(await collateralToken.getAddress(), eth(1))).wait();
    await (await priceOracle.setAssetPrice(await borrowToken.getAddress(), eth(1))).wait();

    await (await borrowToken.mint(eth(1000000))).wait();
    await (await borrowToken.approve(await pool.getAddress(), ethers.MaxUint256)).wait();
    await (await pool.deposit(await borrowToken.getAddress(), eth(1000000), deployer.address, 0)).wait();
  }

  it("BASELINE: honest price -> collateral value -> borrow limit matches configured 70% LTV", async function () {
    await freshDeployment();

    await (await collateralToken.connect(attacker).mint(eth(1000))).wait();
    await (await collateralToken.connect(attacker).approve(await pool.getAddress(), ethers.MaxUint256)).wait();
    await (await pool.connect(attacker).deposit(await collateralToken.getAddress(), eth(1000), attacker.address, 0)).wait();

    const data = await pool.getUserAccountData(attacker.address);
    const expected = eth(700); // 1000 COLL @ $1 * 70% LTV
    const diff = data.availableBorrowsETH > expected ? data.availableBorrowsETH - expected : expected - data.availableBorrowsETH;
    console.log(`\n    BASELINE  collateral=1000 COLL @ $1.00  ->  collateral value=$1000.00  borrow limit=$${fmt(data.availableBorrowsETH)}`);
    expect(diff <= eth(1)).to.equal(true);
  });

  it("SWEEP + ECONOMIC CONSEQUENCE: borrow power and post-hoc solvency across price multipliers", async function () {
    const multipliers = [1.0, 1.1, 1.5, 2, 5, 10, 50];
    console.log("\n    mult   price    coll.value   borrowLimit   extracted    HF-after    debt-after-revert   real-coll-after-revert   shortfall(bad debt)");

    for (const mult of multipliers) {
      await freshDeployment();

      await (await collateralToken.connect(attacker).mint(eth(1000))).wait();
      await (await collateralToken.connect(attacker).approve(await pool.getAddress(), ethers.MaxUint256)).wait();
      await (await pool.connect(attacker).deposit(await collateralToken.getAddress(), eth(1000), attacker.address, 0)).wait();

      // Step 1: push price to mult * $1 (the "manipulability" stand-in)
      const manipulatedPrice = ethers.parseEther(mult.toString());
      await (await priceOracle.setAssetPrice(await collateralToken.getAddress(), manipulatedPrice)).wait();

      const afterManip = await pool.getUserAccountData(attacker.address);
      const collateralValue = eth(1000 * mult);
      const borrowLimit = afterManip.availableBorrowsETH;

      // Step 2: attacker borrows up to ~99% of the limit (leave a hair of
      // margin so the borrow() call itself doesn't revert on rounding)
      const borrowAmount = (borrowLimit * 99n) / 100n;
      let extracted = 0n;
      if (borrowAmount > 0n) {
        await (await pool.connect(attacker).borrow(await borrowToken.getAddress(), borrowAmount, 2, 0, attacker.address)).wait();
        extracted = await borrowToken.balanceOf(attacker.address);
      }
      const hfAfterBorrow = (await pool.getUserAccountData(attacker.address)).healthFactor;

      // Step 3: revert price to the HONEST baseline ($1) -- this is the
      // economic-consequence step. If the manipulated price was a
      // transient AMM distortion (as in both the Moola and Venus
      // incidents), this is what the protocol's books look like once the
      // market reverts to reality.
      await (await priceOracle.setAssetPrice(await collateralToken.getAddress(), eth(1))).wait();
      const afterRevert = await pool.getUserAccountData(attacker.address);
      const realCollateralValueAfterRevert = eth(1000); // 1000 COLL @ honest $1
      const debtAfterRevert = afterRevert.totalDebtETH;
      const shortfall = debtAfterRevert > realCollateralValueAfterRevert ? debtAfterRevert - realCollateralValueAfterRevert : 0n;

      console.log(
        `    ${String(mult).padEnd(5)}  $${mult.toFixed(2).padEnd(6)} ` +
        ` $${fmt(collateralValue).padEnd(10)} ` +
        ` $${fmt(borrowLimit).padEnd(10)} ` +
        ` $${fmt(extracted).padEnd(9)} ` +
        ` ${(Number(hfAfterBorrow) / 1e18).toFixed(2).padEnd(9)} ` +
        ` $${fmt(debtAfterRevert).padEnd(10)} ` +
        ` $${fmt(realCollateralValueAfterRevert).padEnd(10)} ` +
        ` $${fmt(shortfall)}`
      );

      // The invariant we actually care about: at honest baseline (1.0x),
      // there must be NO shortfall -- the system is solvent by
      // construction there. Above 1.0x, growing shortfall as multiplier
      // increases is the quantified bad-debt signature.
      if (mult === 1.0) {
        expect(shortfall).to.equal(0n);
      }
    }
  });
});

// --- Note on the manipulability gap this test does not yet close ---
// Everything above uses priceOracle.setAssetPrice() directly, which is
// privileged in the real Aave/Moola architecture (only the pool admin's
// configured oracle source can update it) -- so as written, this sweep
// still only proves "IF the price feed can be pushed, THEN there is
// uncollateralized loss," parametrized instead of a single point.
//
// To close the actual manipulability question, the next step is to
// replace PriceOracle's direct setAssetPrice() with a price DERIVED from
// a real, locally-deployed constant-product AMM pair (thin liquidity),
// and show that an unprivileged actor's own swap sequence -- not a direct
// oracle call -- moves that derived price by the same multipliers. That
// closes the "we told it to lie" vs. "it can be made to lie" gap and is
// the natural next build.

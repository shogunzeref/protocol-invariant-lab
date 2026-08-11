// Local-only invariant test. No live protocol, no mainnet fork, no real funds.
//
// Reconstructs the bug CLASS behind:
//   - Moola's historical MOO/CELO incident (moola-fix repo references a
//     Ubeswap-sourced price for the mCELO/MOO pool)
//   - Venus Protocol's March 2026 THE-market exploit (donation attack +
//     thin-liquidity price manipulation inflated collateral value, letting
//     the attacker borrow far more than their real economic collateral)
//
// The invariant under test:
//   borrow power extended against collateral must track the collateral's
//   REAL, hard-to-manipulate value -- not a single spot price with no
//   deviation/staleness/manipulation resistance.
//
// This harness proves the negative case on a bare-bones Aave-V2-derived
// pool (which is what moola-v2 is) using a freely-settable mock oracle to
// stand in for "a price source an attacker can move" (e.g. a thin AMM
// pool). It deliberately has NO caps/TWAP/deviation protection, so it
// should demonstrate the vulnerability class clearly.

const { expect } = require("chai");
const { ethers } = require("hardhat");

function artifact(name) {
  const [sourcePath, contractName] = name.split(":");
  return require(`../artifacts/contracts/${sourcePath}/${contractName}.json`);
}

// Generic linker: replaces __$<placeholder>$__ library markers in bytecode
// with a deployed library's address, using solc's own linkReferences offsets
// (byte offset -> hex-string offset is *2, plus 2 for the "0x" prefix).
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
const eth = (n) => ethers.parseEther(n);

describe("Oracle price manipulation -> borrow power invariant", function () {
  let deployer, attacker;
  let addressesProvider, configurator, pool, priceOracle, rateOracle;
  let collateralToken, borrowToken;

  before(async function () {
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
    const poolProxyAddress = await addressesProvider.getLendingPool();
    pool = attachAt("protocol/lendingpool/LendingPool.sol:LendingPool", poolProxyAddress, deployer);

    const configuratorImpl = await deployFrom(deployer, "protocol/lendingpool/LendingPoolConfigurator.sol:LendingPoolConfigurator");
    await (await addressesProvider.setLendingPoolConfiguratorImpl(await configuratorImpl.getAddress())).wait();
    const configuratorProxyAddress = await addressesProvider.getLendingPoolConfigurator();
    configurator = attachAt("protocol/lendingpool/LendingPoolConfigurator.sol:LendingPoolConfigurator", configuratorProxyAddress, deployer);

    priceOracle = await deployFrom(deployer, "mocks/oracle/PriceOracle.sol:PriceOracle");
    await (await addressesProvider.setPriceOracle(await priceOracle.getAddress())).wait();

    rateOracle = await deployFrom(deployer, "mocks/oracle/LendingRateOracle.sol:LendingRateOracle");
    await (await addressesProvider.setLendingRateOracle(await rateOracle.getAddress())).wait();

    await (await addressesProvider.setPoolAdmin(deployer.address)).wait();

    collateralToken = await deployFrom(deployer, "mocks/tokens/MintableERC20.sol:MintableERC20", ["Thin Liquidity Collateral", "COLL", 18]);
    borrowToken = await deployFrom(deployer, "mocks/tokens/MintableERC20.sol:MintableERC20", ["Deep Liquidity Stable", "STABLE", 18]);

    const aTokenImpl = await deployFrom(deployer, "protocol/tokenization/AToken.sol:AToken");
    const stableDebtImpl = await deployFrom(deployer, "protocol/tokenization/StableDebtToken.sol:StableDebtToken");
    const variableDebtImpl = await deployFrom(deployer, "protocol/tokenization/VariableDebtToken.sol:VariableDebtToken");

    const rateStrategy = await deployFrom(deployer, "protocol/lendingpool/DefaultReserveInterestRateStrategy.sol:DefaultReserveInterestRateStrategy", [
      await addressesProvider.getAddress(),
      (RAY * 80n) / 100n,
      0n,
      (RAY * 4n) / 100n,
      (RAY * 75n) / 100n,
      (RAY * 2n) / 100n,
      (RAY * 75n) / 100n,
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

    await (await priceOracle.setAssetPrice(await collateralToken.getAddress(), eth("1"))).wait();
    await (await priceOracle.setAssetPrice(await borrowToken.getAddress(), eth("1"))).wait();

    await (await borrowToken.mint(eth("1000000"))).wait();
    await (await borrowToken.approve(await pool.getAddress(), ethers.MaxUint256)).wait();
    await (await pool.deposit(await borrowToken.getAddress(), eth("1000000"), deployer.address, 0)).wait();

    await (await collateralToken.connect(attacker).mint(eth("1000"))).wait();
    await (await collateralToken.connect(attacker).approve(await pool.getAddress(), ethers.MaxUint256)).wait();
    await (await pool.connect(attacker).deposit(await collateralToken.getAddress(), eth("1000"), attacker.address, 0)).wait();
  });

  it("baseline: borrow power matches real collateral value at honest price", async function () {
    const data = await pool.getUserAccountData(attacker.address);
    const expected = eth("700");
    const tolerance = eth("1");
    const diff = data.availableBorrowsETH > expected ? data.availableBorrowsETH - expected : expected - data.availableBorrowsETH;
    expect(diff <= tolerance).to.equal(true);
  });

  it("INVARIANT VIOLATION: manipulating the price oracle inflates borrow power with zero new real collateral", async function () {
    const before = await pool.getUserAccountData(attacker.address);

    await (await priceOracle.setAssetPrice(await collateralToken.getAddress(), eth("50"))).wait();

    const after = await pool.getUserAccountData(attacker.address);

    console.log(`    available borrows before manipulation: ${ethers.formatEther(before.availableBorrowsETH)}`);
    console.log(`    available borrows after 50x price push: ${ethers.formatEther(after.availableBorrowsETH)}`);

    expect(after.availableBorrowsETH > before.availableBorrowsETH * 10n).to.equal(true);

    const borrowAmount = eth("30000");
    await (await pool.connect(attacker).borrow(await borrowToken.getAddress(), borrowAmount, 2, 0, attacker.address)).wait();

    const attackerStableBalance = await borrowToken.balanceOf(attacker.address);
    console.log(`    STABLE extracted by attacker: ${ethers.formatEther(attackerStableBalance)}`);

    expect(attackerStableBalance >= borrowAmount).to.equal(true);
  });
});

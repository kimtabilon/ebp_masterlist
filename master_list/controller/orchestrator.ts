/**
 * Pipeline Orchestrator (EBP-17)
 *
 * Replaces the monolithic generateProdLIst() with a stage-based system.
 * Each stage has a name, execution function, optional validation, and
 * a flag indicating whether failure should halt the pipeline.
 *
 * Features:
 * - Ordered stage execution with per-stage timing
 * - Output validation after each stage
 * - Halts on critical failure with clear error (stage name + reason)
 * - Produces structured run summary via PipelineRunCollector
 * - Supports starting from a specific stage (EBP-18 prep)
 */

import { performance } from "perf_hooks";
import axios from "axios";

import { getDb } from "../config/mongdodb.config";
import { log, logStageStart, logStageComplete, logStageError, logStageSkipped, logValidationResult, logPipelineSummary } from "../utils/logger";

import downloadRaw from "./download_raw";
import { runSynnex } from "./process_raw/synnex_parse";
import { importAlmoRaw } from "./process_raw/almoRawInsert";
import { runIngram } from "./process_raw/ingramRawInsert";
import { runDandH } from "./process_raw/dandhRawInsert";
import { runSupplies } from "./process_raw/suppliesNetRawInsert";
import { runMergeSuperFast } from "./combineData";
import { exportSameSkuToXlsx } from "./filter/same_sku";
import { exportSameUpcToXlsx } from "./filter/duplicate_upc";
import { insertAllNullManufacturerMapSkus } from "./filter/null_man_map";
import { exportNullUpcToXlsx } from "./filter/null_upc";
import { buildGroupedUpcData } from "./filter";
import { buildSynnexResponseTable } from "./responseGather/synnexResponse.controller";
import { buildIngramResponseTable } from "./responseGather/ingramResponse.controller";
import { buildDandHResponseTable } from "./responseGather/dandhResponse.controller";
import { buildSuppliesNetworkResponseTable } from "./responseGather/suppliesNetwork.controller";
import buildAlmoResponseTable from "./responseGather/almoResponseGather";
import { buildProductListStreaming } from "./build_prod/productPipeline";
import { processBundlesMongo } from "./sku_packed";

import { validateProductList, promoteProductList, rollbackProductList } from "./validation/validateProductList";
import { diffProductList } from "./validation/diffProductList";
import { PipelineRunCollector, StageMetric } from "./validation/pipelineRunLog";
import { sendPipelineAlert } from "./validation/alerting";

// ============================================================
// Stage definition
// ============================================================

interface PipelineStage {
    name: string;
    execute: () => Promise<any>;
    validate?: () => Promise<{ ok: boolean; detail: string }>;
    critical: boolean; // if true, failure halts the pipeline
}

// ============================================================
// Stage validation helpers
// ============================================================

async function collectionHasDocs(collectionName: string, minDocs = 1): Promise<{ ok: boolean; detail: string }> {
    const db = await getDb("master_list");
    const count = await db.collection(collectionName).countDocuments();
    return {
        ok: count >= minDocs,
        detail: `${collectionName}: ${count.toLocaleString()} docs ${count >= minDocs ? "✅" : `❌ (need >= ${minDocs})`}`,
    };
}

async function allCollectionsHaveDocs(names: string[]): Promise<{ ok: boolean; detail: string }> {
    const results: string[] = [];
    let allOk = true;
    const db = await getDb("master_list");

    for (const name of names) {
        const count = await db.collection(name).countDocuments();
        const ok = count > 0;
        if (!ok) allOk = false;
        results.push(`${name}: ${count.toLocaleString()} ${ok ? "✅" : "❌"}`);
    }

    return { ok: allOk, detail: results.join(" | ") };
}

// ============================================================
// Stage definitions
// ============================================================

function defineStages(): PipelineStage[] {
    return [
        {
            name: "downloadRaw",
            execute: () => downloadRaw(),
            critical: true,
        },
        {
            name: "parallelImports",
            execute: async () => {
                const importResults = await Promise.allSettled([
                    runSynnex(),
                    importAlmoRaw(),
                    runIngram(),
                    runDandH(),
                    runSupplies(),
                ]);

                const names = ["Synnex", "Almo", "Ingram", "D&H", "Supplies"];
                const failures: string[] = [];
                importResults.forEach((r, i) => {
                    if (r.status === "rejected") {
                        console.error(`❌ ${names[i]} import FAILED:`, r.reason);
                        failures.push(names[i]);
                    }
                });

                if (failures.length > 0) {
                    console.warn(`⚠️ Distributor imports failed: ${failures.join(", ")} — continuing with available data`);
                }
            },
            validate: () => allCollectionsHaveDocs([
                "dist_synnex_raw", "dist_dandh_raw", "dist_ingram_raw",
                "dist_supplies_raw", "dist_almo_raw",
            ]),
            critical: true,
        },
        {
            name: "mergeAndNormalize",
            execute: () => runMergeSuperFast(),
            validate: () => collectionHasDocs("dist_combined_raw", 1000),
            critical: true,
        },
        {
            name: "filters",
            execute: async () => {
                await exportSameSkuToXlsx();
                await exportSameUpcToXlsx();
                await insertAllNullManufacturerMapSkus();
                await exportNullUpcToXlsx();
                await buildGroupedUpcData();
            },
            validate: () => collectionHasDocs("grouped_upc_data", 100),
            critical: true,
        },
        {
            name: "responseTableBuilds",
            execute: async () => {
                const responseResults = await Promise.allSettled([
                    buildSynnexResponseTable(),
                    buildIngramResponseTable(),
                    buildDandHResponseTable(),
                    buildSuppliesNetworkResponseTable(),
                    buildAlmoResponseTable(),
                ]);

                const names = ["Synnex", "Ingram", "D&H", "Supplies", "Almo"];
                const failures: string[] = [];
                responseResults.forEach((r, i) => {
                    if (r.status === "rejected") {
                        console.error(`❌ ${names[i]} response table build FAILED:`, r.reason);
                        failures.push(names[i]);
                    }
                });

                if (failures.length > 0) {
                    console.error(`⚠️ Response table builds failed: ${failures.join(", ")} — continuing with available data`);
                }
            },
            validate: () => allCollectionsHaveDocs([
                "synnex_response_table", "dandh_response_table",
                "ingram_response_table", "supplies_response_table",
                "almo_response_table",
            ]),
            critical: false, // continue even if some distributors fail
        },
        {
            name: "buildProductList",
            execute: async () => {
                // Preserve previous product_list
                const db = await getDb("master_list");
                try {
                    await db.admin().command({
                        renameCollection: `${db.databaseName}.product_list`,
                        to: `${db.databaseName}.product_list_previous`,
                        dropTarget: true,
                    });
                    console.log("✅ Preserved current product_list as product_list_previous");
                } catch {
                    console.log("ℹ️ No existing product_list to preserve");
                }

                await buildProductListStreaming();
                await processBundlesMongo();
            },
            validate: () => collectionHasDocs("product_list", 1000),
            critical: true,
        },
        {
            name: "validateAndPromote",
            execute: async () => {
                const validation = await validateProductList();

                console.log("--- VALIDATION RESULTS ---");
                for (const check of validation.checks) {
                    console.log(`  ${check.passed ? "✅" : "❌"} ${check.name}: ${check.detail}`);
                }

                if (!validation.passed) {
                    await rollbackProductList();
                    await sendPipelineAlert({ type: "validation_failed", validation });
                    throw new Error(`Validation failed: ${validation.checks.filter(c => !c.passed).map(c => c.name).join(", ")}`);
                }

                const diff = await diffProductList();

                console.log("--- DIFF SUMMARY ---");
                console.log(`  Added: ${diff.added} | Removed: ${diff.removed}`);
                console.log(`  Price changes: ${diff.priceChanges} | Inventory swings: ${diff.inventorySwings}`);
                console.log(`  Distributor changes: ${diff.distributorChanges}`);

                if (diff.removed > 5000 || diff.priceChanges > 1000) {
                    await sendPipelineAlert({ type: "anomaly_detected", diff,
                        error: `Anomalous diff: ${diff.removed} products removed, ${diff.priceChanges} price changes`
                    });
                }

                await promoteProductList();

                return { validation, diff };
            },
            critical: true,
        },
        {
            name: "webhooks",
            execute: async () => {
                if (process.env.DB_NAME_OVERRIDE) {
                    console.log("⏭️  Skipping webhooks (running against test DB)");
                    return;
                }

                await Promise.all([
                    axios.get("https://console.ecommercebusinessprime.com/api/marketplace/updateInventory")
                        .then(() => console.log("✅ Webhook: updateInventory sent"))
                        .catch((err: any) => console.error("❌ Webhook: updateInventory failed:", err?.message)),
                    axios.get("https://console.ecommercebusinessprime.com/api/marketplace/updateWalmartInventory")
                        .then(() => console.log("✅ Webhook: updateWalmartInventory sent"))
                        .catch((err: any) => console.error("❌ Webhook: updateWalmartInventory failed:", err?.message)),
                    axios.post("https://console.ecommercebusinessprime.com/api/newegg/updateInventory")
                        .then(() => console.log("✅ Webhook: updateNeweggInventory sent"))
                        .catch((err: any) => console.error("❌ Webhook: updateNeweggInventory failed:", err?.message)),
                ]);
            },
            critical: false, // webhook failures shouldn't fail the pipeline
        },
    ];
}

// ============================================================
// Orchestrator
// ============================================================

export interface OrchestratorOptions {
    startFromStage?: string; // stage name to resume from
}

export async function runPipeline(options?: OrchestratorOptions): Promise<void> {
    const stages = defineStages();
    const startFromStage = options?.startFromStage;
    const isResumed = !!startFromStage;
    const runLog = new PipelineRunCollector({
        resumed: isResumed,
        resumedFromStage: startFromStage,
    });

    logPipelineSummary("started", 0, stages.length, {
        resumed: isResumed,
        ...(startFromStage ? { resumedFromStage: startFromStage } : {}),
    });

    // Validate startFromStage exists
    if (startFromStage && !stages.find(s => s.name === startFromStage)) {
        const error = `Unknown stage "${startFromStage}". Valid stages: ${stages.map(s => s.name).join(", ")}`;
        await runLog.persist({ status: "failed", error });
        throw new Error(error);
    }

    let skipping = isResumed;
    let lastResult: any = null;
    const pipelineStart = performance.now();

    for (const stage of stages) {
        if (skipping) {
            if (stage.name === startFromStage) {
                log("info", "pipeline", "Validating prior stages before resume...");
                const priorStages = stages.slice(0, stages.indexOf(stage));
                for (const prior of priorStages) {
                    if (prior.validate) {
                        const check = await prior.validate();
                        logValidationResult("resume", prior.name, check.ok, check.detail);
                        if (!check.ok && prior.critical) {
                            const error = `Cannot resume from "${startFromStage}" — prior stage "${prior.name}" output is invalid: ${check.detail}`;
                            await runLog.persist({ status: "failed", error });
                            throw new Error(error);
                        }
                    }
                }
                log("info", "pipeline", "Prior stages validated");
                skipping = false;
                log("info", "pipeline", `Resuming at stage: ${stage.name}`);
            } else {
                logStageSkipped(stage.name, "before resume point");
                continue;
            }
        }

        logStageStart(stage.name);
        const startTime = performance.now();
        const startHeap = process.memoryUsage().heapUsed;

        try {
            lastResult = await stage.execute();

            const durationSec = parseFloat(((performance.now() - startTime) / 1000).toFixed(2));
            const heapDeltaMb = parseFloat(((process.memoryUsage().heapUsed - startHeap) / 1024 / 1024).toFixed(2));

            logStageComplete(stage.name, durationSec, heapDeltaMb);
            runLog.addStage({ name: stage.name, durationSec, heapDeltaMb });

            if (stage.validate) {
                const validation = await stage.validate();
                logValidationResult(stage.name, "output", validation.ok, validation.detail);

                if (!validation.ok) {
                    if (stage.critical) {
                        const error = `Stage "${stage.name}" validation failed: ${validation.detail}`;
                        logStageError(stage.name, error);
                        await runLog.persist({ status: "failed", error });
                        await sendPipelineAlert({ type: "pipeline_error", error });
                        throw new Error(error);
                    } else {
                        log("warn", stage.name, "Validation failed but stage is non-critical — continuing");
                    }
                }
            }

        } catch (err: any) {
            const durationSec = parseFloat(((performance.now() - startTime) / 1000).toFixed(2));
            const heapDeltaMb = parseFloat(((process.memoryUsage().heapUsed - startHeap) / 1024 / 1024).toFixed(2));

            runLog.addStage({ name: stage.name, durationSec, heapDeltaMb });

            if (stage.critical) {
                const error = `Pipeline halted at stage "${stage.name}": ${err.message}`;
                logStageError(stage.name, error);
                await runLog.persist({ status: "failed", error }).catch(() => {});
                await sendPipelineAlert({ type: "pipeline_error", error }).catch(() => {});
                throw new Error(error);
            } else {
                log("warn", stage.name, `Stage failed but non-critical — continuing: ${err.message}`);
            }
        }
    }

    const totalDurationSec = parseFloat(((performance.now() - pipelineStart) / 1000).toFixed(2));
    const validation = lastResult?.validation ?? null;
    const diff = lastResult?.diff ?? null;
    await runLog.persist({ status: "success", validation, diff });

    logPipelineSummary("completed", totalDurationSec, runLog["stages"].length, {
        resumed: isResumed,
    });
}

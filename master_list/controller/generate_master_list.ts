import { buildProductList } from "./build_prod/productPipeline"
import { buildGroupedUPCData, runMergeSuperFast } from "./combineData"
import downloadRaw from "./download_raw"
import { buildGroupedUpcData } from "./filter"
import { exportSameUpcToXlsx } from "./filter/duplicate_upc"
import { insertAllNullManufacturerMapSkus } from "./filter/null_man_map"
import { exportNullUpcToXlsx } from "./filter/null_upc"
import { exportSameSkuToXlsx } from "./filter/same_sku"
import { importAlmoRaw } from "./process_raw/almoRawInsert"
import { runDandH } from "./process_raw/dandhRawInsert"
import { runIngram } from "./process_raw/ingramRawInsert"
import { runSupplies } from "./process_raw/suppliesNetRawInsert"
import { runSynnex } from "./process_raw/synnex_parse"
import { fixMissingCategoriesFastko } from "./prod_category/catv2"
import { fixMissingCategoriesFast } from "./prod_category/missingcategoryUpdate"
import buildAlmoResponseTable from "./responseGather/almoResponseGather"
import { buildDandHResponseTable } from "./responseGather/dandhResponse.controller"
import { buildIngramResponseTable } from "./responseGather/ingramResponse.controller"
import { buildSuppliesNetworkResponseTable } from "./responseGather/suppliesNetwork.controller"
import { buildSynnexResponseTable } from "./responseGather/synnexResponse.controller"
import { processBundlesMongo } from "./sku_packed"
import { syncMongoToMysql } from "./sync_master"
import { validateProductList, promoteProductList, rollbackProductList } from "./validation/validateProductList"
import { diffProductList } from "./validation/diffProductList"
import { PipelineRunCollector } from "./validation/pipelineRunLog"
import { sendPipelineAlert } from "./validation/alerting"

import { getDb } from "../config/mongdodb.config";

import { performance } from "perf_hooks";

import axios from "axios";

export async function testIngram() {
    try {
      await runIngram().catch(err => console.error("Ingram error:", err));
    } catch (e: any) {
        return (e)
    }
}

export async function testParallelRun() {
    try {
      await measure("parallel response table builds", async () => {
        const results = await Promise.all([
          buildSynnexResponseTable().catch(err => ({ error: err, name: "Synnex" })),
          buildIngramResponseTable().catch(err => ({ error: err, name: "Ingram" })),
          buildDandHResponseTable().catch(err => ({ error: err, name: "D&H" })),
          buildSuppliesNetworkResponseTable().catch(err => ({ error: err, name: "Supplies" })),
          buildAlmoResponseTable().catch(err => ({ error: err, name: "Almo" })),
        ]);

        results.forEach(r => {
          if ("error" in r) console.error(`${r.name} failed:`, r.error);
        });
      });

      console.log("========= DONE TESTING ==================")
    } catch (e: any) {
        return (e)
    }
}

export async function generateProdLIst() {
    const runLog = new PipelineRunCollector();

    try {
        await measure("downloadRaw", () => downloadRaw(), runLog);

        await measure("parallel imports", async () => {
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
            throw new Error(`Pipeline aborted — distributor imports failed: ${failures.join(", ")}`);
          }
        }, runLog);

        await measure("runMergeSuperFast", () => runMergeSuperFast(), runLog);

        await measure("exportSameSkuToXlsx", () => exportSameSkuToXlsx(), runLog);
        await measure("exportSameUpcToXlsx", () => exportSameUpcToXlsx(), runLog);
        await measure("insertAllNullManufacturerMapSkus", () =>
          insertAllNullManufacturerMapSkus()
        , runLog);
        await measure("exportNullUpcToXlsx", () => exportNullUpcToXlsx(), runLog);
        await measure("buildGroupedUpcData", () => buildGroupedUpcData(), runLog);

        await measure("parallel response table builds", async () => {
          const responseResults = await Promise.allSettled([
            buildSynnexResponseTable(),
            buildIngramResponseTable(),
            buildDandHResponseTable(),
            buildSuppliesNetworkResponseTable(),
            buildAlmoResponseTable(),
          ]);

          const responseNames = ["Synnex", "Ingram", "D&H", "Supplies", "Almo"];
          const responseFailures: string[] = [];
          responseResults.forEach((r, i) => {
            if (r.status === "rejected") {
              console.error(`❌ ${responseNames[i]} response table build FAILED:`, r.reason);
              responseFailures.push(responseNames[i]);
            }
          });

          if (responseFailures.length > 0) {
            console.error(`⚠️ Response table builds failed: ${responseFailures.join(", ")} — continuing with available data`);
          }
        }, runLog);

        // Preserve current product_list as backup before rebuilding
        const db = await getDb("master_list");
        try {
            await db.admin().command({
                renameCollection: `${db.databaseName}.product_list`,
                to: `${db.databaseName}.product_list_previous`,
                dropTarget: true,
            });
            console.log("✅ Preserved current product_list as product_list_previous");
        } catch {
            console.log("ℹ️ No existing product_list to preserve (first run or already moved)");
        }

        await measure("buildProductList", () => buildProductList(), runLog);
        await measure("processBundlesMongo", () => processBundlesMongo(), runLog);

        // Validate the new product list before promoting
        const validation = await measure("validateProductList", () => validateProductList(), runLog);

        console.log("=================================================");
        console.log("VALIDATION RESULTS:");
        for (const check of validation.checks) {
            console.log(`  ${check.passed ? "✅" : "❌"} ${check.name}: ${check.detail}`);
        }
        console.log("=================================================");

        if (!validation.passed) {
            console.error("❌ Validation FAILED — rolling back to previous product list");
            await rollbackProductList();
            await runLog.persist({ status: "rolled_back", validation, error: "Validation failed" });
            await sendPipelineAlert({ type: "validation_failed", validation });
            throw new Error(`Product list validation failed: ${validation.checks.filter(c => !c.passed).map(c => c.name).join(", ")}`);
        }

        // Compute diff before dropping the backup (needs product_list_previous)
        const diff = await measure("diffProductList", () => diffProductList(), runLog);

        console.log("=================================================");
        console.log("RUN DIFF SUMMARY:");
        console.log(`  Added: ${diff.added} | Removed: ${diff.removed}`);
        console.log(`  Price changes: ${diff.priceChanges} | Inventory swings: ${diff.inventorySwings}`);
        console.log(`  Distributor changes: ${diff.distributorChanges}`);
        console.log("=================================================");

        // Alert on anomalous diff (large removals or widespread price changes)
        if (diff.removed > 5000 || diff.priceChanges > 1000) {
            await sendPipelineAlert({ type: "anomaly_detected", diff,
                error: `Anomalous diff: ${diff.removed} products removed, ${diff.priceChanges} price changes`
            });
        }

        // Validation passed — drop the backup
        await promoteProductList();

        await Promise.all([
            axios.get(`https://console.ecommercebusinessprime.com/api/marketplace/updateInventory`)
                .then(() => console.log("✅ Webhook: updateInventory sent"))
                .catch((err: any) => console.error("❌ Webhook: updateInventory failed:", err?.message)),
            axios.get(`https://console.ecommercebusinessprime.com/api/marketplace/updateWalmartInventory`)
                .then(() => console.log("✅ Webhook: updateWalmartInventory sent"))
                .catch((err: any) => console.error("❌ Webhook: updateWalmartInventory failed:", err?.message)),
            axios.post(`https://console.ecommercebusinessprime.com/api/newegg/updateInventory`)
                .then(() => console.log("✅ Webhook: updateNeweggInventory sent"))
                .catch((err: any) => console.error("❌ Webhook: updateNeweggInventory failed:", err?.message)),
        ]);

        // Persist successful run log
        await runLog.persist({ status: "success", validation, diff });
        
        /*await downloadRaw()
        await Promise.all([
            runSynnex(),
            importAlmoRaw(),
            runIngram(),
            runDandH(),
            runSupplies()
        ])
        await runMergeSuperFast()
        // await buildGroupedUPCData()
        await exportSameSkuToXlsx()
        await exportSameUpcToXlsx()
        await insertAllNullManufacturerMapSkus()
        await exportNullUpcToXlsx()
        await buildGroupedUpcData()
        await Promise.all([
            buildSynnexResponseTable(),
            buildIngramResponseTable(),
            buildDandHResponseTable(),
            buildSuppliesNetworkResponseTable(),
            buildAlmoResponseTable()
        ])
        await buildProductList()
        await fixMissingCategoriesFast()
        await fixMissingCategoriesFastko()
        await fixMissingCategoriesFast()
        await fixMissingCategoriesFastko()
        await processBundlesMongo()
        await syncMongoToMysql()*/
        return ("generateProdLIst1 DONE")
    } catch (e: any) {
        console.error("❌ [generateProdLIst] Pipeline failed:", e?.message || e);
        await runLog.persist({ status: "failed", error: e?.message || String(e) }).catch(() => {});
        await sendPipelineAlert({ type: "pipeline_error", error: e?.message || String(e) }).catch(() => {});
        throw e;
    }
}

async function measure<T>(name: string, fn: () => Promise<T>, runLog?: PipelineRunCollector): Promise<T> {
  console.log(`🚀 START: ${name}`);

  const startTime = performance.now();
  const startHeap = process.memoryUsage().heapUsed;

  const result = await fn();

  const endTime = performance.now();
  const endHeap = process.memoryUsage().heapUsed;

  const durationSec = parseFloat(((endTime - startTime) / 1000).toFixed(2));
  const heapDeltaMb = parseFloat(((endHeap - startHeap) / 1024 / 1024).toFixed(2));

  // Skip external log writes during tests (DB_NAME_OVERRIDE indicates test mode)
  if (!process.env.DB_NAME_OVERRIDE) {
    const logDb: any = await getDb("ebp_marketplace");
    const collection = logDb.collection("logs");

    collection.insertOne({
      from: 'masterlist',
      info: `✅ DONE: ${name} | ⏱ ${durationSec}s | Heap Δ ${heapDeltaMb} MB`,
      createdAt: new Date()
    });
  }

  console.log(
    `✅ DONE: ${name} | ⏱ ${durationSec}s | Heap Δ ${heapDeltaMb} MB`
  );

  if (runLog) {
    runLog.addStage({ name, durationSec, heapDeltaMb });
  }

  return result;
}
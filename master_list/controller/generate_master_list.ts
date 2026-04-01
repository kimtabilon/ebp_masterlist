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
    try {
        await measure("downloadRaw", () => downloadRaw());

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
        });

        await measure("runMergeSuperFast", () => runMergeSuperFast());
        // await measure("buildGroupedUPCData", () => buildGroupedUPCData());

        await measure("exportSameSkuToXlsx", () => exportSameSkuToXlsx());
        await measure("exportSameUpcToXlsx", () => exportSameUpcToXlsx());
        await measure("insertAllNullManufacturerMapSkus", () =>
          insertAllNullManufacturerMapSkus()
        );
        await measure("exportNullUpcToXlsx", () => exportNullUpcToXlsx());
        await measure("buildGroupedUpcData", () => buildGroupedUpcData());

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
        });

        await measure("buildProductList", () => buildProductList());

        // await measure("fixMissingCategoriesFast", () => fixMissingCategoriesFast());
        // await measure("fixMissingCategoriesFastko", () => fixMissingCategoriesFastko());
        // await measure("fixMissingCategoriesFast (again)", () => fixMissingCategoriesFast());
        // await measure("fixMissingCategoriesFastko (again)", () => fixMissingCategoriesFastko());
        await measure("processBundlesMongo", () => processBundlesMongo());

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
        throw e;
    }
}

async function measure<T>(name: string, fn: () => Promise<T>): Promise<T> {
  console.log(`🚀 START: ${name}`);

  const startTime = performance.now();
  const startHeap = process.memoryUsage().heapUsed;

  const result = await fn();

  const endTime = performance.now();
  const endHeap = process.memoryUsage().heapUsed;

  const duration = ((endTime - startTime) / 1000).toFixed(2);
  const heapDiff = ((endHeap - startHeap) / 1024 / 1024).toFixed(2);

  const db: any = await getDb("ebp_marketplace");
  const collection = db.collection("logs");

  collection.insertOne({
    from: 'masterlist',
    info: `✅ DONE: ${name} | ⏱ ${duration}s | Heap Δ ${heapDiff} MB`,
    createdAt: new Date()
  });

  console.log(
    `✅ DONE: ${name} | ⏱ ${duration}s | Heap Δ ${heapDiff} MB`
  );

  return result;
}
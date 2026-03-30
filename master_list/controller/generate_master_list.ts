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
          await Promise.all([
            runSynnex().catch(err => console.error("Synnex error:", err)),
            importAlmoRaw().catch(err => console.error("Almo error:", err)),
            runIngram().catch(err => console.error("Ingram error:", err)),
            runDandH().catch(err => console.error("D&H error:", err)),
            runSupplies().catch(err => console.error("Supplies error:", err)),
          ]);
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
          const results = await Promise.all([
            buildSynnexResponseTable().catch(err => ({ error: err, name: "Synnex" })),
            buildIngramResponseTable().catch(err => ({ error: err, name: "Ingram" })),
            buildDandHResponseTable().catch(err => ({ error: err, name: "D&H" })),
            buildSuppliesNetworkResponseTable().catch(err => ({ error: err, name: "Supplies" })),
            buildAlmoResponseTable().catch(err => ({ error: err, name: "Almo" })),
          ]);
        });

        await measure("buildProductList", () => buildProductList());

        // await measure("fixMissingCategoriesFast", () => fixMissingCategoriesFast());
        // await measure("fixMissingCategoriesFastko", () => fixMissingCategoriesFastko());
        // await measure("fixMissingCategoriesFast (again)", () => fixMissingCategoriesFast());
        // await measure("fixMissingCategoriesFastko (again)", () => fixMissingCategoriesFastko());
        await measure("processBundlesMongo", () => processBundlesMongo());

        axios.get(`https://console.ecommercebusinessprime.com/api/marketplace/updateInventory`);
        axios.get(`https://console.ecommercebusinessprime.com/api/marketplace/updateWalmartInventory`);
        axios.post(`https://console.ecommercebusinessprime.com/api/newegg/updateInventory`); 
        
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
        return (e)
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
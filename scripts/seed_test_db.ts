/**
 * Seed a test database (master_list_test) from production (master_list).
 *
 * What this does:
 * - READS from master_list (production) — no modifications
 * - WRITES to master_list_test (new database) — creates collections and inserts docs
 *
 * Strategy:
 * - Picks seed groups from grouped_upc_data as the "seed set"
 * - Seeds related data from response tables and raw collections that match those SKUs
 * - This ensures the test data is internally consistent (a product in grouped_upc_data
 *   will have matching entries in response tables and raw collections)
 *
 * Usage: npx tsx scripts/seed_test_db.ts
 */

process.env.mUser = "tempUserMasterlist";
process.env.pUser = "F4@zN!8qW2#Lp9$Xr6^tY3&m";

import { getDb } from "../master_list/config/mongdodb.config.js";

const SOURCE_DB = "master_list";
const TEST_DB = "master_list_test";
const SEED_GROUP_COUNT = 10000;

async function run() {
    try {
        const source = await getDb(SOURCE_DB);
        const test = await getDb(TEST_DB);

        console.log("========================================");
        console.log(`  SEEDING ${TEST_DB} FROM ${SOURCE_DB}`);
        console.log("========================================\n");

        // Step 1: Pick seed groups from grouped_upc_data
        const seedGroups = await source.collection("grouped_upc_data")
            .find({})
            .limit(SEED_GROUP_COUNT)
            .toArray();

        const normalizedSkus = new Set<string>();
        const rawSkus = new Set<string>();
        for (const g of seedGroups) {
            for (const s of (g.normalized_sku_list || [])) normalizedSkus.add(s);
            for (const s of (g.sku_list || [])) rawSkus.add(s);
        }

        const normalizedArr = [...normalizedSkus];
        const rawArr = [...rawSkus];
        console.log(`Seed set: ${normalizedArr.length} normalized SKUs, ${rawArr.length} raw SKUs\n`);

        // Step 2: Define what to seed
        const collections = [
            {
                name: "grouped_upc_data",
                getDocs: async () => seedGroups,
            },
            {
                name: "dist_combined_raw",
                getDocs: async () => source.collection("dist_combined_raw")
                    .find({ normalized_sku: { $in: normalizedArr } })
                    .limit(5000)
                    .toArray(),
            },
            // Response tables — query by normalized_sku
            ...["synnex_response_table", "dandh_response_table", "ingram_response_table",
                "supplies_response_table", "almo_response_table"].map(name => ({
                name,
                getDocs: async () => source.collection(name)
                    .find({ normalized_sku: { $in: normalizedArr } })
                    .toArray(),
            })),
            // Raw distributor collections — Synnex has normalized_sku, others use sku
            {
                name: "dist_synnex_raw",
                getDocs: async () => source.collection("dist_synnex_raw")
                    .find({ normalized_sku: { $in: normalizedArr } })
                    .toArray(),
            },
            ...["dist_dandh_raw", "dist_ingram_raw", "dist_supplies_raw", "dist_almo_raw"].map(name => ({
                name,
                getDocs: async () => source.collection(name)
                    .find({ sku: { $in: rawArr } })
                    .toArray(),
            })),
            // Filter tables — small sample, not SKU-dependent
            ...["filter_same_upc", "filter_null_upc", "filter_null_manufacturer", "custom_price"].map(name => ({
                name,
                getDocs: async () => source.collection(name)
                    .find({})
                    .limit(50)
                    .toArray(),
            })),
        ];

        // Step 3: Drop existing test collections and seed
        for (const col of collections) {
            await test.dropCollection(col.name).catch(() => {});

            const docs = await col.getDocs();

            if (docs.length > 0) {
                const cleanDocs = docs.map(({ _id, ...rest }: any) => rest);
                await test.collection(col.name).insertMany(cleanDocs);
            }

            console.log(`  ${col.name}: ${docs.length} docs`);
        }

        // Step 4: Create indexes
        console.log("\n--- Creating indexes ---");

        await test.collection("dist_synnex_raw").createIndex({ normalized_sku: 1 });
        await test.collection("dist_synnex_raw").createIndex({ sku: 1 });
        await test.collection("dist_dandh_raw").createIndex({ sku: 1 });
        await test.collection("dist_dandh_raw").createIndex({ d_h_sku: 1 });
        await test.collection("dist_ingram_raw").createIndex({ sku: 1 });
        await test.collection("dist_supplies_raw").createIndex({ sku: 1 });
        await test.collection("dist_almo_raw").createIndex({ sku: 1 });
        await test.collection("dist_combined_raw").createIndex({ normalized_sku: 1 });
        await test.collection("dist_combined_raw").createIndex({ normalized_upc: 1 });
        await test.collection("dist_combined_raw").createIndex({ sku: 1 });
        await test.collection("grouped_upc_data").createIndex({ normalized_sku_list: 1 });

        console.log("  ✅ Indexes created");

        // Step 5: Verify
        console.log("\n--- Verification ---");
        const testCollections = await test.listCollections().toArray();
        let totalDocs = 0;
        for (const col of testCollections.sort((a: any, b: any) => a.name.localeCompare(b.name))) {
            const count = await test.collection(col.name).countDocuments();
            totalDocs += count;
            console.log(`  ${col.name}: ${count} docs`);
        }

        console.log(`\n  Total: ${totalDocs} docs across ${testCollections.length} collections`);
        console.log("\n========================================");
        console.log(`  ✅ ${TEST_DB} READY`);
        console.log("========================================");

    } catch (err: any) {
        console.error("❌ Error:", err.message);
    }

    process.exit(0);
}

run();

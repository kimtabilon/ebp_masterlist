/**
 * EBP-16: Output parity test
 *
 * Runs both buildProductList (original) and buildProductListStreaming (new)
 * against master_list_test, then compares outputs field-by-field.
 *
 * Writes ONLY to master_list_test. Does NOT touch production.
 *
 * Usage: npx tsx scripts/test_parity.ts
 */

process.env.DB_NAME_OVERRIDE = "master_list_test";
process.env.mUser = "tempUserMasterlist";
process.env.pUser = "F4@zN!8qW2#Lp9$Xr6^tY3&m";

import { getDb } from "../master_list/config/mongdodb.config.js";
import { buildProductList, buildProductListStreaming } from "../master_list/controller/build_prod/productPipeline.js";

async function run() {
    const db = await getDb("master_list");

    console.log("========================================");
    console.log("  EBP-16: OUTPUT PARITY TEST");
    console.log(`  Database: ${db.databaseName}`);
    console.log("========================================\n");

    if (db.databaseName !== "master_list_test") {
        console.error("❌ SAFETY CHECK FAILED — not pointing at test DB. Aborting.");
        process.exit(1);
    }

    // Step 1: Run original build
    console.log(">>> Running ORIGINAL buildProductList...\n");
    const startOrig = Date.now();
    const originalResult = await buildProductList();
    const origTime = ((Date.now() - startOrig) / 1000).toFixed(1);
    console.log(`\nOriginal result: inserted=${originalResult.inserted}, total=${originalResult.total} (${origTime}s)\n`);

    // Snapshot the original output
    const originalDocs = await db.collection("product_list")
        .find({}, { projection: { _id: 0 } })
        .sort({ normalized_sku: 1 })
        .toArray();

    // Save original docs to a temp collection so we can compare after streaming build
    await db.dropCollection("_parity_original").catch(() => {});
    if (originalDocs.length > 0) {
        await db.collection("_parity_original").insertMany(originalDocs);
    }
    console.log(`Original product_list: ${originalDocs.length} docs (saved to _parity_original)\n`);

    // Step 2: Re-seed grouped_upc_data and response tables (streaming build reads from these)
    // They should still be intact since buildProductList only drops/recreates product_list

    // Step 3: Run streaming build (overwrites product_list)
    console.log(">>> Running STREAMING buildProductListStreaming...\n");
    const startStream = Date.now();
    const streamingResult = await buildProductListStreaming();
    const streamTime = ((Date.now() - startStream) / 1000).toFixed(1);
    console.log(`\nStreaming result: inserted=${streamingResult.inserted}, total=${streamingResult.total} (${streamTime}s)\n`);

    const streamingDocs = await db.collection("product_list")
        .find({}, { projection: { _id: 0 } })
        .sort({ normalized_sku: 1 })
        .toArray();

    console.log(`Streaming product_list: ${streamingDocs.length} docs\n`);

    // Step 4: Compare
    console.log("========================================");
    console.log("  COMPARISON");
    console.log("========================================\n");

    console.log(`Original count:  ${originalDocs.length}`);
    console.log(`Streaming count: ${streamingDocs.length}`);
    console.log(`Timing: original=${origTime}s, streaming=${streamTime}s`);

    // Build lookup maps
    const originalMap = new Map<string, any>();
    for (const doc of originalDocs) {
        if (doc.normalized_sku) originalMap.set(doc.normalized_sku, doc);
    }

    const streamingMap = new Map<string, any>();
    for (const doc of streamingDocs) {
        if (doc.normalized_sku) streamingMap.set(doc.normalized_sku, doc);
    }

    // SKUs only in one build
    const onlyOriginal = [...originalMap.keys()].filter(k => !streamingMap.has(k));
    const onlyStreaming = [...streamingMap.keys()].filter(k => !originalMap.has(k));

    console.log(`\nOnly in original: ${onlyOriginal.length}`);
    if (onlyOriginal.length > 0 && onlyOriginal.length <= 20) console.log(`  ${onlyOriginal.join(", ")}`);

    console.log(`Only in streaming: ${onlyStreaming.length}`);
    if (onlyStreaming.length > 0 && onlyStreaming.length <= 20) console.log(`  ${onlyStreaming.join(", ")}`);

    // Field-by-field comparison on shared SKUs
    const fieldsToCompare = [
        "sku", "normalized_sku", "upc", "manufacturer_map",
        "synnex_price", "synnex_quantity", "dandh_price", "dandh_quantity",
        "ingram_price", "ingram_quantity", "supplies_price", "supplies_count",
        "almo_price", "almo_quantity",
        "name", "name_source", "condition", "category_class", "category_class_l2", "category_class_l3",
        "priority",
    ];

    let fieldMismatches = 0;
    let skusWithMismatches = 0;
    const mismatchExamples: any[] = [];

    for (const sku of originalMap.keys()) {
        if (!streamingMap.has(sku)) continue;

        const orig = originalMap.get(sku);
        const stream = streamingMap.get(sku);
        let skuHasMismatch = false;

        for (const field of fieldsToCompare) {
            const origVal = JSON.stringify(orig[field] ?? null);
            const streamVal = JSON.stringify(stream[field] ?? null);

            if (origVal !== streamVal) {
                fieldMismatches++;
                skuHasMismatch = true;
                if (mismatchExamples.length < 20) {
                    mismatchExamples.push({ sku, field, original: orig[field], streaming: stream[field] });
                }
            }
        }

        if (skuHasMismatch) skusWithMismatches++;
    }

    // Distributor list comparison (order-independent)
    let distMismatches = 0;
    for (const sku of originalMap.keys()) {
        if (!streamingMap.has(sku)) continue;
        const origDist = (originalMap.get(sku).distributor_list || []).sort().join(",");
        const streamDist = (streamingMap.get(sku).distributor_list || []).sort().join(",");
        if (origDist !== streamDist) distMismatches++;
    }

    const sharedCount = [...originalMap.keys()].filter(k => streamingMap.has(k)).length;

    console.log(`\nShared SKUs: ${sharedCount}`);
    console.log(`SKUs with field mismatches: ${skusWithMismatches}`);
    console.log(`Total field mismatches: ${fieldMismatches}`);
    console.log(`Distributor list mismatches: ${distMismatches}`);

    if (mismatchExamples.length > 0) {
        console.log("\nMismatch examples:");
        for (const m of mismatchExamples) {
            console.log(`  ${m.sku}.${m.field}:`);
            console.log(`    original:  ${JSON.stringify(m.original)}`);
            console.log(`    streaming: ${JSON.stringify(m.streaming)}`);
        }
    }

    // Cleanup
    await db.dropCollection("_parity_original").catch(() => {});

    console.log("\n========================================");
    const totalIssues = onlyOriginal.length + onlyStreaming.length + fieldMismatches + distMismatches;
    if (totalIssues === 0) {
        console.log("  ✅ PARITY CONFIRMED — outputs are identical");
    } else {
        console.log(`  ⚠️  ${totalIssues} DIVERGENCES FOUND — review above`);
    }
    console.log("========================================");

    process.exit(0);
}

run().catch(err => {
    console.error("❌ Fatal:", err);
    process.exit(1);
});

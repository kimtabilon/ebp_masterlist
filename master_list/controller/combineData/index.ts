import fs from "fs";
import path from "path";
import XLSX from "xlsx";
import { Request, Response } from "express";
import { getDb } from "../../config/mongdodb.config";
import { cleanString, normalizeManufacturer, normalizeUpc as normalizeUPC, normalizeSku } from "../../utils/normalize";
// ---------------- CONFIG ----------------
const INSERT_BATCH = parseInt(process.env.INSERT_BATCH_SIZE || "50000", 10);
const LOG_INTERVAL = 200000;

const MANU_FILE = path.join(process.cwd(), "src/raw", "manufacturer report.xlsx");

// ====================================================================
// STEP 1 — Load Manufacturer Map (Normalized Keys)
// ====================================================================
function loadManufacturerMap() {
    console.log("📖 Loading manufacturer_report.xlsx...");

    if (!fs.existsSync(MANU_FILE)) {
        throw new Error(`❌ Manufacturer map file not found: ${MANU_FILE} — pipeline cannot proceed without it.`);
    }

    const workbook = XLSX.readFile(MANU_FILE);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows: any[] = XLSX.utils.sheet_to_json(sheet);

    if (!rows.length) {
        throw new Error(`❌ Manufacturer map file is empty: ${MANU_FILE} — pipeline cannot proceed without mappings.`);
    }

    const map: Record<string, string | null> = {};

    rows.forEach((r) => {
        const manufacturerExcelRaw: any = r.manufacturer;
        const manufacturerMapRaw: any = r.manufacturer_map;

        const manufacturerExcel = cleanString(manufacturerExcelRaw);
        const mapped = cleanString(manufacturerMapRaw) || null;

        if (!manufacturerExcel) return;

        const key = normalizeManufacturer(manufacturerExcel);
        map[key] = mapped;
    });

    if (Object.keys(map).length === 0) {
        throw new Error(`❌ Manufacturer map produced 0 valid mappings from ${MANU_FILE} — check file format.`);
    }

    console.log(`✔ Loaded ${Object.keys(map).length} manufacturer mappings`);
    return map;
}

// ====================================================================
// STEP 2 — SUPER FAST MERGE (with normalization + cleaning)
// ====================================================================
export async function runMergeSuperFast() {
    console.log("=================================================");
    console.log("🚀 STARTING SUPER FAST MERGE IMPORT (BEST MATCH)");
    console.log("=================================================");
    const db: any = await getDb('master_list');
    const manufacturerMap = loadManufacturerMap();

    const collections = [
        { name: "dist_synnex_raw", distributor: "synnex" },
        { name: "dist_dandh_raw", distributor: "dandh" },
        { name: "dist_ingram_raw", distributor: "ingram" },
        { name: "dist_supplies_raw", distributor: "supplies" },
        { name: "dist_almo_raw", distributor: "almo" }  // ✅ ADDED
    ];

    // Use a staging collection, then rename atomically to avoid drop+insert race
    const stagingName = "dist_combined_raw_staging";
    await db.dropCollection(stagingName).catch(() => { });
    await db.createCollection(stagingName);
    const combined = db.collection(stagingName);

    let insertedTotal = 0;
    let processedTotal = 0;

    for (const dist of collections) {
        console.log(`📥 Merging from ${dist.name}...`);

        const cursor = db.collection(dist.name).find();
        let batch: any[] = [];
        let count = 0;

        while (await cursor.hasNext()) {
            const p: any = await cursor.next();
            count++;
            processedTotal++;

            // === Clean raw inputs ===
            const rawManufacturer = cleanString(p.manufacturer || "");
            const rawSku = cleanString(p.sku || "");
            const rawUpc = cleanString(p.upc || "");

            // === Manufacturer normalization & mapping ===
            const normManufacturer = normalizeManufacturer(rawManufacturer);
            const manufacturer_mapped = manufacturerMap[normManufacturer] || null;

            // === SKU normalization ===
            const normalized_sku = rawSku ? normalizeSku(rawSku) : "";

            // === UPC normalization ===
            const normalized_upc = normalizeUPC(rawUpc);

            // Prepare fields to insert — convert empty strings to null where appropriate
            const insertDoc: any = {
                sku: rawSku || null,
                normalized_sku: normalized_sku || null,
                upc: rawUpc || null,
                normalized_upc,              // may be null
                manufacturer: rawManufacturer || null,
                distributor: dist.distributor,
                manufacturer_map: manufacturer_mapped
            };

            batch.push(insertDoc);

            if (batch.length >= INSERT_BATCH) {
                await combined.insertMany(batch, { ordered: false }).catch((err: any) => {
                    console.warn("⚠ insertMany error (continuing):", err?.message || err);
                });
                insertedTotal += batch.length;
                batch = [];

                if (insertedTotal % LOG_INTERVAL === 0) {
                    console.log(`⚡ Inserted ${insertedTotal}`);
                }
            }

            // occasional lightweight log for progress
            if (processedTotal % 50000 === 0) {
                console.log(`... processed ${processedTotal} rows so far`);
            }
        }

        // Final batch
        if (batch.length) {
            await combined.insertMany(batch, { ordered: false }).catch((err: any) => {
                console.warn("⚠ insertMany error (final batch):", err?.message || err);
            });
            insertedTotal += batch.length;
            batch = [];
        }

        console.log(`✔ Completed ${dist.name}: ${count} rows`);
    }

    // Build indexes on staging collection
    await combined.createIndex({ sku: 1 });
    await combined.createIndex({ normalized_sku: 1 });
    await combined.createIndex({ normalized_upc: 1 });

    console.log("✔ Indexes created on staging collection");

    // Atomically swap staging → production
    // NOTE: renameCollection requires dbAdmin or dbOwner role on the MongoDB user.
    // If this fails with an auth error, grant the role or fall back to drop+rename manually.
    await db.dropCollection("dist_combined_raw").catch(() => { });
    await db.admin().command({
        renameCollection: `${db.databaseName}.${stagingName}`,
        to: `${db.databaseName}.dist_combined_raw`,
        dropTarget: true,
    });

    console.log("✔ Staging collection renamed to dist_combined_raw");

    console.log("=================================================");
    console.log("🎉 MERGE COMPLETED (BEST MATCH + NORMALIZED UPC)");
    console.log("Total processed:", processedTotal);
    console.log("Total inserted:", insertedTotal);
    console.log("=================================================");

    return insertedTotal;
}
export async function buildGroupedUPCData() {
    const db: any = await getDb('master_list');

    console.log("=================================================");
    console.log("🚀 START rebuilding grouped_upc_data (STRICT RULES, CANONICAL normalized_upc)");
    console.log("=================================================");

    await db.dropCollection("grouped_upc_data").catch(() => { });
    await db.createCollection("grouped_upc_data");

    // ---------------------------------------------
    // Helpers
    // ---------------------------------------------
    const isBlank = (v: any) => {
        if (v === null || v === undefined) return true;
        if (typeof v === "string") return v.trim() === "";
        return false;
    };

    const normalizeManufacturerForCompare = (m: any) => {
        if (!m) return null;
        const s = String(m).trim().toUpperCase();
        if (!s || s === "NULL" || s === "UNKNOWN" || s === "N/A" || s === "NA") return null;
        return s;
    };

    // -----------------------------------------------------------
    // 1) Detect SKU → multiple UPC conflicts
    //    (normalized_upc is already canonical)
    // -----------------------------------------------------------
    console.log("📌 Detecting SKU → multiple UPC conflicts...");

    const skuConflictCursor = db.collection("dist_combined_raw").aggregate([
        {
            $match: {
                normalized_sku: { $exists: true, $nin: [null, ""] },
                normalized_upc: { $exists: true, $nin: [null, ""] }
            }
        },
        {
            $addFields: {
                normalized_sku: { $toUpper: "$normalized_sku" }
            }
        },
        {
            $group: {
                _id: "$normalized_sku",
                upcs: { $addToSet: "$normalized_upc" }
            }
        },
        {
            $match: {
                $expr: { $gt: [{ $size: "$upcs" }, 1] }
            }
        }
    ]);

    const skuConflicts = await skuConflictCursor.toArray();
    const skuConflictList = new Set(skuConflicts.map((c: any) => String(c._id)));

    console.log(`❌ SKUs with multiple UPCs: ${skuConflictList.size}`);

    // -----------------------------------------------------------
    // 2) Build UPC groups (raw)
    // -----------------------------------------------------------
    console.log("📌 Running UPC grouping pipeline...");

    const rawGroups = await db.collection("dist_combined_raw").aggregate([
        {
            $match: {
                normalized_upc: { $exists: true, $nin: [null, ""] },
                normalized_sku: { $exists: true, $nin: [null, ""] }
            }
        },

        // SKU uppercase only — UPC already normalized
        {
            $addFields: {
                sku: {
                    $cond: [
                        { $eq: ["$sku", null] },
                        null,
                        { $toUpper: "$sku" }
                    ]
                },
                normalized_sku: {
                    $cond: [
                        { $eq: ["$normalized_sku", null] },
                        null,
                        { $toUpper: "$normalized_sku" }
                    ]
                }
            }
        },

        // Group per unique UPC+SKU+manufacturer
        {
            $group: {
                _id: {
                    upc: "$normalized_upc",
                    raw_sku: "$sku",
                    normalized_sku: "$normalized_sku",
                    manufacturer_map: "$manufacturer_map"
                },
                distributors: { $addToSet: "$distributor" }
            }
        },

        // Group again by UPC only
        {
            $group: {
                _id: "$_id.upc",

                sku_list: { $addToSet: "$_id.raw_sku" },
                normalized_sku_list: { $addToSet: "$_id.normalized_sku" },

                distributor_list: {
                    $push: {
                        raw_sku: "$_id.raw_sku",
                        normalized_sku: "$_id.normalized_sku",
                        distributors: "$distributors"
                    }
                },

                manufacturer_map_list: { $addToSet: "$_id.manufacturer_map" }
            }
        },

        {
            $project: {
                _id: 0,
                upc: "$_id",
                normalized_upc: "$_id",
                sku_list: 1,
                normalized_sku_list: 1,
                distributor_list: 1,
                manufacturer_map_list: 1,
                sku_count: { $size: "$normalized_sku_list" }
            }
        }
    ]).toArray();

    console.log(`📦 Raw groups generated: ${rawGroups.length}`);

    // -----------------------------------------------------------
    // 3) Apply strict validation rules
    // -----------------------------------------------------------
    const finalGroups: any[] = [];

    for (const g of rawGroups) {
        const { upc, sku_list = [], normalized_sku_list = [], manufacturer_map_list = [] } = g;

        if (!upc) continue;

        // Rule B: reject if ANY raw SKU is blank
        if (sku_list.some((s: any) => isBlank(s))) continue;

        // Rule 2: UPC MUST map to exactly 1 normalized SKU
        const cleanedSkus = normalized_sku_list.filter((s: any) => s && String(s).trim() !== "");
        if (cleanedSkus.length !== 1) continue;

        const sku = cleanedSkus[0];

        // Rule 4: reject SKUs that appear with >1 UPC globally
        if (skuConflictList.has(sku)) continue;

        // Rule 5: manufacturers must be consistent
        const cleanedManufacturers = manufacturer_map_list
            .map((m: any) => normalizeManufacturerForCompare(m))
            .filter((m: any) => m !== null);

        if (cleanedManufacturers.length === 0) continue;

        const manufacturerSet = new Set(cleanedManufacturers);
        if (manufacturerSet.size !== 1) continue;

        const canonicalManufacturer = [...manufacturerSet][0];

        finalGroups.push({
            upc,
            normalized_upc: upc,
            sku_list,
            normalized_sku_list: cleanedSkus,
            distributor_list: g.distributor_list,
            manufacturer_map_list,
            canonical_manufacturer: canonicalManufacturer,
            sku_count: cleanedSkus.length
        });
    }

    // -----------------------------------------------------------
    // 4) Insert final result
    // -----------------------------------------------------------
    if (finalGroups.length) {
        await db.collection("grouped_upc_data").insertMany(finalGroups);
    }

    console.log("=================================================");
    console.log("🎉 STRICT grouped_upc_data BUILD COMPLETE");
    console.log(`✔ Final groups inserted: ${finalGroups.length}`);
    console.log("=================================================");

    return true;
}


export async function syncMissingSKUs(req: Request, res: Response) {
    try {
        const db: any = await getDb('master_list');
        const missingSKUColl = db.collection("missing_sku_list");
        const productColl = db.collection("product_list");

        console.log("🚀 Starting SKU sync...");

        // Get all missing SKUs
        const missingDocs = await missingSKUColl.find({}).toArray();

        let updatedCount = 0;
        let missingCount = 0;

        for (const doc of missingDocs) {
            const sku = doc.sku?.trim();
            const manufacturer = doc.manufacturer ?? null;

            if (!sku) continue;

            // Check if SKU exists in product_list
            const product = await productColl.findOne({ sku });

            if (product) {
                // SKU FOUND → update manufacturer if needed
                await productColl.updateOne(
                    { sku },
                    {
                        $set: {
                            manufacturer: manufacturer,
                            updated_from_missing_sku: true,
                            updated_at: new Date()
                        }
                    }
                );

                updatedCount++;
            } else {
                // SKU NOT FOUND → update missing_sku_list with marker
                await missingSKUColl.updateOne(
                    { _id: doc._id },
                    {
                        $set: {
                            missing_in_product_list: true,
                            checked_at: new Date()
                        }
                    }
                );

                missingCount++;
            }
        }

        return res.json({
            success: true,
            message: "SKU sync complete",
            updated_in_product_list: updatedCount,
            not_found_in_product_list: missingCount
        });

    } catch (err: any) {
        console.error("❌ Error syncing SKUs:", err);
        return res.status(500).json({
            success: false,
            error: err.message
        });
    }
}

export async function analyzeMissingSKU(req: Request, res: Response) {
    try {
        const db: any = await getDb('master_list');
        const missingCol = db.collection("missing_sku_list");
        const rawCol = db.collection("dist_combined_raw");

        console.log("⚡ Running FAST missing SKU analysis (RAW SKU + Manufacturer Check)...");

        const LIMIT = 10;

        // =====================================================
        // 1️⃣ Load missing SKUs (raw, no normalization)
        // =====================================================
        const missingDocs = await missingCol.find({}).toArray();
        const missingSKUs = missingDocs.map((d: any) => String(d.sku || "").trim());

        // =====================================================
        // 2️⃣ Load raw rows for these SKUs (single query)
        // =====================================================
        const rowsForSKUs = await rawCol
            .find({ sku: { $in: missingSKUs } })
            .toArray();

        // SKU → upc list & manufacturer list
        const skuToUPCs: any = {};
        const skuToManufacturer: any = {};

        for (const r of rowsForSKUs) {
            const s = r.sku;

            if (!skuToUPCs[s]) skuToUPCs[s] = [];
            skuToUPCs[s].push(r.normalized_upc);

            if (!skuToManufacturer[s]) skuToManufacturer[s] = [];
            skuToManufacturer[s].push(r.manufacturer_map ?? null);
        }

        // =====================================================
        // 3️⃣ Load all UPC rows for conflict checking (single query)
        // =====================================================
        const allUPCs = [...new Set(rowsForSKUs.map((r: any) => r.normalized_upc))];

        const rowsForUPCs = await rawCol
            .find({ normalized_upc: { $in: allUPCs } })
            .toArray();

        const upcToSKUs: any = {};

        for (const r of rowsForUPCs) {
            if (!upcToSKUs[r.normalized_upc]) upcToSKUs[r.normalized_upc] = [];
            upcToSKUs[r.normalized_upc].push(r.sku);
        }

        // =====================================================
        // 4️⃣ Process results (in memory)
        // =====================================================
        const bulk = missingCol.initializeUnorderedBulkOp();

        for (const doc of missingDocs) {
            const sku = String(doc.sku || "").trim();

            let skuConflict = false;
            let upcConflict = false;
            let manufacturerConflict = false;
            let manufacturerNull = false;

            let missingReason = "";

            let conflictUPCList: any[] = [];
            let conflictSKUList: any[] = [];
            let conflictManufacturerList: any[] = [];

            let conflictUPCCount = 0;
            let conflictSKUCount = 0;
            let conflictManufacturerCount = 0;

            // UPC list for this SKU
            const skuUPCs = skuToUPCs[sku] || [];

            // Manufacturer list for this SKU
            const manufacturerList = skuToManufacturer[sku] || [];

            // =====================================================
            // Case A — SKU not in RAW
            // =====================================================
            if (skuUPCs.length === 0) {
                missingReason = "SKU NOT FOUND IN RAW";

                bulk.find({ _id: doc._id }).updateOne({
                    $set: {
                        sku_conflict: false,
                        upc_conflict: false,
                        manufacturer_conflict: false,
                        manufacturer_null: true,

                        conflict_upc_list: [],
                        conflict_sku_list: [],
                        conflict_manufacturer_list: [],

                        conflict_upc_count: 0,
                        conflict_sku_count: 0,
                        conflict_manufacturer_count: 0,

                        missing_reason: missingReason,
                        analyzed_at: new Date()
                    }
                });

                continue;
            }

            // =====================================================
            // Case B — SKU conflict (multiple UPCs)
            // =====================================================
            const uniqueUPCList = [...new Set(skuUPCs)];
            if (uniqueUPCList.length > 1) {
                skuConflict = true;
                conflictUPCList = uniqueUPCList.slice(0, LIMIT);
                conflictUPCCount = uniqueUPCList.length;
                missingReason = "SKU CONFLICT (MULTIPLE UPCs)";
            }

            // =====================================================
            // Case C — UPC conflict (UPC → multiple SKUs)
            // =====================================================
            const firstUPC: any = uniqueUPCList[0];
            const skuListForUPC = upcToSKUs[firstUPC] || [];
            const uniqueSKUList = [...new Set(skuListForUPC)];

            if (uniqueSKUList.length > 1) {
                upcConflict = true;
                conflictSKUList = uniqueSKUList.slice(0, LIMIT);
                conflictSKUCount = uniqueSKUList.length;

                if (!missingReason)
                    missingReason = "UPC CONFLICT (MULTIPLE SKUs)";
            }

            // =====================================================
            // Case D — Manufacturer conflict
            // =====================================================
            const cleanManufacturers = manufacturerList.map((m: any) =>
                (m ?? "").toString().trim().toUpperCase()
            );

            const uniqueManufacturers = [...new Set(cleanManufacturers)];

            // All manufacturers null or empty?
            const noValidManufacturer =
                uniqueManufacturers.length === 1 &&
                (uniqueManufacturers[0] === "" || uniqueManufacturers[0] === "NULL" || uniqueManufacturers[0] === "N/A");

            if (noValidManufacturer) {
                manufacturerNull = true;
                if (!missingReason)
                    missingReason = "NO VALID MANUFACTURER_MAP FOUND";
            } else if (uniqueManufacturers.length > 1) {
                manufacturerConflict = true;
                conflictManufacturerList = uniqueManufacturers.slice(0, LIMIT);
                conflictManufacturerCount = uniqueManufacturers.length;

                if (!missingReason)
                    missingReason = "MANUFACTURER CONFLICT";
            }

            // =====================================================
            // Case E — No conflicts at all
            // =====================================================
            if (!skuConflict && !upcConflict && !manufacturerConflict && !manufacturerNull) {
                missingReason = "NO CONFLICT — SHOULD EXIST IN PRODUCT LIST";
            }

            // =====================================================
            // BULK UPDATE
            // =====================================================
            bulk.find({ _id: doc._id }).updateOne({
                $set: {
                    sku_conflict: skuConflict,
                    upc_conflict: upcConflict,

                    manufacturer_conflict: manufacturerConflict,
                    manufacturer_null: manufacturerNull,

                    conflict_upc_list: conflictUPCList,
                    conflict_sku_list: conflictSKUList,
                    conflict_manufacturer_list: conflictManufacturerList,

                    conflict_upc_count: conflictUPCCount,
                    conflict_sku_count: conflictSKUCount,
                    conflict_manufacturer_count: conflictManufacturerCount,

                    missing_reason: missingReason,
                    analyzed_at: new Date()
                }
            });
        }

        await bulk.execute();

        return res.json({
            success: true,
            message: "FAST missing SKU analysis completed (RAW SKU + MANUFACTURER CHECK)"
        });

    } catch (err: any) {
        console.error("❌ ERROR:", err);
        return res.status(500).json({ success: false, error: err.message });
    }
}
export async function findSimilarUnmappedSKU(req: Request, res: Response) {
    try {
        const db: any = await getDb('master_list');

        const mappedCol = db.collection("clean_final_mapped_data");
        const unmappedCol = db.collection("dist_data_raw_unmapped");
        const outputCol = db.collection("dist_unmapped_similar_sku");

        console.log("🚀 Finding SKUs with SAME SKU & SAME UPC in BOTH collections...");

        // ----------------------------------------------------
        // 1️⃣ Load mapped SKUs and UPCs
        // ----------------------------------------------------
        const mappedRows = await mappedCol
            .find({}, { projection: { sku: 1, upc: 1 } })
            .toArray();

        if (!mappedRows.length) {
            return res.json({ success: true, message: "No SKUs found in mapped table." });
        }

        // Build list of {sku, upc}
        const skuUPCList = mappedRows.map((r: any) => ({
            sku: String(r.sku || "").trim(),
            upc: Array.isArray(r.upc) ? r.upc[0] : String(r.upc || "").trim()
        }));

        // ----------------------------------------------------
        // 2️⃣ Build $or list for exact matches
        // ----------------------------------------------------
        const orQueries = skuUPCList.map((item: any) => ({
            sku: item.sku,
            $or: [
                { upc: item.upc },
                { upc: [item.upc] } // support array UPC
            ]
        }));

        // ----------------------------------------------------
        // 3️⃣ Query unmapped table for exact SKU & UPC match
        // ----------------------------------------------------
        const matches = await unmappedCol.find({ $or: orQueries }).toArray();

        if (!matches.length) {
            return res.json({
                success: true,
                message: "No matching SKU + UPC pairs found.",
                matched_count: 0
            });
        }

        // ----------------------------------------------------
        // 4️⃣ Insert into output collection
        // ----------------------------------------------------
        await outputCol.deleteMany({});
        await outputCol.insertMany(matches);

        return res.json({
            success: true,
            message: "Matching SKU + UPC pairs inserted successfully.",
            matched_count: matches.length
        });

    } catch (err: any) {
        console.error("❌ ERROR:", err);
        return res.status(500).json({ success: false, error: err.message });
    }
}

// ====================================================================
// FAST & SAFE SUPPLIES NETWORK IMPORTER
// SANITIZED → CLEAR TABLE → INSERT ALL → SAFE INDEX REBUILD
// ====================================================================

import fs from "fs";
import path from "path";
import readline from "readline";
import { getDb } from "../../config/mongdodb.config";

// ---------------- CONFIG ----------------
const rawFile = path.join(process.cwd(), "master_list/raw", "4015068_PriceExport.CSV");
const bufferFile = path.join(process.cwd(), "src/raw", "supplies-buffer.jsonl");

const INSERT_BATCH = 20_000;
const LOG_INTERVAL = 200_000;

// ====================================================================
// SANITIZATION HELPERS
// ====================================================================

// Remove control chars & invalid UTF8
function cleanText(s: any) {
    if (!s || typeof s !== "string") return null;

    s = s.replace(/[\u0000-\u001F\u007F-\u009F]/g, ""); // control chars
    s = s.replace(/\s+/g, " ").trim();

    if (s.length > 5_000_000) return null; // Prevent huge values

    return s || null;
}

// sanitize and ensure Mongo safe
function sanitizeRecord(rec: any) {
    for (const k in rec) {
        const v = rec[k];

        if (typeof v === "undefined" || Number.isNaN(v)) rec[k] = null;

        if (typeof v === "string") rec[k] = cleanText(v);
    }
    return rec;
}

// ====================================================================
// STEP 1 — Parse CSV → Write buffer.jsonl (SAFE)
// ====================================================================
async function buildSuppliesBuffer() {
    console.log("📝 Parsing SuppliesNetwork CSV → Creating safe buffer...");

    if (!fs.existsSync(rawFile)) throw new Error("❌ Supplies CSV file not found");

    const out = fs.createWriteStream(bufferFile, { flags: "w" });

    const rl = readline.createInterface({
        input: fs.createReadStream(rawFile),
        crlfDelay: Infinity
    });

    let count = 0;
    const clean = (v: any) => cleanText(String(v).replace(/"/g, ""));

    for await (const line of rl) {
        if (!line.trim() || line.startsWith("SKU")) continue;
        if (line.length > 10_000_000) continue; // skip corrupted long line

        const row = line.split(",");

        let sku = clean(row[1]);
        if (!sku) continue;

        const rec = sanitizeRecord({
            sku,
            distributor: "suppliesnetwork",
            name: clean(row[22]),
            manufacturer: clean(row[7]),
            upc: clean(row[19]),
            type: clean(row[5]),
            price: parseFloat(clean(row[3]) || "0"),
            msrp: parseFloat(clean(row[2]) || "0"),
            map: parseFloat(clean(row[3]) || "0"),

            qqh_stl: parseInt(clean(row[15])) || 0,
            qqh_car: parseInt(clean(row[16])) || 0,
            qqh_dal: parseInt(clean(row[17])) || 0,
            qqh_frn: parseInt(clean(row[18])) || 0,

            qty_on_hand_total:
                (parseInt(clean(row[15])) || 0) +
                (parseInt(clean(row[16])) || 0) +
                (parseInt(clean(row[17])) || 0) +
                (parseInt(clean(row[18])) || 0),

            updated_at: new Date(),

            category_class: clean(row[12]),
            category_class_l2: clean(row[13]),
            category_class_l3: null
        });

        try {
            out.write(JSON.stringify(rec) + "\n");
        } catch {
            console.log("⚠ Skipped unstringifiable rec");
            continue;
        }

        count++;
    }

    out.end();

    console.log(`📁 Buffer created: ${bufferFile}`);
    console.log(`📊 Total rows parsed: ${count}`);

    return count;
}

// ====================================================================
// STEP 2 — CLEAR TABLE (recommended for full replace)
// ====================================================================
async function clearSuppliesTable() {
    console.log("🧹 Clearing dist_supplies_raw...");

    const db: any = await getDb('master_list');
    await db.collection("dist_supplies_raw").deleteMany({});

    console.log("✔ Collection cleared");
}

// ====================================================================
// SAFE BATCH INSERT — handles bad JSON records
// ====================================================================
async function safeInsertMany(col: any, records: any[]) {
    try {
        const res = await col.insertMany(records, { ordered: false });
        return res.insertedCount || records.length;
    } catch (err: any) {
        console.log("🔥 Bulk insert failed — scanning individual records...");
        let ok = 0;

        for (const rec of records) {
            try {
                await col.insertOne(rec);
                ok++;
            } catch (innerErr) {
                console.log("❌ Bad record removed:");
                console.log(JSON.stringify(rec).slice(0, 500));
            }
        }

        return ok;
    }
}

// ====================================================================
// STEP 3 — Insert ALL buffer records (SAFE)
// ====================================================================
async function insertSuppliesBuffer() {
    console.log("📥 Importing buffer → MongoDB...");

    const db: any = await getDb('master_list');
    const col = db.collection("dist_supplies_raw");

    const rl = readline.createInterface({
        input: fs.createReadStream(bufferFile),
        crlfDelay: Infinity
    });

    let batch: any[] = [];
    let inserted = 0;
    let checked = 0;

    console.time("SUPPLIES_INSERT_TIMER");

    for await (const line of rl) {
        if (!line.trim()) continue;

        let rec;
        try {
            rec = JSON.parse(line);
        } catch {
            console.log("⚠ Skipped invalid JSONL line");
            continue;
        }

        batch.push(rec);
        checked++;

        if (batch.length >= INSERT_BATCH) {
            inserted += await safeInsertMany(col, batch);
            batch = [];

            if (checked % LOG_INTERVAL === 0)
                console.log(`⚡ Checked ${checked} | Inserted: ${inserted}`);
        }
    }

    if (batch.length) inserted += await safeInsertMany(col, batch);

    console.timeEnd("SUPPLIES_INSERT_TIMER");
    console.log(`🎉 Completed. Inserted: ${inserted}`);

    return inserted;
}

// ====================================================================
// STEP 4 — Rebuild UNIQUE SKU Index (SAFE)
// ====================================================================
async function buildSuppliesIndex() {
    console.log("🔧 Rebuilding UNIQUE index on sku...");

    const db: any = await getDb('master_list');
    const col = db.collection("dist_supplies_raw");

    // Drop old index if exists
    try {
        await col.dropIndex("sku_1");
        console.log("✔ Dropped old index sku_1");
    } catch (e: any) {
        if (!/not found/i.test(e.message))
            console.log("⚠ dropIndex warning:", e.message);
    }

    // Create new unique index
    await col.createIndex({ sku: 1 }, { unique: true });
    console.log("✔ UNIQUE index created");
}

// ====================================================================
// MAIN RUNNER
// ====================================================================
export async function runSupplies() {
    console.log("=================================================");
    console.log("🚀 STARTING SAFE SUPPLIES NETWORK IMPORT");
    console.log("=================================================");

    const parsed = await buildSuppliesBuffer();

    await clearSuppliesTable();

    const inserted = await insertSuppliesBuffer();

    await buildSuppliesIndex();

    // Clean up buffer file after successful ingestion
    if (fs.existsSync(bufferFile)) fs.unlinkSync(bufferFile);

    console.log("=================================================");
    console.log("✅ SUPPLIES IMPORT COMPLETED");
    console.log("Parsed:", parsed);
    console.log("Inserted:", inserted);
    console.log("=================================================");

    return { parsed, inserted };
}

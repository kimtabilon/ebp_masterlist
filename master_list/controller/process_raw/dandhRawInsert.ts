import fs from "fs";
import path from "path";
import readline from "readline";
import { getDb } from "../../config/mongdodb.config";
// ---------------- CONFIG ----------------
const rawFile = path.join(process.cwd(), "master_list/raw", "dandh-pa");
const catListFile = path.join(process.cwd(), "master_list/raw", "CATLIST");
const bufferFile = path.join(process.cwd(), "src/raw", "dandh-buffer.jsonl");

const INSERT_BATCH = 20_000;
const LOG_INTERVAL = 200_000;

// ====================================================================
// SANITIZATION HELPERS
// ====================================================================

function cleanText(s: any) {
    if (!s || typeof s !== "string") return null;

    s = s.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
    s = s.replace(/\s+/g, " ").trim();

    if (s.length > 5_000_000) return null;

    return s || null;
}

function sanitizeRecord(rec: any) {
    for (const k in rec) {
        const v = rec[k];

        if (typeof v === "undefined" || Number.isNaN(v)) rec[k] = null;
        if (typeof v === "string") rec[k] = cleanText(v);
    }
    return rec;
}

// ====================================================================
// STEP 1 — Load CATLIST Mapping
// ====================================================================
function loadDandHCategoryMap() {
    console.log("📖 Loading CATLIST...");

    if (!fs.existsSync(catListFile)) throw new Error("❌ CATLIST not found");

    const lines = fs.readFileSync(catListFile, "utf8")
        .split(/\r?\n/)
        .filter(Boolean);

    const map: Record<string, any> = {};

    for (const line of lines) {
        let parts = line.includes("|") ? line.split("|") : line.split(",");

        if (parts.length < 3) continue;

        const subcategory_code = cleanText(parts[2]);
        if (!subcategory_code) continue;

        map[subcategory_code] = {
            category_class: cleanText(parts[1]) || null,
            category_class_l_l2: cleanText(parts[3]) || null,
            category_class_l3: null
        };
    }

    console.log(`✔ Loaded ${Object.keys(map).length} D&H categories`);
    return map;
}

// ====================================================================
// STEP 2 — Parse dandh-pa → Sanitize → Write buffer.jsonl
// ====================================================================
async function buildDandHBuffer(categoryMap: any) {
    console.log("📝 Building safe D&H buffer...");

    if (!fs.existsSync(rawFile)) throw new Error("❌ dandh-pa raw file missing");

    const out = fs.createWriteStream(bufferFile, { flags: "w" });

    const rl = readline.createInterface({
        input: fs.createReadStream(rawFile),
        crlfDelay: Infinity
    });

    let count = 0;

    for await (const line of rl) {
        if (!line.trim()) continue;

        if (line.length > 10_000_000) continue;

        const row = line.split("|");
        if (row.length < 16) continue;

        const sku = cleanText(row[5]); // DO NOT MODIFY sku
        if (!sku) continue;

        const subcategory_code = cleanText(row[7]);
        const cat = categoryMap[subcategory_code] || {
            category_class: null,
            category_class_l2: null,
            category_class_l3: null
        };

        const rec = sanitizeRecord({
            sku,                                  // unchanged
            distributor: "dandh",
            name: cleanText(row[15]),
            msrp: Number(row[16] || 0),
            map: Number(row[17] || 0),
            manufacturer: cleanText(row[8]),
            d_h_sku: cleanText(row[4]),           // unique key
            upc: cleanText(row[6]),

            price: Number(row[9] || 0),
            qty_on_hand_total: Number(row[1] || 0),

            subcategory_code,
            updated_at: new Date(),

            category_class: cat.category_class,
            category_class_l2: cat.category_class_l2,
            category_class_l3: cat.category_class_l3
        });

        try {
            out.write(JSON.stringify(rec) + "\n");
        } catch {
            continue;
        }

        count++;
    }

    await new Promise<void>((resolve, reject) => {
        out.end(() => resolve());
        out.on("error", reject);
    });

    console.log(`📁 Buffer created: ${bufferFile}`);
    console.log(`📊 Parsed: ${count} rows`);
    return count;
}

// ====================================================================
// STEP 3 — CLEAR TABLE
// ====================================================================
async function clearDandHTable() {
    console.log("🧹 Clearing dist_dandh_raw...");
    const db: any = await getDb('master_list');
    await db.collection("dist_dandh_raw").deleteMany({});
    console.log("✔ Table cleared");
}

// ====================================================================
// SAFE INSERT (duplicates auto-ignore due to unique index)
// ====================================================================
async function safeInsertMany(collection: any, batch: any[]) {
    try {
        const res = await collection.insertMany(batch, { ordered: false });
        return res.insertedCount || batch.length;
    } catch (err: any) {
        let ok = 0;
        for (const rec of batch) {
            try {
                await collection.insertOne(rec);
                ok++;
            } catch (inner: any) {
                if (inner.code === 11000) continue; // ignore duplicate d_h_sku
                console.log("❌ Bad record removed:", JSON.stringify(rec).slice(0, 400));
            }
        }
        return ok;
    }
}

// ====================================================================
// STEP 4 — Insert ALL buffer rows
// ====================================================================
async function insertDandHBuffer() {
    console.log("📥 Inserting D&H buffer (duplicates auto-ignored)...");

    const db: any = await getDb('master_list');
    const col = db.collection("dist_dandh_raw");

    const rl = readline.createInterface({
        input: fs.createReadStream(bufferFile),
        crlfDelay: Infinity
    });

    let batch: any[] = [];
    let inserted = 0;
    let checked = 0;

    console.time("DANDH_INSERT_TIMER");

    for await (const line of rl) {
        if (!line.trim()) continue;

        let rec;
        try {
            rec = JSON.parse(line);
        } catch {
            continue;
        }

        batch.push(rec);
        checked++;

        if (batch.length >= INSERT_BATCH) {
            inserted += await safeInsertMany(col, batch);
            batch = [];

            if (checked % LOG_INTERVAL === 0)
                console.log(`⚡ Checked ${checked} | Inserted ${inserted}`);
        }
    }

    if (batch.length)
        inserted += await safeInsertMany(col, batch);

    console.timeEnd("DANDH_INSERT_TIMER");
    console.log(`✔ Total inserted (unique d_h_sku only): ${inserted}`);

    return inserted;
}

// ====================================================================
// STEP 5 — BUILD UNIQUE INDEX BEFORE INSERT
// ====================================================================
async function buildDandHUniqueIndex() {
    console.log("🔧 Creating UNIQUE index on d_h_sku...");

    const db: any = await getDb('master_list');
    const col = db.collection("dist_dandh_raw");

    try {
        await col.dropIndex("d_h_sku_1");
    } catch { }

    await col.createIndex({ d_h_sku: 1 }, { unique: true });

    console.log("✔ Unique index ready");
}

// ====================================================================
// MAIN RUNNER
// ====================================================================
export async function runDandH() {
    console.log("=================================================");
    console.log("🚀 START D&H IMPORT (INDEX BEFORE INSERT)");
    console.log("=================================================");

    const categoryMap = loadDandHCategoryMap();
    const parsed = await buildDandHBuffer(categoryMap);

    await clearDandHTable();

    // Build unique index BEFORE inserting
    await buildDandHUniqueIndex();

    const inserted = await insertDandHBuffer();

    console.log("=================================================");
    console.log("✅ D&H IMPORT COMPLETE");
    console.log("Parsed:", parsed);
    console.log("Inserted (unique):", inserted);
    console.log("=================================================");

    return { parsed, inserted };
}

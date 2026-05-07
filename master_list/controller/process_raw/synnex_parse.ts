// ====================================================================
// SUPER-FAST SYNNEX IMPORTER — FULL SAFE VERSION
// Prevents BSON offset errors and corrupted documents
// ====================================================================

import fs from "fs";
import path from "path";
import unzipper from "unzipper";
import readline from "readline";
import { getDb } from "../../config/mongdodb.config";

// ---------------- CONFIG ----------------
const zipFile = path.join(process.cwd(), "master_list/raw", "synnex-pa.zip");
const targetFile = "617490.ap";
const extractedFile = path.join(process.cwd(), "master_list/raw", "617490_extracted.ap");

const categoryFile = path.join(process.cwd(), "master_list/raw", "category_list.txt");
const bufferFile = path.join(process.cwd(), "src/raw", "synnex-buffer.jsonl");

const INSERT_BATCH = 20_000;
const LOG_INTERVAL = 200_000;

// ====================================================================
// SANITIZATION HELPERS
// ====================================================================

// Remove control characters & invalid text
function cleanText(s: any) {
    if (!s || typeof s !== "string") return null;

    // Remove control chars + invalid unicode ranges
    s = s.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");

    // Trim & normalize spacing
    s = s.trim().replace(/\s+/g, " ");

    // Prevent huge fields
    if (s.length > 5_000_000) return null;

    return s || null;
}

// Validate BSON-safe record
function sanitizeRecord(rec: any) {
    for (const key in rec) {
        const val = rec[key];

        if (typeof val === "undefined" || Number.isNaN(val)) {
            rec[key] = null;
        }

        if (typeof val === "string") {
            rec[key] = cleanText(val);
        }
    }
    return rec;
}

// ====================================================================
// STEP 1 — UNZIP SYNNEX
// ====================================================================
async function unzipSynnex() {
    console.log("📦 Unzipping:", zipFile);

    if (!fs.existsSync(zipFile)) throw new Error("❌ ZIP file not found");

    await new Promise<void>((resolve, reject) => {
        fs.createReadStream(zipFile)
            .pipe(unzipper.Parse())
            .on("entry", (entry) => {
                if (entry.path === targetFile) {
                    console.log("✔ Extracting:", targetFile);
                    entry.pipe(fs.createWriteStream(extractedFile))
                        .on("finish", resolve)
                        .on("error", reject);
                } else entry.autodrain();
            })
            .on("error", reject);
    });

    console.log("📁 Extracted:", extractedFile);
}

// ====================================================================
// STEP 2 — LOAD CATEGORY MAP
// ====================================================================
function loadCategoryMap() {
    console.log("📖 Loading category list...");

    if (!fs.existsSync(categoryFile)) throw new Error("❌ Missing category_list.txt");

    const map: Record<string, any> = {};

    const lines = fs.readFileSync(categoryFile, "utf8")
        .split(/\r?\n/)
        .filter(Boolean);

    for (const line of lines) {
        const parts = line.split(",").map(x => x.replace(/^"|"$/g, "").trim());
        if (parts.length < 4) continue;

        const [code, lvl1, lvl2, lvl3] = parts;

        map[code.toUpperCase()] = {
            category_class: lvl1 || null,
            category_class_l2: lvl2 || null,
            category_class_l3: lvl3 || null
        };
    }

    console.log(`✔ Loaded ${Object.keys(map).length} categories`);
    return map;
}

// ====================================================================
// STEP 3 — BUILD BUFFER JSONL (SAFE MODE)
// ====================================================================
async function buildBuffer(categoryMap: any) {
    console.log("📝 Building buffer.jsonl...");

    const out = fs.createWriteStream(bufferFile, { flags: "w" });

    const rl = readline.createInterface({
        input: fs.createReadStream(extractedFile),
        crlfDelay: Infinity
    });

    let count = 0;

    for await (const line of rl) {
        if (!line.trim()) continue;

        // Skip extremely long corrupted lines
        if (line.length > 10_000_000) {
            console.log("⚠ Skipping corrupted extremely long line");
            continue;
        }

        const row = line.split("~");
        if (row.length < 10) {
            console.log("⚠ Skipping malformed line:", line.slice(0, 200));
            continue;
        }

        const sku = row[2];
        if (!sku) continue;

        const category_code = (row[24] || "").toUpperCase();
        const cat = categoryMap[category_code] || {};

        const rec = sanitizeRecord({
            sku,
            distributor: "synnex",
            qty_on_hand_total: Number(row[9] || 0),
            msrp: Number(row[13] || 0),
            map: Number(row[30] || 0),
            upc: cleanText(row[33]),
            category_code,
            name: cleanText(row[6]),
            manufacturer: cleanText(row[7]),
            price: Number(row[20] || 0),
            updated_at: new Date(),
            normalized_sku: sku.replace(/[^a-zA-Z0-9]/g, ""),
            category_class: cat.category_class || null,
            category_class_l2: cat.category_class_l2 || null,
            category_class_l3: cat.category_class_l3 || null
        });

        try {
            out.write(JSON.stringify(rec) + "\n");
        } catch {
            console.log("⚠ Skipping unstringifiable record");
            continue;
        }

        count++;
    }

    await new Promise<void>((resolve, reject) => {
        out.end(() => resolve());
        out.on("error", reject);
    });
    console.log(`📁 Buffer written: ${bufferFile} — ${count} rows`);
    return count;
}

// ====================================================================
// STEP 4 — DROP INDEXES
// ====================================================================
// ====================================================================
// STEP 4 — DROP INDEXES
// ====================================================================
async function dropIndexes() {
    console.log("⚠ Dropping SYNNEX indexes...");

    const db: any = await getDb("master_list"); // ✅ MUST await
    const col = db.collection("dist_synnex_raw");

    console.time("DROP_INDEXES");
    try {
        // Optional: guard against infinite waits
        await col.dropIndexes({ maxTimeMS: 10 * 60 * 1000 }); // 10 min
    } catch (err: any) {
        if (err?.codeName !== "IndexNotFound") throw err;
    }
    console.timeEnd("DROP_INDEXES");

    console.log("✔ Indexes dropped");
}
// ====================================================================
// STEP 5 — FAST INSERT ALL ROWS
// ====================================================================
async function safeInsert(col: any, batch: any[]) {
    try {
        const res = await col.insertMany(batch, { ordered: false });
        return res.insertedCount || 0;
    } catch (err: any) {
        console.log("🔥 Bulk insert failed — scanning batch...");

        let ok = 0;
        for (const rec of batch) {
            try {
                await col.insertOne(rec);
                ok++;
            } catch (inner) {
                console.log("❌ Corrupted record (removed):");
                console.log(JSON.stringify(rec).slice(0, 500));
            }
        }

        return ok;
    }
}

async function fastInsertAll() {
    console.log("📥 Inserting all rows...");
    const db: any = await getDb('master_list');
    const col = db.collection("dist_synnex_raw");

    const rl = readline.createInterface({
        input: fs.createReadStream(bufferFile),
        crlfDelay: Infinity
    });

    let batch: any[] = [];
    let inserted = 0;
    let checked = 0;

    console.time("INSERT_TIMER");

    for await (const line of rl) {
        let rec;
        try {
            rec = JSON.parse(line);
        } catch {
            continue;
        }

        batch.push(rec);
        checked++;

        if (batch.length >= INSERT_BATCH) {
            inserted += await safeInsert(col, batch);
            batch = [];
        }
    }

    if (batch.length) inserted += await safeInsert(col, batch);

    console.timeEnd("INSERT_TIMER");
    console.log(`✔ Inserted: ${inserted}`);
    return inserted;
}

// ====================================================================
// STEP 6 — DETECT & REMOVE CORRUPTED MONGODB DOCUMENTS
// ====================================================================
async function removeCorruptedDocs() {
    console.log("🔍 Scanning MongoDB for corrupted documents...");

    const db: any = await getDb('master_list');
    const col = db.collection("dist_synnex_raw");

    const cursor = col.find({}, { timeout: false });

    let badIds: any[] = [];
    let checked = 0;

    while (await cursor.hasNext()) {
        let doc: any;
        try {
            doc = await cursor.next();
        } catch (err: any) {
            console.log("❌ CORRUPTED DOC (cursor read):", err.message);
            continue;
        }

        try {
            JSON.stringify(doc);
        } catch (err: any) {
            console.log("❌ CORRUPTED DOC FOUND:", err.message);
            badIds.push(doc._id);
        }

        checked++;
        // if (checked % 100000 === 0) console.log(`Checked ${checked} docs...`);
    }

    if (badIds.length) {
        console.log(`🗑 Removing ${badIds.length} corrupted docs...`);
        await col.deleteMany({ _id: { $in: badIds } });
    }

    console.log("✔ Corruption scan complete");
    return badIds.length;
}
// ====================================================================
// SAFE STREAMING removeDuplicates — avoids $push and BSON-size issues
// ====================================================================
async function removeDuplicates() {
    console.log("🧹 Removing duplicate SKUs (streaming-safe) ...");

    const db: any = await getDb('master_list');
    const col = db.collection("dist_synnex_raw");

    // Skip non-unique index creation — dedup uses aggregation with allowDiskUse,
    // and we'll create the unique index once after dedup completes.

    // Pipeline finds SKUs with more than 1 document and returns keep (latest) only.
    const pipeline = [
        // sort by sku ascending and _id descending so $max/_id semantics are safe
        { $sort: { sku: 1, _id: -1 } },

        // group per sku: count and keep latest _id
        {
            $group: {
                _id: "$sku",
                count: { $sum: 1 },
                keep: { $first: "$_id" } // after the sort, $first is the newest
            }
        },

        // only interested in skus with duplicates
        { $match: { count: { $gt: 1 } } },

        // projection to keep shape minimal
        { $project: { sku: "$_id", keep: 1, _id: 0, count: 1 } }
    ];

    // Use cursor to stream results, with allowDiskUse to avoid memory limits
    const cursor = col.aggregate(pipeline, { allowDiskUse: true });

    const BATCH_SIZE = 500; // number of sku-delete ops per bulkWrite
    let ops: any[] = [];
    let totalDeleted = 0;
    let processed = 0;

    while (await cursor.hasNext()) {
        const g = await cursor.next();
        if (!g || !g.sku) continue;

        // create deleteMany op: remove all docs for sku except the keep _id
        ops.push({
            deleteMany: {
                filter: { sku: g.sku, _id: { $ne: g.keep } }
            }
        });

        // execute in batches to avoid too-large bulkWrite payloads
        if (ops.length >= BATCH_SIZE) {
            const res: any = await col.bulkWrite(ops, { ordered: false });
            // res.deletedCount may be present (depends on driver), fallback:
            totalDeleted += res.deletedCount ?? (res.result?.nRemoved ?? 0) ?? 0;
            ops = [];
            processed += BATCH_SIZE;
            if (processed % (BATCH_SIZE * 10) === 0) {
                // console.log(`⚡ Processed ${processed} SKUs, deleted ~${totalDeleted} docs so far`);
            }
        }
    }

    // final flush
    if (ops.length) {
        const res: any = await col.bulkWrite(ops, { ordered: false });
        totalDeleted += res.deletedCount ?? (res.result?.nRemoved ?? 0) ?? 0;
    }

    console.log(`✔ removeDuplicates complete — approx deleted: ${totalDeleted}`);
    return totalDeleted;
}


// ====================================================================
// STEP 8 — REBUILD INDEX
// ====================================================================
async function rebuildIndex() {
    const db: any = await getDb('master_list');
    const col = db.collection("dist_synnex_raw");

    console.log("🔧 Creating UNIQUE index on sku...");
    await col.createIndex({ sku: 1 }, { unique: true });
    console.log("✔ Unique index created");
}


// ====================================================================
// MAIN RUNNER
// ====================================================================
export async function runSynnex() {
    console.log("=================================================");
    console.log("🚀 START SYNNEX IMPORT (FULL SAFE VERSION)");
    console.log("=================================================");

    await unzipSynnex();
    const categoryMap = loadCategoryMap();
    const parsed = await buildBuffer(categoryMap);

    await dropIndexes();
    const inserted = await fastInsertAll();

    // Corruption scan skipped by default — data comes from validated JSONL buffer.
    // Enable via SYNNEX_CORRUPTION_SCAN=true if needed for debugging.
    let corrupted = 0;
    if (process.env.SYNNEX_CORRUPTION_SCAN === "true") {
        corrupted = await removeCorruptedDocs();
    } else {
        console.log("⏭️  Corruption scan skipped (enable with SYNNEX_CORRUPTION_SCAN=true)");
    }
    const duplicates = await removeDuplicates();

    await rebuildIndex();

    // Clean up buffer file after successful ingestion
    if (fs.existsSync(bufferFile)) fs.unlinkSync(bufferFile);

    console.log("=================================================");
    console.log("✔ SYNNEX IMPORT DONE");
    console.log("Parsed:", parsed);
    console.log("Inserted:", inserted);
    console.log("Corrupted Removed:", corrupted);
    console.log("Duplicates Removed:", duplicates);
    console.log("=================================================");

    return { parsed, inserted, corrupted, duplicates };
}

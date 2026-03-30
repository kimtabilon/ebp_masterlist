// ====================================================================
// FAST INGRAM IMPORTER (SUPER-FAST MODE)
// UNZIP → PARSE → BUFFER JSONL → INSERT ALL → DELETE DUPES → REBUILD INDEX
// ====================================================================

import fs from "fs";
import path from "path";
import unzipper from "unzipper";
import readline from "readline";

// ---------------- CONFIG ----------------
const zipFile = path.join(process.cwd(), "master_list/raw", "ingram-pa.zip");
const targetFile = "PRICE.TXT";
const extractedFile = path.join(process.cwd(), "master_list/raw", "PRICE_EXTRACTED.TXT");

const bufferFile = path.join(process.cwd(), "src/raw", "ingram-buffer.jsonl");
const INSERT_BATCH = 20_000;
const LOG_INTERVAL = 200_000;

// ====================================================================
// STEP 1 — UNZIP PRICE.TXT
// ====================================================================
async function unzipIngram() {
    console.log("📦 Unzipping:", zipFile);

    if (!fs.existsSync(zipFile)) {
        throw new Error("❌ ZIP file not found: " + zipFile);
    }

    await new Promise<void>((resolve, reject) => {
        fs.createReadStream(zipFile)
            .pipe(unzipper.Parse())
            .on("entry", (entry) => {
                if (entry.path.toUpperCase() === targetFile) {
                    console.log("✔ Extracting:", targetFile);
                    entry.pipe(fs.createWriteStream(extractedFile))
                        .on("finish", resolve)
                        .on("error", reject);
                } else {
                    entry.autodrain();
                }
            })
            .on("error", reject);
    });

    console.log("📁 Extracted:", extractedFile);
}

// ====================================================================
// STEP 2 — PARSE PRICE.TXT → BUFFER JSONL
// ====================================================================
async function buildIngramBuffer() {
    console.log("📝 Parsing PRICE.TXT → Creating buffer...");

    if (!fs.existsSync(extractedFile)) {
        throw new Error("❌ PRICE.TXT not found after unzip.");
    }

    const clean = (x: any) => {
        if (!x || typeof x !== "string") return x || null;
        const t = x.trim().replace(/\s+/g, " ");
        return t.length ? t : null;
    };

    const out = fs.createWriteStream(bufferFile, { flags: "w" });

    const rl = readline.createInterface({
        input: fs.createReadStream(extractedFile),
        crlfDelay: Infinity
    });

    let count = 0;

    for await (const line of rl) {
        if (!line.trim()) continue;

        const row = line.split(",");

        const sku = clean(row[7]);
        if (!sku) continue;

        const record = {
            sku,
            distributor: "ingram",
            name: clean(row[4]),
            upc: clean(row[9]),
            type: clean(row[18]),
            manufacturer: clean(row[3]),
            price: Number(row[6] || 0),
            msrp: Number(row[6] || 0),
            map: Number(row[6] || 0),
            qty_on_hand_total: Number(row[16] || 0),
            updated_at: new Date(),
            category_class: null,
            category_class_l2: null,
            category_class_l3: null
        };

        out.write(JSON.stringify(record) + "\n");
        count++;
    }

    out.end();
    console.log(`📁 Buffer written: ${bufferFile}`);
    console.log(`📊 Total rows parsed: ${count}`);

    return count;
}

// ====================================================================
// STEP 3 — DROP ALL INDEXES
// ====================================================================
async function dropIndexes() {
    console.log("⚠ Dropping ALL indexes from dist_ingram_raw...");

    const db: any = await getDb('master_list');
    const col = db.collection("dist_ingram_raw");

    try {
        await col.dropIndexes();
        console.log("✔ All indexes dropped");
    } catch (err: any) {
        if (err.codeName === "IndexNotFound") {
            console.log("ℹ No indexes found, skipping drop.");
        } else throw err;
    }
}

// ====================================================================
// STEP 4 — FAST INSERT ALL (ALLOW DUPLICATES TEMPORARILY)
// ====================================================================
async function fastInsertAll() {
    console.log("📥 Inserting ALL Ingram items (duplicates allowed)...");

    const db: any = await getDb('master_list');
    const collection = db.collection("dist_ingram_raw");

    const rl = readline.createInterface({
        input: fs.createReadStream(bufferFile),
        crlfDelay: Infinity
    });

    let batch: any[] = [];
    let inserted = 0;
    let checked = 0;

    console.time("INSERT_ALL_TIMER");

    for await (const line of rl) {
        if (!line.trim()) continue;

        batch.push(JSON.parse(line));
        checked++;

        if (batch.length >= INSERT_BATCH) {
            inserted += await fastInsert(collection, batch);
            batch = [];

            if (checked % LOG_INTERVAL === 0) {
                console.log(`⚡ Checked ${checked} | Inserted ${inserted}`);
            }
        }
    }

    if (batch.length) inserted += await fastInsert(collection, batch);

    console.timeEnd("INSERT_ALL_TIMER");
    console.log(`🎉 Inserted ${inserted}`);

    return inserted;
}

async function fastInsert(collection: any, batch: any) {
    try {
        const res = await collection.insertMany(batch, { ordered: false });
        return res.insertedCount;
    } catch (err: any) {
        if (err.writeErrors) return err.result?.nInserted || 0;
        throw err;
    }
}

// ====================================================================
// STEP 5 — REMOVE DUPLICATES
// Keep the most recent (largest _id)
// ====================================================================
async function removeDuplicates() {
    console.log("🧹 Removing duplicate SKUs (stream mode)...");

    const db: any = await getDb('master_list');
    const col = db.collection("dist_ingram_raw");

    const cursor = col.aggregate([
        { $sort: { sku: 1, _id: -1 } },
        {
            $group: {
                _id: "$sku",
                keep: { $first: "$_id" },
                dups: { $push: "$_id" }
            }
        },
        {
            $project: {
                toDelete: {
                    $setDifference: ["$dups", ["$keep"]]
                }
            }
        },
        { $unwind: "$toDelete" }
    ], { allowDiskUse: true });

    let batch: any[] = [];
    let deleted = 0;
    const BATCH_SIZE = 10_000;

    for await (const doc of cursor) {
        batch.push(doc.toDelete);

        if (batch.length >= BATCH_SIZE) {
            await col.deleteMany({ _id: { $in: batch } });
            deleted += batch.length;
            batch = [];
            console.log("🗑 Deleted so far:", deleted);
        }
    }

    if (batch.length) {
        await col.deleteMany({ _id: { $in: batch } });
        deleted += batch.length;
    }

    console.log(`🗑 Total duplicates removed: ${deleted}`);
    return deleted;
}

// ====================================================================
// STEP 6 — REBUILD UNIQUE INDEX
// ====================================================================
async function rebuildIndex() {
    const db: any = await getDb('master_list');
    console.log("🔧 Creating UNIQUE index on sku...");
    await db.collection("dist_ingram_raw").createIndex({ sku: 1 }, { unique: true });
    console.log("✔ Unique index created");
}

// ====================================================================
// MAIN RUNNER
// ====================================================================
export async function runIngram() {
    console.log("=================================================");
    console.log("🚀 STARTING SUPER-FAST INGRAM IMPORT");
    console.log("=================================================");

    await unzipIngram();
    const parsed = await buildIngramBuffer();

    await dropIndexes();
    const inserted = await fastInsertAll();
    const removed = await removeDuplicates();
    await rebuildIndex();

    console.log("=================================================");
    console.log("✅ INGRAM IMPORT COMPLETED");
    console.log("Parsed:", parsed);
    console.log("Inserted:", inserted);
    console.log("Duplicates Removed:", removed);
    console.log("=================================================");

    return { parsed, inserted, removed };
}



import mysql from "mysql2/promise";
import { getDb } from "../../config/mongdodb.config";


const BATCH_SIZE = 5000;

export const syncIngramRawFast = async () => {
    try {

        const db: any = await getDb('master_list');
        const collection = db.collection("dist_ingram_raw");

        const sql = await mysql.createConnection({
            host: "190.92.158.197",
            user: "ecomm_vgAdmin",
            password: "Ri4z^{@q)EaR",
            database: process.env.DB_NAME || "ecomm_test_db",
            multipleStatements: true,
        });

        // Create table once
        await sql.query(`
            CREATE TABLE IF NOT EXISTS ingram_raw_table (
                _id VARCHAR(50) PRIMARY KEY,
                sku VARCHAR(255),
                category_class VARCHAR(255),
                category_class_l2 VARCHAR(255),
                category_class_l3 VARCHAR(255),
                distributor VARCHAR(255),
                manufacturer VARCHAR(255),
                name VARCHAR(500),
                price DECIMAL(12,2),
                qty_on_hand_total INT,
                type VARCHAR(255),
                upc VARCHAR(255),
                updated_at DATETIME,
                productCategory VARCHAR(255),
                productSubCategory VARCHAR(255),
                subType VARCHAR(255)
            );
        `);

        const cursor = collection.find({}); // Stream from MongoDB
        let batch: any = [];
        let totalInserted = 0;

        const pushBatch = async () => {
            if (batch.length === 0) return;

            const placeholders = batch
                .map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
                .join(",");

            const flatValues = batch.flat();

            const sqlInsert = `
                REPLACE INTO ingram_raw_table (
                    _id, sku, category_class, category_class_l2, category_class_l3,
                    distributor, manufacturer, name, price, qty_on_hand_total, type,
                    upc, updated_at, productCategory, productSubCategory, subType
                ) VALUES ${placeholders}
            `;

            await sql.query(sqlInsert, flatValues);
            totalInserted += batch.length;
            batch = []; // reset
        };

        // Stream MongoDB documents
        while (await cursor.hasNext()) {
            const d: any = await cursor.next();

            batch.push([
                String(d._id),
                d.sku ?? null,
                d.category_class ?? null,
                d.category_class_l2 ?? null,
                d.category_class_l3 ?? null,
                d.distributor ?? null,
                d.manufacturer ?? null,
                d.name ?? null,
                d.price ?? null,
                d.qty_on_hand_total ?? null,
                d.type ?? null,
                d.upc ?? null,
                d.updated_at ? new Date(d.updated_at) : null,
                d.productCategory ?? null,
                d.productSubCategory ?? null,
                d.subType ?? null
            ]);

            if (batch.length >= BATCH_SIZE) {
                await pushBatch();
            }
        }

        // final leftover rows
        await pushBatch();

        return {
            success: true,
            inserted: totalInserted,
        };

    } catch (err) {
        console.error("❌ syncIngramRawFast ERROR:", err);
        return { success: false, error: err };
    }
};

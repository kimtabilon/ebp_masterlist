import pLimit from "p-limit";
import fs from "fs";
import path from "path";
import { getDb } from "../../config/mongdodb.config";

function cleanString(val: any): string {
    if (val === null || val === undefined) return "";
    return String(val).replace(/["']/g, "").replace(/\s+/g, " ").trim();
}

const UPLOADED_FILE_PATH = "/mnt/data/c7a4e68d-2369-4c02-a25b-2ef9cff7e7bc.png";

export async function buildSuppliesNetworkResponseTable() {
    const db = await getDb("master_list");

    await db.dropCollection("supplies_response_table").catch(() => { });
    await db.createCollection("supplies_response_table");

    const table = db.collection("supplies_response_table");
    await table.createIndex({ sku: 1 }, { unique: true }).catch(() => { });

    const BUFFER_DIR = path.resolve("buffer");
    const BUFFER_FILE = path.join(BUFFER_DIR, "supplies_buffer.jsonl");
    fs.mkdirSync(BUFFER_DIR, { recursive: true });
    fs.writeFileSync(BUFFER_FILE, "");

    const BUFFER_LIMIT = 20_000;
    let bufferCount = 0;
    let totalInserted = 0;

    async function flushBuffer(log = false) {
        const raw = fs.readFileSync(BUFFER_FILE, "utf8").trim();
        if (!raw) {
            bufferCount = 0;
            return;
        }

        const docs = raw.split("\n").map((l) => JSON.parse(l));
        if (log) console.log(`📦 Flushing ${docs.length} docs...`);

        await table.insertMany(docs, { ordered: false }).catch((err: any) => {
            if (err?.code !== 11000) console.log("❌ InsertMany error:", err.message || err);
        });

        totalInserted += docs.length;
        bufferCount = 0;
        fs.writeFileSync(BUFFER_FILE, "");
    }

    async function writeToBuffer(doc: any) {
        fs.appendFileSync(BUFFER_FILE, JSON.stringify(doc) + "\n");
        bufferCount++;
        if (bufferCount >= BUFFER_LIMIT) {
            await flushBuffer(true);
        }
    }

    const groupedCursor = db.collection("grouped_upc_data").find();

    const skuMeta: Record<
        string,
        {
            raw_sku: string;
            normalized_sku: string;
            upc: string | null;
            normalized_upc: string | null;
            manufacturer_map: string | null;
        }
    > = {};

    while (await groupedCursor.hasNext()) {
        const g: any = await groupedCursor.next();

        const upc = cleanString(g.upc);
        const normalized_upc = cleanString(g.normalized_upc);

        const manufacturer_map = Array.isArray(g.manufacturer_map_list)
            ? cleanString(g.manufacturer_map_list.find((m: any) => m !== null) ?? "")
            : null;

        for (const dl of g.distributor_list || []) {
            if (!dl.distributors?.includes("supplies")) continue;

            const rawSku = cleanString(dl.raw_sku);
            const normalized_sku = cleanString(dl.normalized_sku);

            skuMeta[rawSku] = {
                raw_sku: rawSku,
                normalized_sku,
                upc,
                normalized_upc,
                manufacturer_map,
            };
        }
    }

    const allSkus = Object.keys(skuMeta).map(cleanString);
    if (allSkus.length === 0) return true;

    const batchSize = 500;
    const batches: string[][] = [];
    for (let i = 0; i < allSkus.length; i += batchSize) batches.push(allSkus.slice(i, i + batchSize));

    const limit = pLimit(5);
    let batchIndex = 0;

    const now = new Date();

    await Promise.all(
        batches.map((batch) =>
            limit(async () => {
                batchIndex++;
                const bn = batchIndex;

                try {
                    const rows = await db
                        .collection("dist_supplies_raw")
                        .find({ sku: { $in: batch } })
                        .project({ sku: 1, qqh_stl: 1, qqh_dal: 1, qqh_car: 1, qqh_frn: 1, price: 1 })
                        .toArray();

                    const rowMap: Record<string, any> = {};
                    for (const r of rows) rowMap[cleanString(r.sku)] = r;

                    for (const skuRaw of batch) {
                        const sku = cleanString(skuRaw);
                        const meta = skuMeta[sku];
                        const normalized = cleanString(meta.normalized_sku);

                        let rec = rowMap[sku];

                        if (!rec) {
                            rec =
                                (await db.collection("dist_supplies_raw").findOne({ sku })) ??
                                (await db.collection("dist_supplies_raw").findOne({ sku: normalized })) ??
                                null;
                        }

                        if (!rec) {
                            await writeToBuffer({
                                sku,
                                raw_sku: sku,
                                normalized_sku: normalized,
                                upc: cleanString(meta.upc),
                                normalized_upc: cleanString(meta.normalized_upc),
                                manufacturer_map: cleanString(meta.manufacturer_map),
                                distributor: "supplies",
                                supplies_response: "missing",
                                supplies_price: null,
                                supplies_count: 0,
                                supplies_qqh_stl: 0,
                                supplies_qqh_dal: 0,
                                supplies_qqh_car: 0,
                                supplies_qqh_frn: 0,
                                response: null,
                                uploaded_file_url: UPLOADED_FILE_PATH,
                                created_at: now,
                                updated_at: now,
                            });
                            continue;
                        }

                        const qqh_stl = Number(rec.qqh_stl || 0);
                        const qqh_dal = Number(rec.qqh_dal || 0);
                        const qqh_car = Number(rec.qqh_car || 0);
                        const qqh_frn = Number(rec.qqh_frn || 0);

                        const total = qqh_stl + qqh_dal + qqh_car + qqh_frn;
                        const priceVal = rec.price ?? null;

                        await writeToBuffer({
                            sku,
                            raw_sku: sku,
                            normalized_sku: normalized,
                            upc: cleanString(meta.upc),
                            normalized_upc: cleanString(meta.normalized_upc),
                            manufacturer_map: cleanString(meta.manufacturer_map),
                            distributor: "supplies",
                            supplies_response: { qqh_stl, qqh_dal, qqh_car, qqh_frn },
                            supplies_price: priceVal,
                            supplies_count: total,
                            uploaded_file_url: UPLOADED_FILE_PATH,
                            created_at: now,
                            updated_at: now,
                        });
                    }

                    await flushBuffer(true);
                } catch (err: any) {
                    for (const skuRaw of batch) {
                        const sku = cleanString(skuRaw);
                        const meta = skuMeta[sku];
                        const normalized = cleanString(meta.normalized_sku);

                        await writeToBuffer({
                            sku,
                            raw_sku: sku,
                            normalized_sku: normalized,
                            upc: cleanString(meta.upc),
                            normalized_upc: cleanString(meta.normalized_upc),
                            manufacturer_map: cleanString(meta.manufacturer_map),
                            distributor: "supplies",
                            supplies_response: "error",
                            supplies_price: null,
                            supplies_count: 0,
                            supplies_qqh_stl: 0,
                            supplies_qqh_dal: 0,
                            supplies_qqh_car: 0,
                            supplies_qqh_frn: 0,
                            response: null,
                            uploaded_file_url: UPLOADED_FILE_PATH,
                            created_at: now,
                            updated_at: now,
                        });
                    }

                    await flushBuffer(true);
                }
            })
        )
    );

    await flushBuffer(true);

    const toRetry = await table
        .find({ supplies_response: { $in: ["missing", "error"] } }, { projection: { sku: 1 } })
        .toArray();

    const retrySkus = toRetry.map((r: any) => cleanString(r.sku));
    if (retrySkus.length === 0) return true;

    const retryBatchSize = 20;
    const retryBatches: string[][] = [];
    for (let i = 0; i < retrySkus.length; i += retryBatchSize) retryBatches.push(retrySkus.slice(i, i + retryBatchSize));

    const retryLimit = pLimit(3);

    await Promise.all(
        retryBatches.map((rb) =>
            retryLimit(async () => {
                for (const skuRaw of rb) {
                    const sku = cleanString(skuRaw);
                    const meta = skuMeta[sku];
                    const normalized = cleanString(meta?.normalized_sku);

                    const rec =
                        (await db.collection("dist_supplies_raw").findOne({ sku })) ??
                        (await db.collection("dist_supplies_raw").findOne({ sku: normalized })) ??
                        null;

                    if (!rec) {
                        await table.updateOne({ sku }, { $set: { supplies_response: "missing_final", updated_at: now } });
                        continue;
                    }

                    const qqh_stl = Number(rec.qqh_stl || 0);
                    const qqh_dal = Number(rec.qqh_dal || 0);
                    const qqh_car = Number(rec.qqh_car || 0);
                    const qqh_frn = Number(rec.qqh_frn || 0);
                    const total = qqh_stl + qqh_dal + qqh_car + qqh_frn;

                    const priceVal = rec.price ?? null;

                    await table.updateOne(
                        { sku },
                        {
                            $set: {
                                supplies_response: { qqh_stl, qqh_dal, qqh_car, qqh_frn },
                                supplies_price: priceVal,
                                supplies_count: total,
                                updated_at: now,
                            },
                        }
                    );
                }
            })
        )
    );

    return true;
}

export default buildSuppliesNetworkResponseTable;
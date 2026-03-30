import pLimit from "p-limit";
import axios from "axios";
import { create } from "xmlbuilder2";
import { DOMParser } from "xmldom";
import xpath from "xpath";
import fs from "fs";
import path from "path";
import { getDb } from "../../config/mongdodb.config";

/* =========================
   Helpers
========================= */

function cleanString(val: any): string {
    if (val === null || val === undefined) return "";
    return String(val);
}

function cleanSKU(val: any): string {
    return cleanString(val).replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

function cleanUPC(val: any): string | null {
    if (val === null || val === undefined) return null;
    const digits = String(val).replace(/\D/g, "").replace(/^0+/, "");
    return digits.length ? digits : null;
}

function toInt(v: any, fallback = 0) {
    const n = parseInt(String(v ?? ""), 10);
    return Number.isFinite(n) ? n : fallback;
}

function toNullableString(v: any): string | null {
    const s = cleanString(v).trim();
    return s ? s : null;
}

/* =========================
   Types
========================= */

type DandHBranch = {
    branch: string;
    qty: number;
    inStockDate: string | null;
};

type DandHParsedItem = {
    partNum: string;
    totalQty: number;
    branches: DandHBranch[];
    rawXml: string;
};

/**
 * ✅ New schema:
 * - dandh_response: DandHParsedItem[] | null
 * - null = missing/error/unavailable
 */
type DandHResponsePayload = DandHParsedItem[] | null;

const UPLOADED_FILE_PATH =
    "/mnt/data/c7a4e68d-2369-4c02-a25b-2ef9cff7e7bc.png";

/* =========================
   XML parsing
========================= */

function xpathString(expr: string, node: Node): string {
    const val = xpath.select1(expr, node);
    if (!val) return "";
    return cleanString(val.toString());
}

function parseDandHItemNode(node: Node): DandHParsedItem {
    const partNum = cleanString(xpathString("string(./PARTNUM)", node)).trim();

    const branchNodes = (xpath.select("./BRANCHQTY", node) as unknown) as Node[];
    const branches: DandHBranch[] = branchNodes.map((b) => {
        const branch = cleanString(xpathString("string(./BRANCH)", b)).trim();
        const qty = toInt(xpathString("string(./QTY)", b), 0);
        const inStockDate = toNullableString(xpathString("string(./INSTOCKDATE)", b));
        return { branch, qty, inStockDate };
    });

    const totalQtyFromTagRaw = xpathString("string(./TOTALQTY)", node);
    const totalQtyFromTag = parseInt(totalQtyFromTagRaw || "", 10);

    const totalQty = Number.isFinite(totalQtyFromTag)
        ? totalQtyFromTag
        : branches.reduce((s, x) => s + (x.qty || 0), 0);

    return {
        partNum,
        totalQty,
        branches,
        rawXml: node.toString(),
    };
}

/* =========================
   Main builder
========================= */

export async function buildDandHResponseTable() {
    const db = await getDb("master_list");

    // rebuild collection
    await db.dropCollection("dandh_response_table").catch(() => { });
    await db.createCollection("dandh_response_table").catch(() => { });
    const table = db.collection("dandh_response_table");

    await table.createIndex({ sku: 1 }, { unique: true }).catch((e: any) => {
        console.log("Index create warning:", e?.message || e);
    });

    /* =========================
       BUFFER (JSONL → insertMany)
    ========================= */

    const BUFFER_DIR = path.resolve("buffer");
    const BUFFER_FILE = path.join(BUFFER_DIR, "dandh_buffer.jsonl");
    fs.mkdirSync(BUFFER_DIR, { recursive: true });
    fs.writeFileSync(BUFFER_FILE, "", { encoding: "utf8" });

    const BUFFER_LIMIT = 20000;
    let bufferCount = 0;
    let totalInserted = 0;

    async function flushBuffer(silent = true) {
        try {
            const raw = fs.readFileSync(BUFFER_FILE, "utf8").trim();
            if (!raw) {
                bufferCount = 0;
                return;
            }

            const docs = raw.split("\n").map((l) => JSON.parse(l));
            if (!silent) console.log(`📦 Flushing ${docs.length} docs → MongoDB...`);

            await table.insertMany(docs, { ordered: false }).catch((err: any) => {
                // ignore duplicate key
                if (err?.code !== 11000) console.log("⚠️ InsertMany error:", err.message || err);
            });

            totalInserted += docs.length;
            bufferCount = 0;
            fs.writeFileSync(BUFFER_FILE, "", { encoding: "utf8" });

            if (!silent) console.log(`✔ DandH Flush complete. Total inserted so far: ${totalInserted}\n`);
        } catch (err: any) {
            console.log("❌ flushBuffer error:", err.message || err);
        }
    }

    async function writeToBuffer(doc: any) {
        try {
            fs.appendFileSync(BUFFER_FILE, JSON.stringify(doc) + "\n");
            bufferCount++;
            if (bufferCount >= BUFFER_LIMIT) {
                console.log(`⚡ Buffer limit reached (${BUFFER_LIMIT}) → flushing...`);
                await flushBuffer(false);
            }
        } catch (err: any) {
            console.log("❌ writeToBuffer error:", err.message || err);
        }
    }

    /* =========================
       Build SKU meta map
    ========================= */

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

    let upcCounter = 0;
    let totalSkuCount = 0;

    while (await groupedCursor.hasNext()) {
        const g: any = await groupedCursor.next();
        upcCounter++;
        if (upcCounter % 5000 === 0) console.log(`🔎 processed groups: ${upcCounter.toLocaleString()}`);

        const upc = cleanUPC(g.upc ?? null);
        const normalized_upc = cleanUPC(g.normalized_upc ?? null);
        const manufacturer_map = Array.isArray(g.manufacturer_map_list)
            ? cleanString(g.manufacturer_map_list.find((m: any) => m !== null) ?? "")
            : null;

        for (const dl of g.distributor_list || []) {
            if (!Array.isArray(dl.distributors) || !dl.distributors.includes("dandh")) continue;

            const rawSku = cleanString(dl.raw_sku);
            const normalized_sku = cleanSKU(dl.normalized_sku);

            skuMeta[rawSku] = {
                raw_sku: rawSku,
                normalized_sku,
                upc,
                normalized_upc,
                manufacturer_map,
            };

            totalSkuCount++;
        }
    }

    if (totalSkuCount === 0) return true;

    /* =========================
       DH SKU mapping helper
    ========================= */

    async function getDHSku(originalSku: string) {
        const normFallback = cleanSKU(originalSku);

        const recRaw =
            (await db.collection("dist_dandh_raw").findOne({ sku: originalSku })) ??
            (await db.collection("dist_dandh_raw").findOne({ sku: normFallback })) ??
            null;

        if (recRaw?.d_h_sku !== undefined && recRaw?.d_h_sku !== null) {
            return String(recRaw.d_h_sku).trim();
        }

        return originalSku.replace(/ /g, "");
    }

    /* =========================
       SOAP call
    ========================= */

    async function callDandHAPI(partNums: string[]) {
        const xmlObj = {
            "SOAP-ENV:Envelope": {
                "@xmlns:SOAP-ENV": "http://schemas.xmlsoap.org/soap/envelope/",
                "@SOAP-ENV:encodingStyle": "http://schemas.xmlsoap.org/soap/encoding/",
                "SOAP-ENV:Body": {
                    XMLFORMPOST: {
                        REQUEST: "availability",
                        LOGIN: { USERID: "308041XML", PASSWORD: "Ecom2021" },
                        PARTNUM: partNums,
                    },
                },
            },
        };

        const xml = create(xmlObj).end({ prettyPrint: true });

        const res = await axios.post("https://www.dandh.com/dhXML/xmlDispatch", xml, {
            headers: { "Content-Type": "text/xml" },
            timeout: 480000,
            validateStatus: () => true,
        });

        return res.data;
    }

    /* =========================
       Batch SKUs
    ========================= */

    const allSkus = Object.keys(skuMeta);
    const batchSize = 100;

    const batches: string[][] = [];
    for (let i = 0; i < allSkus.length; i += batchSize) {
        batches.push(allSkus.slice(i, i + batchSize));
    }

    const limit = pLimit(2);
    
    const now = new Date();

    await Promise.all(
        batches.map((batch) =>
            limit(async () => {
                try {
                    const partNums = await Promise.all(batch.map((sku) => getDHSku(sku)));

                    let data: any;
                    try {
                        data = await callDandHAPI(partNums);
                    } catch {
                        // API hard-fail: write null response rows (retry will pick these up)
                        for (const sku of batch) {
                            const meta = skuMeta[sku];
                            const norm = cleanSKU(sku);

                            const priceRec =
                                (await db.collection("dist_dandh_raw").findOne({ sku })) ??
                                (await db.collection("dist_dandh_raw").findOne({ sku: norm })) ??
                                null;

                            const dandh_response: DandHResponsePayload = null;

                            await writeToBuffer({
                                sku: cleanString(meta.raw_sku),
                                normalized_sku: norm,
                                upc: meta.upc,
                                normalized_upc: meta.normalized_upc,
                                manufacturer: null,
                                manufacturer_map: cleanString(meta.manufacturer_map),
                                distributor: "dandh",
                                dandh_response,
                                dandh_price: priceRec?.price ?? null,
                                dandh_quantity: 0,
                                response: null,
                                created_at: now,
                                updated_at: now,
                                uploaded_file_url: UPLOADED_FILE_PATH,
                            });
                        }

                        await flushBuffer(false);
                        return;
                    }

                    const xmlStr: string = typeof data === "string" ? data : String(data);
                    const doc: any = new DOMParser().parseFromString(xmlStr, "text/xml");
                    const nodes: Node[] = (xpath.select("//ITEM", doc) as unknown) as Node[];

                    // PARTNUM -> parsed items (multiple ITEMs possible)
                    const responseMap: Record<string, DandHParsedItem[]> = {};
                    for (const node of nodes) {
                        const parsed = parseDandHItemNode(node);
                        const key = cleanString(parsed.partNum);
                        if (!responseMap[key]) responseMap[key] = [];
                        responseMap[key].push(parsed);
                    }

                    for (const originalSku of batch) {
                        const meta = skuMeta[originalSku];
                        const partKey = await getDHSku(originalSku);
                        const cleanedPartKey = cleanString(partKey);

                        const items = responseMap[cleanedPartKey] || [];
                        const totalQty = items.reduce((s, m) => s + Number(m.totalQty || 0), 0);

                        const norm = cleanSKU(originalSku);

                        const priceRec =
                            (await db.collection("dist_dandh_raw").findOne({ sku: originalSku })) ??
                            (await db.collection("dist_dandh_raw").findOne({ sku: norm })) ??
                            null;

                        // ✅ FIX: store parsed items directly (or null if missing)
                        const dandh_response: DandHResponsePayload = items.length ? items : null;

                        await writeToBuffer({
                            sku: cleanString(originalSku),
                            normalized_sku: norm,
                            upc: meta.upc ? cleanUPC(meta.upc) : null,
                            normalized_upc: meta.normalized_upc ? cleanUPC(meta.normalized_upc) : null,
                            manufacturer: null,
                            manufacturer_map: cleanString(meta.manufacturer_map),
                            distributor: "dandh",
                            dandh_response,
                            dandh_price: priceRec?.price ?? null,
                            dandh_quantity: totalQty,
                            response: null,
                            created_at: now,
                            updated_at: now,
                            uploaded_file_url: UPLOADED_FILE_PATH,
                        });
                    }

                    await flushBuffer(false);
                } catch (err: any) {
                    console.log("❌ Unexpected batch error:", err.message || err);

                    for (const sku of batch) {
                        const meta = skuMeta[sku];
                        const norm = cleanSKU(sku);

                        const dandh_response: DandHResponsePayload = null;

                        await writeToBuffer({
                            sku: cleanString(meta.raw_sku),
                            normalized_sku: norm,
                            upc: meta.upc ? cleanUPC(meta.upc) : null,
                            normalized_upc: meta.normalized_upc ? cleanUPC(meta.normalized_upc) : null,
                            manufacturer: null,
                            manufacturer_map: cleanString(meta.manufacturer_map),
                            distributor: "dandh",
                            dandh_response,
                            dandh_price: null,
                            dandh_quantity: 0,
                            response: null,
                            created_at: now,
                            updated_at: now,
                            uploaded_file_url: UPLOADED_FILE_PATH,
                        });
                    }

                    await flushBuffer(false);
                }
            })
        )
    );

    await flushBuffer(false);

    /* =========================
       Retry missing (null)
    ========================= */

    const retryRows = await table.find({ dandh_response: null }).project({ sku: 1 }).toArray();
    const retrySkus = retryRows.map((r: any) => cleanString(r.sku));

    if (retrySkus.length > 0) {
        const retryBatchSize = 20;
        const retryBatches: string[][] = [];
        for (let i = 0; i < retrySkus.length; i += retryBatchSize) {
            retryBatches.push(retrySkus.slice(i, i + retryBatchSize));
        }

        const retryLimit = pLimit(3);

        await Promise.all(
            retryBatches.map((rb) =>
                retryLimit(async () => {
                    try {
                        const partNums = await Promise.all(rb.map((sku) => getDHSku(sku)));
                        const resData = await callDandHAPI(partNums);

                        const xmlStr = typeof resData === "string" ? resData : String(resData);
                        const doc = new DOMParser().parseFromString(xmlStr, "text/xml");
                        const nodes = (xpath.select("//ITEM", doc) as unknown) as Node[];

                        const responseMap: Record<string, DandHParsedItem[]> = {};
                        for (const node of nodes) {
                            const parsed = parseDandHItemNode(node);
                            const key = cleanString(parsed.partNum);
                            if (!responseMap[key]) responseMap[key] = [];
                            responseMap[key].push(parsed);
                        }

                        for (const sku of rb) {
                            const partKey = await getDHSku(sku);
                            const cleanedPartKey = cleanString(partKey);

                            const items = responseMap[cleanedPartKey] || [];

                            if (items.length > 0) {
                                const totalQty = items.reduce((s, m) => s + Number(m.totalQty || 0), 0);
                                const norm = cleanSKU(sku);

                                const rawRecord =
                                    (await db.collection("dist_dandh_raw").findOne({ sku })) ??
                                    (await db.collection("dist_dandh_raw").findOne({ sku: norm })) ??
                                    null;

                                const dandh_response: DandHResponsePayload = items;

                                await table.updateOne(
                                    { sku },
                                    {
                                        $set: {
                                            dandh_response,
                                            dandh_price: rawRecord?.price ?? null,
                                            dandh_quantity: totalQty,
                                            response: null,
                                            updated_at: now,
                                        },
                                    }
                                );
                            } else {
                                // still missing after retry
                                await table.updateOne(
                                    { sku },
                                    {
                                        $set: {
                                            dandh_response: null,
                                            response: null,
                                            updated_at: now,
                                        },
                                    }
                                );
                            }
                        }
                    } catch (err: any) {
                        console.log("❌ Retry batch failed:", err.message || err);

                        for (const sku of rb) {
                            await table.updateOne(
                                { sku },
                                {
                                    $set: {
                                        dandh_response: null,
                                        response: null,
                                        updated_at: now,
                                    },
                                }
                            );
                        }
                    }
                })
            )
        );
    }

    return true;
}
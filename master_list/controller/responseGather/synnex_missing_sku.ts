
import axios from "axios";
import { create } from "xmlbuilder2";
import pLimit from "p-limit";
import fs from "fs";
import path from "path";
import { getDb } from "../../config/mongdodb.config";

/* ============================================================
   UNIVERSAL STRING CLEANER
   removes " ' and trims and collapses whitespace
   ============================================================ */
function cleanString(val: any): string {
    if (val === null || val === undefined) return "";
    return String(val)
        .replace(/["']/g, "") // remove quotes
        .replace(/\s+/g, " ") // collapse extra spaces
        .trim();
}

/**
 * FULL FINAL: buildSynnexResponseTable (Option 1: product_list missing category_class)
 */
export async function buildSynnexResponseTable2() {
    const db = await getDb("master_list");

    console.log("=================================================");
    console.log("🚀 START: Synnex Response Table Builder (OPTION 1)");
    console.log("=================================================\n");

    /* ============================================================
       PREP: create synnex_response_table and missing collection
       ============================================================ */
    await db.dropCollection("synnex_response_table_2s").catch(() => { });
    await db.createCollection("synnex_response_table_2s");
    const synnexTable = db.collection("synnex_response_table_2s");

    await synnexTable.createIndex({ sku: 1 }, { unique: true }).catch((e: any) =>
        console.log("Index create warning:", e.message)
    );

    // missing response collection (holds product_list items with empty category_class)
    await db.dropCollection("synnex_missing_response").catch(() => { });
    await db.createCollection("synnex_missing_response");
    const synnexMissing = db.collection("synnex_missing_response");

    console.log("✔ synnex_response_table & synnex_missing_response ready.\n");

    /* ============================================================
       BUFFER setup (JSONL)
       ============================================================ */
    const BUFFER_DIR = path.resolve("buffer");
    const BUFFER_FILE = path.join(BUFFER_DIR, "synnex_buffer.jsonl");
    fs.mkdirSync(BUFFER_DIR, { recursive: true });
    fs.writeFileSync(BUFFER_FILE, "");

    const BUFFER_LIMIT = 20000;
    let bufferCount = 0;
    let totalInserted = 0;

    async function flushBuffer() {
        try {
            const raw = fs.readFileSync(BUFFER_FILE, "utf8").trim();
            if (!raw) {
                bufferCount = 0;
                return;
            }

            const lines = raw.split("\n");
            const docs = lines.map((l) => JSON.parse(l));

            console.log(`📦 Flushing ${docs.length} → MongoDB...`);

            await synnexTable.insertMany(docs, { ordered: false }).catch((err: any) => {
                if (err?.code !== 11000) console.log("⚠ insertMany error:", err.message || err);
            });

            totalInserted += docs.length;
            bufferCount = 0;
            fs.writeFileSync(BUFFER_FILE, "");

            console.log(`✔ Synnex mising Flush complete. Total inserted: ${totalInserted}\n`);
        } catch (err: any) {
            console.log("❌ flushBuffer error:", err.message || err);
        }
    }

    async function writeToBuffer(doc: any) {
        try {
            fs.appendFileSync(BUFFER_FILE, JSON.stringify(doc) + "\n");
            bufferCount++;
            if (bufferCount >= BUFFER_LIMIT) {
                console.log(`⚡ Buffer full (${BUFFER_LIMIT}) — flushing...`);
                await flushBuffer();
            }
        } catch (err: any) {
            console.log("❌ writeToBuffer error:", err.message);
        }
    }

    /* ============================================================
       A) LOAD SKUs FROM product_list WHERE category_class IS NULL/EMPTY
       Insert into synnex_missing_response
       ============================================================ */
    console.log("📥 Reading product_list for SKUs with empty category_class...");

    const missingCursor = db.collection("product_list").find(
        {
            $or: [
                { category_class: { $exists: false } },
                { category_class: null },
                { category_class: "" },
            ],
        },
        {
            projection: {
                sku: 1,
                upc: 1,
                manufacturer_map: 1,
                distributor_list: 1,
                category_class: 1,
            },
        }
    );

    const skuMeta: Record<
        string,
        {
            raw_sku: string;
            normalized_sku: string;
            upc: string;
            normalized_upc: string;
            manufacturer_map: string | null;
        }
    > = {};

    let missingCount = 0;
    while (await missingCursor.hasNext()) {
        const item: any = await missingCursor.next();
        if (!item || !item.sku) continue;

        // Attempt to detect synnex-specific raw sku from distributor_list if present
        let synnexRawSku: string | null = null;
        if (Array.isArray(item.distributor_list)) {
            for (const dl of item.distributor_list) {
                // support both object and simple forms
                if (!dl) continue;
                const distributors = dl.distributors || dl.distributor || dl.name;
                if (!distributors) continue;
                if (Array.isArray(distributors) ? distributors.includes("synnex") : String(distributors).toLowerCase().includes("synnex")) {
                    synnexRawSku = dl.raw_sku || dl.normalized_sku || item.sku;
                    break;
                }
            }
        }

        // Insert into synnex_missing_response for record-keeping
        await synnexMissing.insertOne({
            sku: item.sku,
            synnex_raw_sku: synnexRawSku || item.sku,
            upc: item.upc || "",
            manufacturer_map: item.manufacturer_map || "",
            category_class: item.category_class || "",
            created_at: new Date(),
        }).catch((e: any) => {
            // if duplicate or other issue, just log
            if (e?.code !== 11000) console.log("synnex_missing_response insert warning:", e.message || e);
        });

        // populate skuMeta using synnexRawSku as key to call API with vendor part numbers
        const key = cleanString(synnexRawSku || item.sku);
        skuMeta[key] = {
            raw_sku: key,
            normalized_sku: cleanString(item.sku),
            upc: cleanString(item.upc || ""),
            normalized_upc: cleanString(item.upc || ""),
            manufacturer_map: cleanString(item.manufacturer_map || "") || null,
        };

        missingCount++;
    }

    console.log(`✔ synnex_missing_response saved: ${missingCount} items\n`);
    if (missingCount === 0) {
        console.log("No SKUs to process. Exiting.");
        return true;
    }

    /* ============================================================
       2) BUILD BATCHES OF 10 (API prefers small batches)
       ============================================================ */
    const allSkus = Object.keys(skuMeta).map(cleanString);
    const batchSize = 10;
    const batches: string[][] = [];

    for (let i = 0; i < allSkus.length; i += batchSize) {
        batches.push(allSkus.slice(i, i + batchSize));
    }

    const totalBatches = batches.length;
    console.log(`📊 Total batches: ${totalBatches}\n`);

    /* ============================================================
       3) SYNNEX API CALL
       ============================================================ */
    async function callSynnexAPI(batchSkus: string[]) {
        const xmlObj = {
            priceRequest: {
                customerNo: "617490",
                userName: "sales@ecommercebusinessprime.com",
                password: "EcomEBP@2025",
                skuList: batchSkus.map((s, idx) => ({ mfgPN: cleanString(s), lineNumber: idx + 1 })),
            },
        };
        const xml = create(xmlObj).end({ prettyPrint: true });

        const t0 = Date.now();
        const res = await axios.post(
            "https://ec.us.tdsynnex.com/SynnexXML/PriceAvailability",
            xml,
            { headers: { "Content-Type": "application/xml" }, timeout: 480000 }
        );
        console.log(`📥 API batch (${batchSkus.length}) OK — ${(Date.now() - t0) / 1000}s`);
        return res.data as string;
    }

    /* ============================================================
       4) PROCESS BATCHES (MAIN PASS)
       ============================================================ */
    const limit = pLimit(10);
    let batchIndex = 0;

    console.log("⚡ Starting API batches...\n");

    await Promise.all(
        batches.map((batch) =>
            limit(async () => {
                batchIndex++;
                const bn = batchIndex;
                console.log(`========== BATCH ${bn}/${totalBatches} ==========`);

                let xmlData: string = "";

                try {
                    xmlData = await callSynnexAPI(batch);
                } catch (err: any) {
                    console.log(`❌ Batch ${bn} API failure:`, err.message || err);

                    // mark each SKU in batch as error in buffer
                    for (const skuRaw of batch) {
                        const sku = cleanString(skuRaw);
                        const meta = skuMeta[sku];

                        await writeToBuffer({
                            sku,
                            raw_sku: sku,
                            normalized_sku: cleanString(meta?.normalized_sku),
                            upc: cleanString(meta?.upc),
                            normalized_upc: cleanString(meta?.normalized_upc),
                            manufacturer_map: cleanString(meta?.manufacturer_map),
                            distributor: "synnex",
                            synnex_response: "error",
                            synnex_price: null,
                            synnex_quantity: 0,
                            response: null,
                            created_at: new Date(),
                            updated_at: new Date(),
                        });
                    }

                    await flushBuffer();
                    return;
                }

                // Parse PriceAvailabilityList nodes
                const matches = [...xmlData.matchAll(/<PriceAvailabilityList>[\s\S]*?<\/PriceAvailabilityList>/gi)];
                const results: Record<string, { nodes: { price: number | null; qty: number; xml: string }[] }> = {};
                const parsed = new Set<string>();

                for (const m of matches) {
                    const nodeXml = cleanString(m[0]);
                    const skuMatch = nodeXml.match(/<mfgPN>(.*?)<\/mfgPN>/i);
                    if (!skuMatch) continue;

                    const sku = cleanString(skuMatch[1]);
                    parsed.add(sku);

                    const qtyMatch = nodeXml.match(/<totalQuantity>(.*?)<\/totalQuantity>/i);
                    const qty = qtyMatch ? Number(cleanString(qtyMatch[1])) : 0;

                    const priceMatch = nodeXml.match(/<price>(.*?)<\/price>/i);
                    const price = priceMatch ? Number(cleanString(priceMatch[1])) : null;

                    if (!results[sku]) results[sku] = { nodes: [] };
                    results[sku].nodes.push({ price, qty, xml: nodeXml });
                }

                // Write results for parsed SKUs
                for (const skuRaw of Object.keys(results)) {
                    const sku = cleanString(skuRaw);
                    const entry = results[sku];

                    const valid = entry.nodes.filter((n) => n.price !== null);
                    let lowestPrice: number | null = null;
                    let lowestQty = 0;

                    if (valid.length > 0) {
                        lowestPrice = Math.min(...valid.map((x) => x.price as number));
                        const node = valid.find((x) => x.price === lowestPrice);
                        lowestQty = node ? node.qty : 0;
                    }

                    const combinedXml = entry.nodes.map((n) => n.xml).join("\n");
                    const meta = skuMeta[sku];

                    await writeToBuffer({
                        sku,
                        raw_sku: sku,
                        normalized_sku: cleanString(meta?.normalized_sku ?? sku),
                        upc: cleanString(meta?.upc),
                        normalized_upc: cleanString(meta?.normalized_upc),
                        manufacturer_map: cleanString(meta?.manufacturer_map),
                        distributor: "synnex",
                        synnex_response: "ok",
                        synnex_price: lowestPrice,
                        synnex_quantity: lowestQty,
                        response: cleanString(combinedXml),
                        created_at: new Date(),
                        updated_at: new Date(),
                    });
                }

                // Missing SKUs in this batch
                for (const skuRaw of batch) {
                    const sku = cleanString(skuRaw);
                    if (!parsed.has(sku)) {
                        const meta = skuMeta[sku];
                        await writeToBuffer({
                            sku,
                            raw_sku: sku,
                            normalized_sku: cleanString(meta?.normalized_sku),
                            upc: cleanString(meta?.upc),
                            normalized_upc: cleanString(meta?.normalized_upc),
                            manufacturer_map: cleanString(meta?.manufacturer_map),
                            distributor: "synnex",
                            synnex_response: "missing",
                            synnex_price: null,
                            synnex_quantity: 0,
                            response: null,
                            created_at: new Date(),
                            updated_at: new Date(),
                        });
                    }
                }

                console.log(`✔ BATCH ${bn} DONE — flushing...`);
                await flushBuffer();
            })
        )
    );

    console.log("\n✔ All main batches done.\n");

    console.log("📦 Final flush...");
    await flushBuffer();

    /* ============================================================
       5) RETRY PASS — missing/error -> update synnex_response_table
       ============================================================ */
    console.log("\n=================================================");
    console.log("🔁 RETRY PASS");
    console.log("=================================================\n");

    // find documents previously inserted into synnex_response_table that are missing/error
    const retryDocs = await synnexTable
        .find(
            {
                synnex_response: { $in: ["missing", "error"] },
            },
            { projection: { sku: 1 } }
        )
        .toArray();

    // If buffer-based insertion hasn't yet created docs (e.g., first run), also check buffer-file-derived set:
    const retrySkusFromTable = retryDocs.map((d: any) => cleanString(d.sku));
    const retrySkusSet = new Set(retrySkusFromTable);

    // As a fallback, if table has no entries (e.g., first run and insertMany suppressed duplicates),
    // we may load the buffer file (if exists) to find 'missing'/'error' entries. But we will prefer DB entries.
    // Build final retry list from DB
    const retrySkus: any = Array.from(retrySkusSet);

    console.log(`🔎 SKUs needing retry: ${retrySkus.length}`);

    if (retrySkus.length === 0) {
        console.log("✔ No retry needed.");
        console.log("\n=================================================");
        console.log("🎉 FINISHED — FULL CLEANED SYNNE X TABLE");
        console.log("📊 Total inserted: ", totalInserted);
        console.log("=================================================\n");
        return true;
    }

    const retryBatchSize = 20;
    const retryBatches: string[][] = [];
    for (let i = 0; i < retrySkus.length; i += retryBatchSize) {
        retryBatches.push(retrySkus.slice(i, i + retryBatchSize));
    }

    let retryIndex = 0;
    const retryLimit = pLimit(3);

    await Promise.all(
        retryBatches.map((rb) =>
            retryLimit(async () => {
                retryIndex++;
                console.log(`🟧 RETRY BATCH ${retryIndex}/${retryBatches.length}`);

                let xmlData = "";
                try {
                    xmlData = await callSynnexAPI(rb);
                } catch (err: any) {
                    console.log(`❌ Retry batch ${retryIndex} API failure:`, err.message || err);
                    // mark them as missing_final in DB
                    for (const sku of rb) {
                        await synnexTable.updateOne(
                            { sku: cleanString(sku) },
                            { $set: { synnex_response: "missing_final", updated_at: new Date() } }
                        );
                    }
                    return;
                }

                const matches = [...xmlData.matchAll(/<PriceAvailabilityList>[\s\S]*?<\/PriceAvailabilityList>/gi)];

                const results: Record<string, { nodes: { price: number | null; qty: number; xml: string }[] }> = {};
                const found = new Set<string>();

                for (const m of matches) {
                    const node = cleanString(m[0]);
                    const skuMatch = node.match(/<mfgPN>(.*?)<\/mfgPN>/i);
                    if (!skuMatch) continue;

                    const sku = cleanString(skuMatch[1]);
                    found.add(sku);

                    const qtyMatch = node.match(/<totalQuantity>(.*?)<\/totalQuantity>/i);
                    const qty = qtyMatch ? Number(cleanString(qtyMatch[1])) : 0;

                    const priceMatch = node.match(/<price>(.*?)<\/price>/i);
                    const price = priceMatch ? Number(cleanString(priceMatch[1])) : null;

                    if (!results[sku]) results[sku] = { nodes: [] };
                    results[sku].nodes.push({ price, qty, xml: node });
                }

                // Update found
                for (const sku of Object.keys(results)) {
                    const entry = results[sku];
                    const valid = entry.nodes.filter((n) => n.price !== null);

                    let lowestPrice: number | null = null;
                    let lowestQty = 0;

                    if (valid.length > 0) {
                        lowestPrice = Math.min(...valid.map((v) => v.price as number));
                        const node = valid.find((n) => n.price === lowestPrice);
                        lowestQty = node ? node.qty : 0;
                    }

                    const combinedXml = entry.nodes.map((n) => n.xml).join("\n");

                    await synnexTable.updateOne(
                        { sku: cleanString(sku) },
                        {
                            $set: {
                                synnex_response: "ok",
                                synnex_price: lowestPrice,
                                synnex_quantity: lowestQty,
                                response: cleanString(combinedXml),
                                updated_at: new Date(),
                            },
                        }
                    );
                }

                // Mark unfound
                for (const sku of rb) {
                    if (!found.has(sku)) {
                        await synnexTable.updateOne(
                            { sku: cleanString(sku) },
                            { $set: { synnex_response: "missing_final", updated_at: new Date() } }
                        );
                    }
                }

                console.log(`✔ RETRY BATCH ${retryIndex} DONE`);
            })
        )
    );

    console.log("\n=================================================");
    console.log("🎉 FINISHED — FULL CLEANED SYNNE X TABLE");
    console.log("📊 Total inserted: ", totalInserted);
    console.log("=================================================\n");

    return true;
}



export async function buildSynnexSimilarMissingCat() {
    const db = await getDb("master_list");
    const productCol = db.collection("product_list");
    const synnexRespCol = db.collection("synnex_response_table");
    const missingCatCol = db.collection("synnex_simmilar_missingcat");

    const distSupplies = db.collection("dist_supplies_raw");
    const distIngram = db.collection("dist_ingram_raw");
    const distDandh = db.collection("dist_dandh_raw");

    console.log("🔄 Loading SKUs from synnex_response_table...");
    const synnexSKUs = await synnexRespCol.find().toArray();

    const normalizedSkuList = synnexSKUs.map((x: any) => x.sku);

    console.log(`📦 Found ${normalizedSkuList.length} SKUs`);

    console.log("🔎 Matching products in product_list...");
    const products = await productCol.find({
        sku: { $in: normalizedSkuList }
    }).toArray();

    console.log(`✔ Matched ${products.length} products`);

    const outputDocs: any[] = [];

    for (const p of products) {
        let raw_category_class = "";
        let raw_category_class_l2 = "";
        let raw_category_class_l3 = "";

        const distList = p.distributor_list || [];

        for (const d of distList) {
            // SUPPLIES NETWORK
            if (d === "supplies") {
                const s = await distSupplies.findOne({ sku: p.sku });
                if (s) {
                    raw_category_class = s.category_class || "";
                    raw_category_class_l2 = s.category_class_l2 || "";
                    raw_category_class_l3 = s.category_class_l3 || "";
                }
            }

            // INGRAM
            if (d === "ingram") {
                const i = await distIngram.findOne({ sku: p.sku });
                if (i) {
                    raw_category_class = i.type || "";
                    raw_category_class_l2 = i.subType || "";
                    raw_category_class_l3 = "";
                }
            }

            // D&H
            if (d === "dandh") {
                const dh = await distDandh.findOne({ sku: p.sku });
                if (dh) {
                    raw_category_class = dh.category_class || "";
                    raw_category_class_l2 = dh.category_class_l2 || "";
                    raw_category_class_l3 = dh.category_class_l3 || "";
                }
            }
        }

        outputDocs.push({
            ...p,
            raw_category_class,
            raw_category_class_l2,
            raw_category_class_l3,
            inserted_at: new Date()
        });
    }

    console.log("📝 Saving to synnex_simmilar_missingcat...");
    if (outputDocs.length > 0) {
        await missingCatCol.insertMany(outputDocs);
    }

    console.log("🎉 DONE — Inserted:", outputDocs.length);
}
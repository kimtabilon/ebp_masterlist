import fs from "fs";
import path from "path";
import { getDb } from "../../config/mongdodb.config";

/* ============================================================
   UTILITIES
============================================================ */

function normalizeSku(sku: any): string {
    if (sku === null || sku === undefined) return "";
    return String(sku).replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

// Case-insensitive + whitespace-removed comparison key
function cleanForCompare(val: any): string {
    if (!val) return "";
    return String(val)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .trim();
}


/* ============================================================
   SAFE CLEANERS
============================================================ */
function clean(val: any): string {
    if (!val) return "";
    return String(val).trim();
}



/* ============================================================
   CATEGORY VALIDATION — MUST NOT BE EMPTY
============================================================ */
function hasValidCategory(cat: any): boolean {
    if (!cat) return false;

    return (
        (cat.category_class && cat.category_class.trim() !== "") ||
        (cat.category_class_l2 && cat.category_class_l2.trim() !== "") ||
        (cat.category_class_l3 && cat.category_class_l3.trim() !== "")
    );
}

/* ---------------------- logging ---------------------- */
function openLogStream(): fs.WriteStream {
    const logDir = path.join(process.cwd(), "logs");
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, "fixMissingCategories.debug v2.log");
    return fs.createWriteStream(logPath, { flags: "a" });
}
function timestamp() {
    return new Date().toISOString();
}
/* ---------------------- main function ---------------------- */
export async function fixMissingCategoriesFast(): Promise<{ updated: number }> {
    const db: any = await getDb('master_list');

    const productList = db.collection("product_list");
    const synnexRaw = db.collection("dist_synnex_raw");
    const dandhRaw = db.collection("dist_dandh_raw");
    const ingramRaw = db.collection("dist_ingram_raw");
    const suppliesRaw = db.collection("dist_supplies_raw");

    const logStream = openLogStream();
    const log = (...args: any[]) => {
        const msg = args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
        logStream.write(`[${timestamp()}] ${msg}\n`);
    };

    const logSkuHeader = (i: number, total: number, rawSku: any, key: string) => {
        log("----------------------------------------------------------------");
        log(`SKU ${i}/${total} -> rawSku=${rawSku} normalizedKey=${key}`);
    };

    try {
        log("================================================================");
        log("🚀 START: fixMissingCategoriesFastDebug (ULTRA DETAILED)");
        log("================================================================\n");

        /* ============== 1) Load missing SKUs ============== */
        log("📥 Loading SKUs missing categories (empty/null/not exists) ...");

        const missing = await productList
            .find(
                {
                    $or: [
                        { category_class: "" },
                        { category_class: null },
                        { category_class: { $exists: false } }
                    ]
                },
                { projection: { sku: 1, normalized_sku: 1 } }
            )
            .toArray();

        log(`🔍 Missing category SKUs found: ${missing.length}\n`);

        /* ============== 2) Load distributor maps ============== */
        log("📥 Loading distributor tables into memory (this may take some time) ...");

        const synMap = new Map<string, any>(); // key -> {category fields}
        const ingMeta = new Map<string, any>(); // key -> {manufacturer, type}
        const ingGroups = new Map<string, Set<string>>(); // man|type -> set(keys)
        const dhMeta = new Map<string, any>(); // key -> {manufacturer, category_class}
        const dhGroups = new Map<string, Set<string>>(); // man|category -> set(keys)
        const supMeta = new Map<string, any>(); // key -> {manufacturer, category_class}
        const supGroups = new Map<string, Set<string>>(); // man|category -> set(keys)

        /* -- SYNNEX -- */
        log("  - Loading SYNNEX rows...");
        let synCount = 0;
        const synCursor = synnexRaw.find({}, {
            projection: { sku: 1, normalized_sku: 1, category_class: 1, category_class_l2: 1, category_class_l3: 1 }
        });
        while (await synCursor.hasNext()) {
            const r: any = await synCursor.next();
            const key = normalizeSku(r.normalized_sku ?? r.sku);
            if (!key) continue;
            synMap.set(key, {
                category_class: clean(r.category_class),
                category_class_l2: clean(r.category_class_l2),
                category_class_l3: clean(r.category_class_l3)
            });
            synCount++;
        }
        log(`    SYNNEX entries loaded: ${synCount}`);

        /* -- INGRAM -- */
        log("  - Loading INGRAM rows...");
        let ingCount = 0;
        const ingCursor = ingramRaw.find({}, {
            projection: { sku: 1, normalized_sku: 1, manufacturer: 1, type: 1 }
        });
        while (await ingCursor.hasNext()) {
            const r: any = await ingCursor.next();
            const key = normalizeSku(r.normalized_sku ?? r.sku);
            if (!key) continue;
            const manRaw = clean(r.manufacturer);
            const typeRaw = clean(r.type);
            ingMeta.set(key, { manRaw, typeRaw });

            const man = cleanForCompare(r.manufacturer);
            const typ = cleanForCompare(r.type);
            if (man && typ) {
                const id = `${man}|${typ}`;
                if (!ingGroups.has(id)) ingGroups.set(id, new Set());
                ingGroups.get(id)!.add(key);
            }
            ingCount++;
        }
        log(`    INGRAM entries loaded: ${ingCount}`);

        /* -- D&H -- */
        log("  - Loading D&H rows...");
        let dhCount = 0;
        const dhCursor = dandhRaw.find({}, {
            projection: { sku: 1, normalized_sku: 1, manufacturer: 1, category_class: 1 }
        });
        while (await dhCursor.hasNext()) {
            const r: any = await dhCursor.next();
            const key = normalizeSku(r.normalized_sku ?? r.sku);
            if (!key) continue;
            const manRaw = clean(r.manufacturer);
            const catRaw = clean(r.category_class);
            dhMeta.set(key, { manRaw, catRaw });

            const man = cleanForCompare(r.manufacturer);
            const cat = cleanForCompare(r.category_class);
            if (man && cat) {
                const id = `${man}|${cat}`;
                if (!dhGroups.has(id)) dhGroups.set(id, new Set());
                dhGroups.get(id)!.add(key);
            }
            dhCount++;
        }
        log(`    D&H entries loaded: ${dhCount}`);

        /* -- SUPPLIES -- */
        log("  - Loading SUPPLIES rows...");
        let supCount = 0;
        const supCursor = suppliesRaw.find({}, {
            projection: { sku: 1, normalized_sku: 1, manufacturer: 1, category_class: 1 }
        });
        while (await supCursor.hasNext()) {
            const r: any = await supCursor.next();
            const key = normalizeSku(r.normalized_sku ?? r.sku);
            if (!key) continue;
            const manRaw = clean(r.manufacturer);
            const catRaw = clean(r.category_class);
            supMeta.set(key, { manRaw, catRaw });

            const man = cleanForCompare(r.manufacturer);
            const cat = cleanForCompare(r.category_class);
            if (man && cat) {
                const id = `${man}|${cat}`;
                if (!supGroups.has(id)) supGroups.set(id, new Set());
                supGroups.get(id)!.add(key);
            }
            supCount++;
        }
        log(`    SUPPLIES entries loaded: ${supCount}`);

        log("✔ Distributor tables loaded into memory.\n");

        /* ============== 3) Load existing product_list categories (samples) ============== */
        log("📥 Loading existing product_list categories (for sampling matches) ...");
        const productCatMap = new Map<string, any>();
        let prodCount = 0;
        const prodCursor = productList.find(
            { category_class: { $nin: ["", null] } },
            { projection: { normalized_sku: 1, category_class: 1, category_class_l2: 1, category_class_l3: 1 } }
        );
        while (await prodCursor.hasNext()) {
            const r: any = await prodCursor.next();
            const key = normalizeSku(r.normalized_sku);
            if (!key) continue;
            const cat = {
                category_class: clean(r.category_class),
                category_class_l2: clean(r.category_class_l2),
                category_class_l3: clean(r.category_class_l3)
            };
            if (hasValidCategory(cat)) {
                productCatMap.set(key, cat);
                prodCount++;
            }
        }
        log(`✔ Loaded ${prodCount} existing product_list categories for matching.\n`);

        /* ============== 4) Process missing SKUs (with ultra-detailed logs) ============== */
        log("🛠 Processing missing SKUs (will log each decision)...");

        let bulkOps: any[] = [];
        let updated = 0;
        let cntSyn = 0, cntIng = 0, cntDandh = 0, cntSup = 0, cntNone = 0;
        let idx = 0;

        for (const item of missing) {
            idx++;
            const rawSku = item.sku;
            const key = normalizeSku(item.normalized_sku ?? item.sku);
            logSkuHeader(idx, missing.length, rawSku, key);

            if (!key) {
                cntNone++;
                log("⚠ Invalid/empty normalized key — skipping");
                continue;
            }

            let matched = false;
            let chosenCat: any = null;

            /* ---- 1) SYNNEX direct exact key ---- */
            log("[STEP] Check SYNNEX direct key");
            if (synMap.has(key)) {
                const cat = synMap.get(key);
                log("  SYNNEX entry found:", cat);
                if (hasValidCategory(cat)) {
                    chosenCat = cat;
                    matched = true;
                    cntSyn++;
                    log("  >>> SYNNEX provided VALID category — selecting");
                } else {
                    log("  SYNNEX entry categories EMPTY — skip as source is empty");
                }
            } else {
                log("  SYNNEX: no entry for key");
            }

            if (matched) {
                bulkOps.push({ updateOne: { filter: { normalized_sku: key }, update: { $set: chosenCat } } });
                updated++;
                if (bulkOps.length >= 1000) {
                    log(`[BULK] flushing ${bulkOps.length} ops (post-syn)`);
                    try { await productList.bulkWrite(bulkOps, { ordered: false }); log("[BULK] flush OK"); } catch (e: any) { log("[BULK] ERR:", e.message || e); }
                    bulkOps = [];
                }
                continue;
            }

            /* ---- meta extraction for manufacturer/type/category ---- */
            const metaIng = ingMeta.get(key) || {};
            const metaDh = dhMeta.get(key) || {};
            const metaSup = supMeta.get(key) || {};
            log("[META] ing:", metaIng, "dh:", metaDh, "sup:", metaSup);

            const manClean =
                cleanForCompare(metaIng.manRaw) ||
                cleanForCompare(metaDh.manRaw) ||
                cleanForCompare(metaSup.manRaw);

            const typeClean = cleanForCompare(metaIng.typeRaw);
            const catClean = cleanForCompare(metaDh.catRaw) || cleanForCompare(metaSup.catRaw);

            log(`[META CLEAN] man=${manClean} type=${typeClean} cat=${catClean}`);

            /* ---- 2) INGRAM group match (manufacturer + type) ---- */
            if (manClean && typeClean) {
                const id = `${manClean}|${typeClean}`;
                log(`[STEP] INGRAM group lookup id=${id}`);
                const group = ingGroups.get(id);
                if (!group) {
                    log("  INGRAM group NOT FOUND for id");
                } else {
                    log(`  INGRAM group FOUND (size=${group.size}) — scanning group for product_list sample categories`);
                    for (const gkey of group) {
                        log(`    check gkey=${gkey}`);

                        if (productCatMap.has(gkey)) {
                            const sampleCat = productCatMap.get(gkey);
                            log(`      sampleCat found for gkey=${gkey}:`, sampleCat);
                            if (hasValidCategory(sampleCat)) {
                                chosenCat = sampleCat;
                                matched = true;
                                cntIng++;
                                log("      >>> MATCHED via INGRAM sample — selecting");
                                break;
                            } else {
                                log("      sampleCat invalid (empty) — skip");
                            }
                        } else {
                            log("      no product_list category for gkey");
                        }
                    }
                }
            } else {
                log("[INGRAM] skipped — insufficient meta (man/type)");
            }

            if (matched) {
                bulkOps.push({ updateOne: { filter: { normalized_sku: key }, update: { $set: chosenCat } } });
                updated++;
                if (bulkOps.length >= 1000) {
                    log(`[BULK] flushing ${bulkOps.length} ops (post-ing)`);
                    try { await productList.bulkWrite(bulkOps, { ordered: false }); log("[BULK] flush OK"); } catch (e: any) { log("[BULK] ERR:", e.message || e); }
                    bulkOps = [];
                }
                continue;
            }

            /* ---- 3) D&H group match (manufacturer + category) ---- */
            if (manClean && catClean) {
                const id = `${manClean}|${catClean}`;
                log(`[STEP] D&H group lookup id=${id}`);
                const group = dhGroups.get(id);
                if (!group) {
                    log("  D&H group NOT FOUND for id");
                } else {
                    log(`  D&H group FOUND (size=${group.size}) — scanning group for sample categories`);
                    for (const gkey of group) {
                        log(`    check gkey=${gkey}`);
                        if (productCatMap.has(gkey)) {
                            const sampleCat = productCatMap.get(gkey);
                            log(`      sampleCat found:`, sampleCat);
                            if (hasValidCategory(sampleCat)) {
                                chosenCat = sampleCat;
                                matched = true;
                                cntDandh++;
                                log("      >>> MATCHED via D&H sample — selecting");
                                break;
                            } else {
                                log("      sampleCat invalid — skip");
                            }
                        } else {
                            log("      no product_list category for gkey");
                        }
                    }
                }
            } else {
                log("[D&H] skipped — insufficient meta (man/category)");
            }

            if (matched) {
                bulkOps.push({ updateOne: { filter: { normalized_sku: key }, update: { $set: chosenCat } } });
                updated++;
                if (bulkOps.length >= 1000) {
                    log(`[BULK] flushing ${bulkOps.length} ops (post-dh)`);
                    try { await productList.bulkWrite(bulkOps, { ordered: false }); log("[BULK] flush OK"); } catch (e: any) { log("[BULK] ERR:", e.message || e); }
                    bulkOps = [];
                }
                continue;
            }

            /* ---- 4) SUPPLIES group match (manufacturer + category) ---- */
            if (manClean && catClean) {
                const id = `${manClean}|${catClean}`;
                log(`[STEP] SUPPLIES group lookup id=${id}`);
                const group = supGroups.get(id);
                if (!group) {
                    log("  SUPPLIES group NOT FOUND for id");
                } else {
                    log(`  SUPPLIES group FOUND (size=${group.size}) — scanning group`);
                    for (const gkey of group) {
                        log(`    check gkey=${gkey}`);
                        if (productCatMap.has(gkey)) {
                            const sampleCat = productCatMap.get(gkey);
                            log(`      sampleCat found:`, sampleCat);
                            if (hasValidCategory(sampleCat)) {
                                chosenCat = sampleCat;
                                matched = true;
                                cntSup++;
                                log("      >>> MATCHED via SUPPLIES sample — selecting");
                                break;
                            } else {
                                log("      sampleCat invalid — skip");
                            }
                        } else {
                            log("      no product_list category for gkey");
                        }
                    }
                }
            } else {
                log("[SUPPLIES] skipped — insufficient meta (man/category)");
            }

            if (!matched) {
                cntNone++;
                log("⛔ NO MATCH FOUND for key -> leaving as missing");
            } else {
                // queue final update for chosenCat
                bulkOps.push({ updateOne: { filter: { normalized_sku: key }, update: { $set: chosenCat } } });
                updated++;
            }

            /* flush if needed */
            if (bulkOps.length >= 1000) {
                log(`[BULK] flushing ${bulkOps.length} ops (periodic)`);
                try {
                    await productList.bulkWrite(bulkOps, { ordered: false });
                    log("[BULK] flush OK");
                } catch (err: any) {
                    log("[BULK] flush ERROR:", err.message || err);
                }
                bulkOps = [];
            }
        } // end for missing

        /* final flush */
        if (bulkOps.length > 0) {
            log(`[BULK] final flush ${bulkOps.length} ops`);
            try {
                await productList.bulkWrite(bulkOps, { ordered: false });
                log("[BULK] final flush OK");
            } catch (err: any) {
                log("[BULK] final flush ERROR:", err.message || err);
            }
            bulkOps = [];
        }

        /* ============== Summary ============== */
        log("\n========== SUMMARY ==========");
        log(`Total missing SKUs: ${missing.length}`);
        log(`Updated SKUs: ${updated}`);
        log(`Synnex matches: ${cntSyn}`);
        log(`Ingram matches: ${cntIng}`);
        log(`D&H matches: ${cntDandh}`);
        log(`Supplies matches: ${cntSup}`);
        log(`No matches left: ${cntNone}`);
        log("==============================\n");

        log("✅ fixMissingCategoriesFastDebug finished.");
        return { updated };

    } catch (err: any) {
        log("❌ ERROR in fixMissingCategoriesFastDebug:", err && err.message ? err.message : err);
        throw err;
    } finally {
        logStream.end();
    }
}



// ============================================================================
// FIX MISSING CATEGORIES — FINAL PATCHED VERSION
// Distributor-by-distributor algorithm (your version EXACTLY)
// Ultra-detailed logs
// ============================================================================

// for distributor tables OTHER THAN synnex
function normalizeKeyFromSku(sku: string): string {
    if (!sku) return "";
    return sku.replace(/[^a-zA-Z0-9]/g, "").trim();
}

// used for matching manufacturer/type/category
function cleanCompare(val: any): string {
    if (!val) return "";
    return String(val).toLowerCase().replace(/\s+/g, "").replace(/[^a-z0-9]/g, "");
}

export async function fixMissingCategoriesFinal(): Promise<{ updated: number }> {
    const db: any = await getDb('master_list');
    const productList = db.collection("product_list");

    // distributor tables
    const synRaw = db.collection("dist_synnex_raw");
    const ingRaw = db.collection("dist_ingram_raw");
    const dhRaw = db.collection("dist_dandh_raw");
    const supRaw = db.collection("dist_supplies_raw");

    // ---------------------- LOGGING SETUP -----------------------
    const logDir = path.join(process.cwd(), "logs");
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

    const logPath = path.join(logDir, "fixMissingCategories.debug.log");
    const logStream = fs.createWriteStream(logPath, { flags: "a" });

    function log(...args: any[]) {
        const msg = args
            .map(a => typeof a === "object" ? JSON.stringify(a) : String(a))
            .join(" ");
        logStream.write(`[${new Date().toISOString()}] ${msg}\n`);
    }

    log("========================================================");
    log("🚀 START fixMissingCategoriesFinal");
    log("========================================================");

    // ---------------------- LOAD MISSING -----------------------
    log("📥 Loading SKUs missing categories...");

    const missing = await productList.find(
        {
            $or: [
                { category_class: null },
                { category_class: "" }
            ]
        },
        { projection: { sku: 1, normalized_sku: 1 } }
    ).toArray();

    log(`🔍 Missing count: ${missing.length}`);

    let updated = 0;

    // ---------------------- MAIN LOOP --------------------------
    let i = 0;
    for (const item of missing) {
        i++;

        const rawSku = clean(item.sku);
        const key = clean(item.normalized_sku);  // always use normalized_sku from product_list
        log("--------------------------------------------------------");
        log(`SKU ${i}/${missing.length}`);
        log(`rawSku=${rawSku} key=${key}`);

        if (!key) {
            log("❌ Invalid key — skip");
            continue;
        }

        let matched = false;

        // ============================================================
        //  1) TRY SYNNEX (has its own normalized_sku)
        // ============================================================
        log("[STEP] Synnex matching...");

        const synDoc = await synRaw.findOne(
            { normalized_sku: key },
            { projection: { manufacturer: 1, category_class: 1, category_class_l2: 1, category_class_l3: 1 } }
        );

        if (synDoc) {
            log("  Found synnex entry:", synDoc);
            const man = cleanCompare(synDoc.manufacturer);
            const cat = cleanCompare(synDoc.category_class);

            if (man && cat) {
                // find same entries in synnex table
                const groupCursor = synRaw.find({
                    manufacturer: { $exists: true },
                    category_class: { $exists: true }
                });

                while (await groupCursor.hasNext()) {
                    const r: any = await groupCursor.next();

                    const man2 = cleanCompare(r.manufacturer);
                    const cat2 = cleanCompare(r.category_class);

                    if (man === man2 && cat === cat2) {
                        const candidateKey = clean(r.normalized_sku);
                        if (!candidateKey) continue;

                        const productCat = await productList.findOne(
                            {
                                normalized_sku: candidateKey,
                                category_class: { $nin: ["", null] }
                            },
                            { projection: { category_class: 1, category_class_l2: 1, category_class_l3: 1 } }
                        );

                        if (productCat) {
                            log("  >>> MATCHED SYNNEX:", productCat);

                            await productList.updateOne(
                                { normalized_sku: key },
                                { $set: productCat }
                            );

                            updated++;
                            matched = true;
                            break;
                        }
                    }
                }
            }
        }

        if (matched) continue;

        // ============================================================
        //  2) TRY INGRAM (manufacturer + type)
        // ============================================================
        log("[STEP] Ingram matching...");

        const ingDoc = await ingRaw.findOne(
            {
                $or: [
                    { normalized_sku: key },
                    { sku: { $regex: new RegExp("^" + key, "i") } }
                ]
            },
            { projection: { manufacturer: 1, type: 1 } }
        );

        if (ingDoc) {
            log("  Found ingram entry:", ingDoc);

            const man = cleanCompare(ingDoc.manufacturer);
            const typ = cleanCompare(ingDoc.type);

            if (man && typ) {
                const groupCursor = ingRaw.find({
                    manufacturer: { $exists: true },
                    type: { $exists: true }
                });

                while (await groupCursor.hasNext()) {
                    const r: any = await groupCursor.next();

                    const man2 = cleanCompare(r.manufacturer);
                    const typ2 = cleanCompare(r.type);

                    if (man === man2 && typ === typ2) {
                        const candidateKey = normalizeKeyFromSku(r.sku);

                        const productCat = await productList.findOne(
                            {
                                normalized_sku: candidateKey,
                                category_class: { $nin: ["", null] }
                            },
                            { projection: { category_class: 1, category_class_l2: 1, category_class_l3: 1 } }
                        );

                        if (productCat) {
                            log("  >>> MATCHED INGRAM:", productCat);

                            await productList.updateOne(
                                { normalized_sku: key },
                                { $set: productCat }
                            );

                            updated++;
                            matched = true;
                            break;
                        }
                    }
                }
            }
        }

        if (matched) continue;

        // ============================================================
        //  3) TRY D&H (manufacturer + category_class)
        // ============================================================
        log("[STEP] D&H matching...");

        const dhDoc = await dhRaw.findOne(
            {
                $or: [
                    { normalized_sku: key },
                    { sku: { $regex: new RegExp("^" + key, "i") } }
                ]
            },
            { projection: { manufacturer: 1, category_class: 1 } }
        );

        if (dhDoc) {
            log("  Found D&H entry:", dhDoc);

            const man = cleanCompare(dhDoc.manufacturer);
            const cat = cleanCompare(dhDoc.category_class);

            if (man && cat) {
                const groupCursor = dhRaw.find({
                    manufacturer: { $exists: true },
                    category_class: { $exists: true }
                });

                while (await groupCursor.hasNext()) {
                    const r: any = await groupCursor.next();

                    const man2 = cleanCompare(r.manufacturer);
                    const cat2 = cleanCompare(r.category_class);

                    if (man === man2 && cat === cat2) {
                        const candidateKey = normalizeKeyFromSku(r.sku);

                        const productCat = await productList.findOne(
                            {
                                normalized_sku: candidateKey,
                                category_class: { $nin: ["", null] }
                            },
                            { projection: { category_class: 1, category_class_l2: 1, category_class_l3: 1 } }
                        );

                        if (productCat) {
                            log("  >>> MATCHED D&H:", productCat);

                            await productList.updateOne(
                                { normalized_sku: key },
                                { $set: productCat }
                            );

                            updated++;
                            matched = true;
                            break;
                        }
                    }
                }
            }
        }

        if (matched) continue;

        // ============================================================
        //  4) TRY SUPPLIES (manufacturer + type)
        // ============================================================
        log("[STEP] Supplies matching...");

        const supDoc = await supRaw.findOne(
            {
                $or: [
                    { normalized_sku: key },
                    { sku: { $regex: new RegExp("^" + key, "i") } }
                ]
            },
            { projection: { manufacturer: 1, type: 1 } }
        );

        if (supDoc) {
            log("  Found Supplies entry:", supDoc);

            const man = cleanCompare(supDoc.manufacturer);
            const typ = cleanCompare(supDoc.type);

            if (man && typ) {
                const groupCursor = supRaw.find({
                    manufacturer: { $exists: true },
                    type: { $exists: true }
                });

                while (await groupCursor.hasNext()) {
                    const r: any = await groupCursor.next();

                    const man2 = cleanCompare(r.manufacturer);
                    const typ2 = cleanCompare(r.type);

                    if (man === man2 && typ === typ2) {
                        const candidateKey = normalizeKeyFromSku(r.sku);

                        const productCat = await productList.findOne(
                            {
                                normalized_sku: candidateKey,
                                category_class: { $nin: ["", null] }
                            },
                            { projection: { category_class: 1, category_class_l2: 1, category_class_l3: 1 } }
                        );

                        if (productCat) {
                            log("  >>> MATCHED SUPPLIES:", productCat);

                            await productList.updateOne(
                                { normalized_sku: key },
                                { $set: productCat }
                            );

                            updated++;
                            matched = true;
                            break;
                        }
                    }
                }
            }
        }

        if (!matched) {
            log("⛔ NO MATCH FOUND for key =", key);
        }
    }

    log("========================================================");
    log("🎉 FINISHED");
    log(`Updated: ${updated}`);
    log("========================================================");

    logStream.end();

    return { updated };
}

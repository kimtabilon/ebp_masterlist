import { getDb } from "../config/mongdodb.config";
import { primeInventory } from "../utils/prime_inventory";
import { normalizeSku } from "../utils/normalize";


/* =========================================
   BUNDLES
========================================= */
const bundles_4pk = [
    "C331HC0, C331HK0, C331HM0, C331HY0",
    "C320010,C320020,C320030,C320040",
    "006R04391, 006R04392, 006R04393, 006R04394",
    "C3210C0, C3210K0, C3210M0, C3210Y0",
    "20N1HC0, 20N1HK0, 20N1HM0, 20N1HY0",
    "20N10C0, 20N10K0, 20N10M0, 20N10Y0",
];

const bundles_2pk = ["C320010-2PK", "C3210K0-2PK", "C331HK0-2PK", "20N1HK0-2PK", "20N10K0-2PK"];

const allDistributors = ["dandh", "synnex", "ingram", "supplies"] as const;
type Dist = (typeof allDistributors)[number];

type MasterListDoc = {
    sku: string;

    // your sample uses *_quantity, but some older data may use *_count
    dandh_quantity?: number;
    synnex_quantity?: number;
    ingram_quantity?: number;
    supplies_quantity?: number;

    dandh_count?: number;
    synnex_count?: number;
    ingram_count?: number;
    supplies_count?: number;

    dandh_price?: number;
    synnex_price?: number;
    ingram_price?: number;
    supplies_price?: number;

    dandh_response?: any;
    synnex_response?: any;
    ingram_response?: any;
    supplies_response?: any;

    category_class?: string | null;
    category_class_l2?: string | null;
    category_class_l3?: string | null;

    priority?: string | null;

    created_at?: Date;
    updated_at?: Date;

    [k: string]: any;
};

/* =========================================
   HELPERS
========================================= */
// function normalizeSku(s: string) {
//     return String(s ?? "").trim().toUpperCase();
// }

function toNum(v: any) {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
}

/** read qty with support for BOTH schemas: *_quantity OR *_count */
function getQty(doc: any, d: Dist): number {
    const raw = doc?.[`${d}_quantity`];
    if (raw != null) return toNum(raw);
    return toNum(doc?.[`${d}_count`]);
}

function getPrice(doc: any, d: Dist): number {
    return toNum(doc?.[`${d}_price`]);
}

function getResponse(doc: any, d: Dist): any {
    const v = doc?.[`${d}_response`];
    return v ?? null;
}

function resolveHighestDistributor(counts: Record<string, number>) {
    const priorityOrder: Dist[] = ["dandh", "synnex", "ingram", "supplies"];

    const entries = Object.entries(counts)
        .map(([k, v]) => ({ key: k.replace("_qty", "") as Dist, value: toNum(v) }))
        .filter((e) => e.value > 0);

    if (!entries.length) return null;

    const max = Math.max(...entries.map((e) => e.value));
    return priorityOrder.find((p) => entries.some((e) => e.key === p && e.value === max)) || null;
}

function hasStockingInventory(resp: any): boolean {
    if (!resp) return false;

    // flat response
    if (typeof resp.total_inventory !== "undefined") {
        return Number(resp.total_inventory ?? 0) > 0;
    }

    // wrapped response
    const row = resp?.data?.[0];
    if (!row) return false;

    return Number(row.total_inventory ?? 0) > 0;
}

/** 4PK: remove commas + whitespace ONLY */
// function normalizeBundleSkuForStocking(bundleSku: string): string {
//     return String(bundleSku ?? "")
//         .toUpperCase()
//         .replace(/[,\s]+/g, "");
// }

async function bundleHasStocking_4pk(bundleSku: string) {
    const skuNormalized = normalizeSku(bundleSku);
    const inv: any = await primeInventory(skuNormalized);
    return hasStockingInventory(inv);
}

/** normalizeSku imported from utils/normalize */

async function bundleHasStocking_2pk(baseSku: string) {
    const skuNormalized = normalizeSku(baseSku);
    const inv: any = await primeInventory(skuNormalized);
    return hasStockingInventory(inv);
}

/** ✅ ONLY fields you asked to copy */
function pickCategoryFromDoc(src: any) {
    return {
        category_class: (src?.category_class ?? null) as string | null,
        category_class_l2: (src?.category_class_l2 ?? null) as string | null,
        category_class_l3: (src?.category_class_l3 ?? null) as string | null,
    };
}

/* =========================================
   MAIN
========================================= */
export async function processBundlesMongo() {
    const db = await getDb("master_list");
    const collection = db.collection<MasterListDoc>("product_list");

    // recommended once:
    // await collection.createIndex({ sku: 1 }, { unique: true });

    // ======================= 4PK =======================
    for (const bundle of bundles_4pk) {
        console.log(`Processing 4PK: ${bundle}`);

        // ✅ stocking check using concatenated sku (no commas/spaces)
        const isStocking = await bundleHasStocking_4pk(bundle);

        // split bundle into parts
        const parts = bundle
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);

        // ✅ FIRST SKU category copy
        const firstSku = normalizeSku(parts[0] || "");
        const firstDoc = firstSku ? await collection.findOne({ sku: firstSku }) : null;
        const categoryFields = pickCategoryFromDoc(firstDoc);

        // For each distributor we will:
        // - find the component sku with highest qty
        // - use that sku’s response
        // - sum prices across all component skus
        const maxQty: Record<string, number> = {
            dandh_qty: 0,
            synnex_qty: 0,
            ingram_qty: 0,
            supplies_qty: 0,
        };

        const bestSku: Record<Dist, string | null> = {
            dandh: null,
            synnex: null,
            ingram: null,
            supplies: null,
        };

        const bundlePrices: Record<Dist, number> = {
            dandh: 0,
            synnex: 0,
            ingram: 0,
            supplies: 0,
        };

        for (const p of parts) {
            const sku = normalizeSku(p);
            const doc = await collection.findOne({ sku });
            if (!doc) continue;

            for (const d of allDistributors) {
                const qty = getQty(doc, d);
                const price = getPrice(doc, d);

                // sum price
                bundlePrices[d] += price;

                // highest qty picks response sku
                const key = `${d}_qty`;
                if (qty > maxQty[key]) {
                    maxQty[key] = qty;
                    bestSku[d] = sku;
                }
            }
        }

        // responses pulled from bestSku per distributor
        const responses: Record<string, any> = {};
        for (const d of allDistributors) {
            const src = bestSku[d];
            if (!src) {
                responses[`${d}_response`] = null;
                continue;
            }

            const srcDoc = await collection.findOne(
                { sku: src },
                { projection: { [`${d}_response`]: 1 } as any }
            );

            responses[`${d}_response`] = getResponse(srcDoc, d);
        }

        // compute priority (based on highest qty winner)
        const priorityCounts = {
            dandh_qty: maxQty.dandh_qty,
            synnex_qty: maxQty.synnex_qty,
            ingram_qty: maxQty.ingram_qty,
            supplies_qty: maxQty.supplies_qty,
        };

        let priority: any = resolveHighestDistributor(priorityCounts);
        if (priority === "supplies") priority = "suppliesNetwork";
        if (isStocking) priority = "stocking"; // match your document style

        const now = new Date();

        await collection.updateOne(
            { sku: bundle },
            {
                $set: {
                    sku: bundle,
                    normalized_sku: normalizeSku(bundle),

                    // ✅ category from FIRST SKU
                    ...categoryFields,

                    // store bundle qty in the same schema as your docs: *_quantity
                    dandh_quantity: maxQty.dandh_qty,
                    synnex_quantity: maxQty.synnex_qty,
                    ingram_quantity: maxQty.ingram_qty,
                    supplies_quantity: maxQty.supplies_qty,

                    // also store *_count for compatibility (optional, remove if you don’t want)
                    dandh_count: maxQty.dandh_qty,
                    synnex_count: maxQty.synnex_qty,
                    ingram_count: maxQty.ingram_qty,
                    supplies_count: maxQty.supplies_qty,

                    // responses from best sku per distributor
                    dandh_response: responses.dandh_response,
                    synnex_response: responses.synnex_response,
                    ingram_response: responses.ingram_response,
                    supplies_response: responses.supplies_response,

                    // summed prices
                    dandh_price: bundlePrices.dandh,
                    synnex_price: bundlePrices.synnex,
                    ingram_price: bundlePrices.ingram,
                    supplies_price: bundlePrices.supplies,

                    priority,
                    updated_at: now,
                },
                $setOnInsert: { created_at: now },
            },
            { upsert: true }
        );

        console.log(`✅ 4PK upserted | priority=${priority} | categoryFrom=${firstSku || "N/A"}`);
    }

    // ======================= 2PK =======================
    for (const bundle of bundles_2pk) {
        console.log(`Processing 2PK: ${bundle}`);

        const baseSku = bundle.replace(/-2PK$/i, "").trim();

        // stocking check by normalized base sku
        const isStocking = await bundleHasStocking_2pk(baseSku);

        const baseDoc = await collection.findOne({ sku: normalizeSku(baseSku) });
        if (!baseDoc) continue;

        // ✅ 2PK category "as is" from base sku doc
        const categoryFields = pickCategoryFromDoc(baseDoc);

        // quantity is base/2 (floor)
        const dandhQty = Math.floor(getQty(baseDoc, "dandh") / 2);
        const synnexQty = Math.floor(getQty(baseDoc, "synnex") / 2);
        const ingramQty = Math.floor(getQty(baseDoc, "ingram") / 2);
        const suppliesQty = Math.floor(getQty(baseDoc, "supplies") / 2);

        const counts = {
            dandh_qty: dandhQty,
            synnex_qty: synnexQty,
            ingram_qty: ingramQty,
            supplies_qty: suppliesQty,
        };

        let priority: any = resolveHighestDistributor(counts);
        if (priority === "supplies") priority = "suppliesNetwork";
        if (isStocking) priority = "stocking";

        const now = new Date();

        await collection.updateOne(
            { sku: bundle },
            {
                $set: {
                    sku: bundle,
                    normalized_sku: normalizeSku(bundle),

                    // ✅ category from base sku
                    ...categoryFields,

                    // store as *_quantity + *_count
                    dandh_quantity: dandhQty,
                    synnex_quantity: synnexQty,
                    ingram_quantity: ingramQty,
                    supplies_quantity: suppliesQty,

                    dandh_count: dandhQty,
                    synnex_count: synnexQty,
                    ingram_count: ingramQty,
                    supplies_count: suppliesQty,

                    // responses directly from base sku doc
                    dandh_response: getResponse(baseDoc, "dandh"),
                    synnex_response: getResponse(baseDoc, "synnex"),
                    ingram_response: getResponse(baseDoc, "ingram"),
                    supplies_response: getResponse(baseDoc, "supplies"),

                    // 2PK price = base * 2 (same as your old logic)
                    dandh_price: getPrice(baseDoc, "dandh") * 2,
                    synnex_price: getPrice(baseDoc, "synnex") * 2,
                    ingram_price: getPrice(baseDoc, "ingram") * 2,
                    supplies_price: getPrice(baseDoc, "supplies") * 2,

                    priority,
                    updated_at: now,
                },
                $setOnInsert: { created_at: now },
            },
            { upsert: true }
        );

        console.log(`✅ 2PK upserted | priority=${priority} | categoryFrom=${normalizeSku(baseSku)}`);
    }
}
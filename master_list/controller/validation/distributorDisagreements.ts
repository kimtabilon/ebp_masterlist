import { getDb } from "../../config/mongdodb.config";

/**
 * Distributor Disagreement Report (EBP-32)
 *
 * Identifies products where distributors provide conflicting data.
 * This is a diagnostic tool — it does NOT block promotion.
 * Results are persisted in the pipeline_runs audit log for team review.
 */

export interface DisagreementResult {
    priceDisagreements: {
        count: number;
        samples: { sku: string; prices: Record<string, number | null> }[];
    };
    inventoryDisagreements: {
        count: number;
        samples: { sku: string; quantities: Record<string, number | null> }[];
    };
    summary: string;
}

const PRICE_FIELDS: { dist: string; field: string }[] = [
    { dist: "synnex", field: "synnex_price" },
    { dist: "dandh", field: "dandh_price" },
    { dist: "ingram", field: "ingram_price" },
    { dist: "supplies", field: "supplies_price" },
    { dist: "almo", field: "almo_price" },
];

const QTY_FIELDS: { dist: string; field: string }[] = [
    { dist: "synnex", field: "synnex_quantity" },
    { dist: "dandh", field: "dandh_quantity" },
    { dist: "ingram", field: "ingram_quantity" },
    { dist: "supplies", field: "supplies_count" },
    { dist: "almo", field: "almo_quantity" },
];

/**
 * Analyze the product list for distributor disagreements.
 *
 * @param priceThresholdPct - min % difference between lowest and highest price to flag (default 50)
 * @param maxSamples - max sample SKUs to include per disagreement type (default 20)
 */
export async function analyzeDistributorDisagreements(options?: {
    priceThresholdPct?: number;
    maxSamples?: number;
}): Promise<DisagreementResult> {
    const db = await getDb("master_list");
    const productList = db.collection("product_list");

    const priceThreshold = options?.priceThresholdPct
        ?? (process.env.DISAGREEMENT_PRICE_PCT ? Number(process.env.DISAGREEMENT_PRICE_PCT) : 50);
    const maxSamples = options?.maxSamples ?? 20;

    console.log("🔍 Analyzing distributor disagreements...");

    // Price disagreements — products with multiple distributor prices that differ significantly
    const priceSamples: DisagreementResult["priceDisagreements"]["samples"] = [];
    let priceDisagreementCount = 0;

    // Use cursor to avoid loading everything into memory
    const cursor = productList.find(
        { "distributor_list.1": { $exists: true } }, // products with 2+ distributors
        {
            projection: {
                normalized_sku: 1,
                synnex_price: 1, dandh_price: 1, ingram_price: 1,
                supplies_price: 1, almo_price: 1,
                synnex_quantity: 1, dandh_quantity: 1, ingram_quantity: 1,
                supplies_count: 1, almo_quantity: 1,
                distributor_list: 1,
            }
        }
    );

    const inventorySamples: DisagreementResult["inventoryDisagreements"]["samples"] = [];
    let inventoryDisagreementCount = 0;

    while (await cursor.hasNext()) {
        const doc: any = await cursor.next();
        const sku = doc.normalized_sku;

        // Collect non-null prices
        const prices: Record<string, number> = {};
        for (const pf of PRICE_FIELDS) {
            const val = Number(doc[pf.field]);
            if (val > 0) prices[pf.dist] = val;
        }

        // Check price disagreement — need at least 2 prices to compare
        const priceValues = Object.values(prices);
        if (priceValues.length >= 2) {
            const minPrice = Math.min(...priceValues);
            const maxPrice = Math.max(...priceValues);

            if (minPrice > 0) {
                const pctDiff = ((maxPrice - minPrice) / minPrice) * 100;
                if (pctDiff >= priceThreshold) {
                    priceDisagreementCount++;
                    if (priceSamples.length < maxSamples) {
                        const allPrices: Record<string, number | null> = {};
                        for (const pf of PRICE_FIELDS) {
                            allPrices[pf.dist] = doc[pf.field] ?? null;
                        }
                        priceSamples.push({ sku, prices: allPrices });
                    }
                }
            }
        }

        // Check inventory disagreement — one distributor shows stock, another shows 0
        const quantities: Record<string, number> = {};
        for (const qf of QTY_FIELDS) {
            const val = Number(doc[qf.field]);
            if (!isNaN(val) && doc[qf.field] !== null) quantities[qf.dist] = val;
        }

        const qtyValues = Object.values(quantities);
        if (qtyValues.length >= 2) {
            const hasStock = qtyValues.some(q => q > 0);
            const hasZero = qtyValues.some(q => q === 0);

            if (hasStock && hasZero) {
                inventoryDisagreementCount++;
                if (inventorySamples.length < maxSamples) {
                    const allQty: Record<string, number | null> = {};
                    for (const qf of QTY_FIELDS) {
                        allQty[qf.dist] = doc[qf.field] ?? null;
                    }
                    inventorySamples.push({ sku, quantities: allQty });
                }
            }
        }
    }

    const summary = `Price disagreements (>${priceThreshold}% spread): ${priceDisagreementCount} | Inventory disagreements (stock vs zero): ${inventoryDisagreementCount}`;
    console.log(`📊 ${summary}`);

    return {
        priceDisagreements: { count: priceDisagreementCount, samples: priceSamples },
        inventoryDisagreements: { count: inventoryDisagreementCount, samples: inventorySamples },
        summary,
    };
}

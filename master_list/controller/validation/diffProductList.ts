import { getDb } from "../../config/mongdodb.config";

export interface DiffResult {
    added: number;
    removed: number;
    priceChanges: number;
    inventorySwings: number;
    distributorChanges: number;
    details: {
        addedSkus: string[];
        removedSkus: string[];
        priceChangeSkus: string[];
        inventorySwingSkus: string[];
        distributorChangeSkus: string[];
    };
}

const PRICE_FIELDS = [
    "synnex_price", "dandh_price", "ingram_price", "supplies_price", "almo_price"
];

const QUANTITY_FIELDS = [
    "synnex_quantity", "dandh_quantity", "ingram_quantity", "supplies_count", "almo_quantity"
];

/**
 * Compare the current product_list against product_list_previous.
 * Returns a summary of what changed between runs.
 *
 * Thresholds resolve in order: function parameter → env var → hardcoded default.
 * Env vars: DIFF_PRICE_CHANGE_PCT, DIFF_INVENTORY_CHANGE_PCT
 */
export async function diffProductList(options?: {
    priceChangePct?: number;       // min % change to flag (default 10)
    inventoryChangePct?: number;   // min % change to flag (default 50)
    maxDetailSkus?: number;        // max SKUs to store in detail arrays (default 100)
}): Promise<DiffResult> {
    const db = await getDb("master_list");
    const current = db.collection("product_list");
    const previous = db.collection("product_list_previous");

    const priceThreshold = options?.priceChangePct
        ?? (process.env.DIFF_PRICE_CHANGE_PCT ? Number(process.env.DIFF_PRICE_CHANGE_PCT) : 10);
    const inventoryThreshold = options?.inventoryChangePct
        ?? (process.env.DIFF_INVENTORY_CHANGE_PCT ? Number(process.env.DIFF_INVENTORY_CHANGE_PCT) : 50);
    const maxDetail = options?.maxDetailSkus ?? 100;

    const previousCount = await previous.countDocuments();

    // First run — no previous data to diff against
    if (previousCount === 0) {
        const currentCount = await current.countDocuments();
        return {
            added: currentCount,
            removed: 0,
            priceChanges: 0,
            inventorySwings: 0,
            distributorChanges: 0,
            details: {
                addedSkus: [],
                removedSkus: [],
                priceChangeSkus: [],
                inventorySwingSkus: [],
                distributorChangeSkus: [],
            }
        };
    }

    // Build lookup maps from previous run
    // Key: normalized_sku → { prices, quantities, distributors }
    const prevMap = new Map<string, any>();
    const prevCursor = previous.find({}, {
        projection: {
            normalized_sku: 1,
            distributor_list: 1,
            synnex_price: 1, dandh_price: 1, ingram_price: 1, supplies_price: 1, almo_price: 1,
            synnex_quantity: 1, dandh_quantity: 1, ingram_quantity: 1, supplies_count: 1, almo_quantity: 1,
        }
    });

    while (await prevCursor.hasNext()) {
        const doc: any = await prevCursor.next();
        if (!doc.normalized_sku) continue;
        prevMap.set(doc.normalized_sku, doc);
    }

    const addedSkus: string[] = [];
    const priceChangeSkus: string[] = [];
    const inventorySwingSkus: string[] = [];
    const distributorChangeSkus: string[] = [];
    const seenSkus = new Set<string>();

    const currentCursor = current.find({}, {
        projection: {
            normalized_sku: 1,
            distributor_list: 1,
            synnex_price: 1, dandh_price: 1, ingram_price: 1, supplies_price: 1, almo_price: 1,
            synnex_quantity: 1, dandh_quantity: 1, ingram_quantity: 1, supplies_count: 1, almo_quantity: 1,
        }
    });

    while (await currentCursor.hasNext()) {
        const doc: any = await currentCursor.next();
        if (!doc.normalized_sku) continue;

        const sku = doc.normalized_sku;
        seenSkus.add(sku);

        const prev = prevMap.get(sku);

        if (!prev) {
            // New product
            if (addedSkus.length < maxDetail) addedSkus.push(sku);
            continue;
        }

        // Price changes
        for (const field of PRICE_FIELDS) {
            const oldVal = Number(prev[field]) || 0;
            const newVal = Number(doc[field]) || 0;
            if (oldVal === 0 && newVal === 0) continue;
            const base = oldVal || newVal;
            const pctChange = Math.abs(newVal - oldVal) / base * 100;
            if (pctChange >= priceThreshold) {
                if (priceChangeSkus.length < maxDetail) priceChangeSkus.push(sku);
                break; // one flag per SKU is enough
            }
        }

        // Inventory swings
        for (const field of QUANTITY_FIELDS) {
            const oldVal = Number(prev[field]) || 0;
            const newVal = Number(doc[field]) || 0;
            if (oldVal === 0 && newVal === 0) continue;
            const base = oldVal || newVal;
            const pctChange = Math.abs(newVal - oldVal) / base * 100;
            if (pctChange >= inventoryThreshold) {
                if (inventorySwingSkus.length < maxDetail) inventorySwingSkus.push(sku);
                break;
            }
        }

        // Distributor coverage changes
        const oldDist = (prev.distributor_list || []).sort().join(",");
        const newDist = (doc.distributor_list || []).sort().join(",");
        if (oldDist !== newDist) {
            if (distributorChangeSkus.length < maxDetail) distributorChangeSkus.push(sku);
        }
    }

    // Removed products — in previous but not in current
    const removedSkus: string[] = [];
    let removedTotal = 0;
    for (const sku of prevMap.keys()) {
        if (!seenSkus.has(sku)) {
            removedTotal++;
            if (removedSkus.length < maxDetail) removedSkus.push(sku);
        }
    }

    // Count total added (including those beyond maxDetail)
    let addedTotal = 0;
    for (const sku of seenSkus) {
        if (!prevMap.has(sku)) addedTotal++;
    }

    return {
        added: addedTotal,
        removed: removedTotal,
        priceChanges: priceChangeSkus.length,
        inventorySwings: inventorySwingSkus.length,
        distributorChanges: distributorChangeSkus.length,
        details: {
            addedSkus,
            removedSkus,
            priceChangeSkus,
            inventorySwingSkus,
            distributorChangeSkus,
        }
    };
}

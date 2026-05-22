import { getDb } from "../../config/mongdodb.config";

export interface ValidationResult {
    passed: boolean;
    checks: {
        name: string;
        passed: boolean;
        detail: string;
    }[];
}

/**
 * Validate the product list before promoting to production.
 * Returns a result object with pass/fail per check.
 *
 * Thresholds resolve in order: function parameter → env var → hardcoded default.
 * Env vars: VALIDATION_COUNT_THRESHOLD_PCT, VALIDATION_MAX_INVENTORY_MULTIPLIER
 */
export async function validateProductList(options?: {
    countThresholdPct?: number;              // max % deviation from previous run (default 10)
    maxInventoryMultiplier?: number;         // max single-run inventory increase (default 100)
    coverageMismatchPct?: number;            // max % of products with distributor coverage gaps (default 1)
    zeroPriceThresholdPct?: number;          // max % of products with no valid pricing (default 1)
    mfgUnmappedThresholdPct?: number;        // max % of products without manufacturer_map (default 20)
    responseIncompleteThresholdPct?: number; // max % of products with incomplete response data (default 5)
    nameNullThresholdPct?: number;           // max % of products without name (default 1)
    categoryNullThresholdPct?: number;       // max % of products without category_class (default 30)
    upcInvalidThresholdPct?: number;         // max % of products with non-standard UPC format (default 1)
    skuUpcChangedThreshold?: number;         // max number of SKUs that changed UPC between runs (default 50)
    disabledChecks?: string[];               // check names to skip
}): Promise<ValidationResult> {
    const db = await getDb("master_list");
    const productList = db.collection("product_list");
    const previousList = db.collection("product_list_previous");

    const countThreshold = options?.countThresholdPct
        ?? (process.env.VALIDATION_COUNT_THRESHOLD_PCT ? Number(process.env.VALIDATION_COUNT_THRESHOLD_PCT) : 10);
    const maxInvMultiplier = options?.maxInventoryMultiplier
        ?? (process.env.VALIDATION_MAX_INVENTORY_MULTIPLIER ? Number(process.env.VALIDATION_MAX_INVENTORY_MULTIPLIER) : 100);
    const coverageThreshold = options?.coverageMismatchPct
        ?? (process.env.VALIDATION_COVERAGE_MISMATCH_PCT ? Number(process.env.VALIDATION_COVERAGE_MISMATCH_PCT) : 1);

    const disabledChecks = new Set(
        options?.disabledChecks
        ?? (process.env.VALIDATION_DISABLED_CHECKS ? process.env.VALIDATION_DISABLED_CHECKS.split(",").map(s => s.trim()) : [])
    );

    const checks: ValidationResult["checks"] = [];
    const isEnabled = (name: string) => !disabledChecks.has(name);

    // 1. Product count vs previous run
    const currentCount = await productList.countDocuments();
    const previousCount = await previousList.countDocuments();

    // Ensure index on product_list_previous.normalized_sku for $lookup performance
    // (sku_upc_consistency check joins against it; without index it does COLLSCAN)
    if (previousCount > 0) {
        await previousList.createIndex({ normalized_sku: 1 }).catch(() => {});
    }

    if (isEnabled("product_count")) {
        if (previousCount > 0) {
            const pctChange = Math.abs(currentCount - previousCount) / previousCount * 100;
            const countPassed = pctChange <= countThreshold;
            checks.push({
                name: "product_count",
                passed: countPassed,
                detail: countPassed
                    ? `Count ${currentCount} is within ${countThreshold}% of previous ${previousCount} (${pctChange.toFixed(1)}% change)`
                    : `Count ${currentCount} deviates ${pctChange.toFixed(1)}% from previous ${previousCount} (threshold: ${countThreshold}%)`
            });
        } else {
            checks.push({
                name: "product_count",
                passed: true,
                detail: `First run — no previous count to compare. Current count: ${currentCount}`
            });
        }
    }

    // 2. Distributor coverage — products with a distributor in their list but null response
    if (isEnabled("distributor_coverage")) {
        const coveragePipeline = [
            {
                $match: {
                    $or: [
                        { distributor_list: "synnex", synnex_response: null },
                        { distributor_list: "dandh", dandh_response: null },
                        { distributor_list: "ingram", ingram_response: null },
                        { distributor_list: "supplies", supplies_response: null },
                        { distributor_list: "almo", almo_response: null },
                    ]
                }
            },
            { $count: "total" }
        ];
        const coverageResult = await productList.aggregate(coveragePipeline).toArray();
        const mismatchCount = coverageResult[0]?.total ?? 0;
        const mismatchPct = currentCount > 0 ? (mismatchCount / currentCount) * 100 : 0;
        const coveragePassed = mismatchPct <= coverageThreshold;
        checks.push({
            name: "distributor_coverage",
            passed: coveragePassed,
            detail: coveragePassed
                ? `${mismatchCount} products with coverage gaps (${mismatchPct.toFixed(2)}%, threshold: ${coverageThreshold}%)`
                : `${mismatchCount} products with coverage gaps (${mismatchPct.toFixed(2)}%) exceeds threshold of ${coverageThreshold}%`
        });
    }

    // 3. Duplicate normalized_sku
    if (isEnabled("duplicate_sku")) {
        const dupPipeline = [
            { $group: { _id: "$normalized_sku", count: { $sum: 1 } } },
            { $match: { count: { $gt: 1 } } },
            { $count: "total" }
        ];
        const dupResult = await productList.aggregate(dupPipeline).toArray();
        const dupCount = dupResult[0]?.total ?? 0;
        checks.push({
            name: "duplicate_sku",
            passed: dupCount === 0,
            detail: dupCount === 0
                ? "No duplicate normalized_sku entries"
                : `${dupCount} normalized_sku values appear more than once`
        });
    }

    // 4. Inventory plausibility — no negative values
    if (isEnabled("inventory_plausibility")) {
        const negativePipeline = [
            {
                $match: {
                    $or: [
                        { synnex_quantity: { $lt: 0 } },
                        { dandh_quantity: { $lt: 0 } },
                        { ingram_quantity: { $lt: 0 } },
                        { supplies_count: { $lt: 0 } },
                        { almo_quantity: { $lt: 0 } },
                    ]
                }
            },
            { $count: "total" }
        ];
        const negResult = await productList.aggregate(negativePipeline).toArray();
        const negCount = negResult[0]?.total ?? 0;
        checks.push({
            name: "inventory_plausibility",
            passed: negCount === 0,
            detail: negCount === 0
                ? "No negative inventory values"
                : `${negCount} products have negative inventory values`
        });
    }

    // 5. Distributor minimums — each distributor contributes > 0 products
    if (isEnabled("distributor_minimums")) {
        const distributors = ["synnex", "dandh", "ingram", "supplies", "almo"];
        const missingDistributors: string[] = [];

        for (const dist of distributors) {
            const count = await productList.countDocuments({ distributor_list: dist });
            if (count === 0) missingDistributors.push(dist);
        }

        checks.push({
            name: "distributor_minimums",
            passed: missingDistributors.length === 0,
            detail: missingDistributors.length === 0
                ? "All 5 distributors contribute products"
                : `Missing distributors: ${missingDistributors.join(", ")}`
        });
    }

    // 6. Price sanity — no $0 prices on products with response data (EBP-29)
    if (isEnabled("price_sanity")) {
        const zeroPriceThresholdPct = options?.zeroPriceThresholdPct
            ?? (process.env.VALIDATION_ZERO_PRICE_PCT ? Number(process.env.VALIDATION_ZERO_PRICE_PCT) : 8);

        // Products with at least one distributor response but ALL prices are 0 or null
        const zeroPricePipeline = [
            { $match: { distributor_list: { $exists: true, $not: { $size: 0 } } } },
            {
                $match: {
                    $and: [
                        { $or: [{ synnex_price: null }, { synnex_price: 0 }] },
                        { $or: [{ dandh_price: null }, { dandh_price: 0 }] },
                        { $or: [{ ingram_price: null }, { ingram_price: 0 }] },
                        { $or: [{ supplies_price: null }, { supplies_price: 0 }] },
                        { $or: [{ almo_price: null }, { almo_price: 0 }] },
                    ]
                }
            },
            { $count: "total" }
        ];
        const zeroPriceResult = await productList.aggregate(zeroPricePipeline).toArray();
        const zeroPriceCount = zeroPriceResult[0]?.total ?? 0;
        const zeroPricePct = currentCount > 0 ? (zeroPriceCount / currentCount) * 100 : 0;
        const pricePassed = zeroPricePct <= zeroPriceThresholdPct;

        checks.push({
            name: "price_sanity",
            passed: pricePassed,
            detail: pricePassed
                ? `${zeroPriceCount} products with no valid pricing (${zeroPricePct.toFixed(2)}%, threshold: ${zeroPriceThresholdPct}%)`
                : `${zeroPriceCount} products with no valid pricing (${zeroPricePct.toFixed(2)}%) exceeds threshold of ${zeroPriceThresholdPct}%`
        });
    }

    // 7. Manufacturer mapping coverage (EBP-30)
    if (isEnabled("manufacturer_coverage")) {
        const mfgThresholdPct = options?.mfgUnmappedThresholdPct
            ?? (process.env.VALIDATION_MFG_UNMAPPED_PCT ? Number(process.env.VALIDATION_MFG_UNMAPPED_PCT) : 20);

        const nullMfgCount = await productList.countDocuments({
            $or: [{ manufacturer_map: null }, { manufacturer_map: "" }]
        });
        const nullMfgPct = currentCount > 0 ? (nullMfgCount / currentCount) * 100 : 0;
        const mfgPassed = nullMfgPct <= mfgThresholdPct;

        checks.push({
            name: "manufacturer_coverage",
            passed: mfgPassed,
            detail: mfgPassed
                ? `${nullMfgCount} products without manufacturer_map (${nullMfgPct.toFixed(1)}%, threshold: ${mfgThresholdPct}%)`
                : `${nullMfgCount} products without manufacturer_map (${nullMfgPct.toFixed(1)}%) exceeds threshold of ${mfgThresholdPct}%`
        });
    }

    // 8. Response data completeness (EBP-31)
    if (isEnabled("response_completeness")) {
        const completenessThresholdPct = options?.responseIncompleteThresholdPct
            ?? (process.env.VALIDATION_RESPONSE_INCOMPLETE_PCT ? Number(process.env.VALIDATION_RESPONSE_INCOMPLETE_PCT) : 5);

        // Products where a distributor is in the list but price AND quantity are both null
        const incompletePipeline = [
            {
                $match: {
                    $or: [
                        { distributor_list: "synnex", synnex_price: null, synnex_quantity: null },
                        { distributor_list: "dandh", dandh_price: null, dandh_quantity: null },
                        { distributor_list: "ingram", ingram_price: null, ingram_quantity: null },
                        { distributor_list: "supplies", supplies_price: null, supplies_count: null },
                        { distributor_list: "almo", almo_price: null, almo_quantity: null },
                    ]
                }
            },
            { $count: "total" }
        ];
        const incompleteResult = await productList.aggregate(incompletePipeline).toArray();
        const incompleteCount = incompleteResult[0]?.total ?? 0;
        const incompletePct = currentCount > 0 ? (incompleteCount / currentCount) * 100 : 0;
        const completenessPassed = incompletePct <= completenessThresholdPct;

        checks.push({
            name: "response_completeness",
            passed: completenessPassed,
            detail: completenessPassed
                ? `${incompleteCount} products with incomplete response data (${incompletePct.toFixed(2)}%, threshold: ${completenessThresholdPct}%)`
                : `${incompleteCount} products with incomplete response data (${incompletePct.toFixed(2)}%) exceeds threshold of ${completenessThresholdPct}%`
        });
    }

    // 9. Product name coverage — products without a name are unusable
    if (isEnabled("name_coverage")) {
        const nameThresholdPct = options?.nameNullThresholdPct
            ?? (process.env.VALIDATION_NAME_NULL_PCT ? Number(process.env.VALIDATION_NAME_NULL_PCT) : 1);

        const nullNameCount = await productList.countDocuments({
            $or: [{ name: null }, { name: "" }]
        });
        const nullNamePct = currentCount > 0 ? (nullNameCount / currentCount) * 100 : 0;
        const namePassed = nullNamePct <= nameThresholdPct;

        checks.push({
            name: "name_coverage",
            passed: namePassed,
            detail: namePassed
                ? `${nullNameCount} products without name (${nullNamePct.toFixed(2)}%, threshold: ${nameThresholdPct}%)`
                : `${nullNameCount} products without name (${nullNamePct.toFixed(2)}%) exceeds threshold of ${nameThresholdPct}%`
        });
    }

    // 10. Category coverage — null category_class indicates broken category resolution
    if (isEnabled("category_coverage")) {
        const catThresholdPct = options?.categoryNullThresholdPct
            ?? (process.env.VALIDATION_CATEGORY_NULL_PCT ? Number(process.env.VALIDATION_CATEGORY_NULL_PCT) : 30);

        const nullCatCount = await productList.countDocuments({
            $or: [{ category_class: null }, { category_class: "" }]
        });
        const nullCatPct = currentCount > 0 ? (nullCatCount / currentCount) * 100 : 0;
        const catPassed = nullCatPct <= catThresholdPct;

        checks.push({
            name: "category_coverage",
            passed: catPassed,
            detail: catPassed
                ? `${nullCatCount} products without category (${nullCatPct.toFixed(1)}%, threshold: ${catThresholdPct}%)`
                : `${nullCatCount} products without category (${nullCatPct.toFixed(1)}%) exceeds threshold of ${catThresholdPct}%`
        });
    }

    // 11. UPC format validity — standard UPC is 12 digits, EAN is 13
    if (isEnabled("upc_format")) {
        const upcFormatThresholdPct = options?.upcInvalidThresholdPct
            ?? (process.env.VALIDATION_UPC_INVALID_PCT ? Number(process.env.VALIDATION_UPC_INVALID_PCT) : 1);

        // Products with a UPC that isn't 11-14 digits
        // (11 = leading-zero-stripped UPC-A, 12 = UPC-A, 13 = EAN-13, 14 = GTIN-14)
        const invalidUpcResult = await productList.aggregate([
            { $match: { upc: { $nin: [null, ""] } } },
            { $match: { upc: { $not: /^\d{11,14}$/ } } },
            { $count: "total" }
        ]).toArray();
        const invalidUpcCount = invalidUpcResult[0]?.total ?? 0;
        const invalidUpcPct = currentCount > 0 ? (invalidUpcCount / currentCount) * 100 : 0;
        const upcPassed = invalidUpcPct <= upcFormatThresholdPct;

        checks.push({
            name: "upc_format",
            passed: upcPassed,
            detail: upcPassed
                ? `${invalidUpcCount} products with non-standard UPC format (${invalidUpcPct.toFixed(2)}%, threshold: ${upcFormatThresholdPct}%)`
                : `${invalidUpcCount} products with non-standard UPC format (${invalidUpcPct.toFixed(2)}%) exceeds threshold of ${upcFormatThresholdPct}%`
        });
    }

    // 12. SKU-UPC consistency across runs — detect products where UPC changed for the same SKU
    if (isEnabled("sku_upc_consistency") && previousCount > 0) {
        const consistencyThreshold = options?.skuUpcChangedThreshold
            ?? (process.env.VALIDATION_SKU_UPC_CHANGED ? Number(process.env.VALIDATION_SKU_UPC_CHANGED) : 500);

        // Find SKUs that exist in both runs but with different UPCs
        const changedUpcPipeline = [
            {
                $lookup: {
                    from: "product_list_previous",
                    localField: "normalized_sku",
                    foreignField: "normalized_sku",
                    as: "prev"
                }
            },
            { $match: { "prev.0": { $exists: true } } },
            {
                $match: {
                    $expr: {
                        $and: [
                            { $ne: [{ $arrayElemAt: ["$prev.upc", 0] }, null] },
                            { $ne: ["$upc", null] },
                            { $ne: ["$upc", { $arrayElemAt: ["$prev.upc", 0] }] }
                        ]
                    }
                }
            },
            { $count: "total" }
        ];
        const changedResult = await productList.aggregate(changedUpcPipeline).toArray();
        const changedCount = changedResult[0]?.total ?? 0;
        const consistencyPassed = changedCount <= consistencyThreshold;

        checks.push({
            name: "sku_upc_consistency",
            passed: consistencyPassed,
            detail: consistencyPassed
                ? `${changedCount} products changed UPC between runs (threshold: ${consistencyThreshold})`
                : `${changedCount} products changed UPC between runs — exceeds threshold of ${consistencyThreshold}`
        });
    }

    // 13. Priority validity — should be a known distributor name
    if (isEnabled("priority_validity")) {
        const validPriorities = ["synnex", "dandh", "ingram", "supplies", "suppliesNetwork", "almo", "stocking"];
        const invalidPriorityCount = await productList.countDocuments({
            priority: { $nin: [...validPriorities, null] }
        });

        checks.push({
            name: "priority_validity",
            passed: invalidPriorityCount === 0,
            detail: invalidPriorityCount === 0
                ? "All products have valid priority values"
                : `${invalidPriorityCount} products have invalid priority values`
        });
    }

    const passed = checks.every(c => c.passed);

    return { passed, checks };
}

/**
 * Promote the current product_list to production by dropping the previous backup.
 * Called after validation passes.
 */
export async function promoteProductList(): Promise<void> {
    const db = await getDb("master_list");
    await db.dropCollection("product_list_previous").catch(() => { });
    console.log("✅ Product list promoted — previous backup dropped");
}

/**
 * Rollback: drop the current (failed) product_list and restore the previous one.
 * Called when validation fails.
 */
export async function rollbackProductList(): Promise<void> {
    const db = await getDb("master_list");

    await db.dropCollection("product_list").catch(() => { });

    // Rename previous back to production
    try {
        await db.admin().command({
            renameCollection: `${db.databaseName}.product_list_previous`,
            to: `${db.databaseName}.product_list`,
            dropTarget: true,
        });
        console.log("⚠️ Product list rolled back — previous version restored");
    } catch (err: any) {
        console.error("❌ Rollback failed — product_list_previous could not be renamed:", err?.message);
        throw err;
    }
}

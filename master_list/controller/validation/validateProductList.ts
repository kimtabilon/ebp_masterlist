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
    countThresholdPct?: number;          // max % deviation from previous run (default 10)
    maxInventoryMultiplier?: number;     // max single-run inventory increase (default 100)
    coverageMismatchPct?: number;        // max % of products with distributor coverage gaps (default 1)
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

    const checks: ValidationResult["checks"] = [];

    // 1. Product count vs previous run
    const currentCount = await productList.countDocuments();
    const previousCount = await previousList.countDocuments();

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
        // No previous run to compare — pass by default (first run)
        checks.push({
            name: "product_count",
            passed: true,
            detail: `First run — no previous count to compare. Current count: ${currentCount}`
        });
    }

    // 2. Distributor coverage — products with a distributor in their list but null response
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

    // 3. Duplicate normalized_sku
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

    // 4. Inventory plausibility — no negative values
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

    // 5. Distributor minimums — each distributor contributes > 0 products
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

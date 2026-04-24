import { getDb } from "../../config/mongdodb.config";

/**
 * Remove duplicate/conflicting products from the product_list collection
 * using MongoDB aggregation instead of in-memory maps.
 *
 * Rules (matching original in-memory cleanup):
 * 1. Remove products with null/empty UPC
 * 2. Remove ALL products where a UPC maps to multiple normalized_skus
 *
 * Note: "SKU maps to multiple UPCs" is effectively impossible since the streaming
 * build uses a unique index on normalized_sku — each SKU appears at most once.
 */
export async function cleanupDuplicates(): Promise<{ removed: number }> {
    const db = await getDb("master_list");
    const productList = db.collection("product_list");

    console.log("🧹 Starting duplicate cleanup (aggregation-based)...");
    console.time("duplicateCleanup");

    let totalRemoved = 0;

    // 1. Remove products with null/empty UPC
    const nullUpcResult = await productList.deleteMany({
        $or: [
            { upc: null },
            { upc: "" },
        ]
    });
    const nullRemoved = nullUpcResult.deletedCount ?? 0;
    totalRemoved += nullRemoved;
    console.log(`  Removed ${nullRemoved} products with null/empty UPC`);

    // 2. Find UPCs that map to multiple SKUs — remove ALL products with those UPCs
    const upcConflicts = await productList.aggregate([
        { $match: { upc: { $nin: [null, ""] } } },
        { $group: { _id: "$upc", skus: { $addToSet: "$normalized_sku" } } },
        { $match: { $expr: { $gt: [{ $size: "$skus" }, 1] } } },
        { $project: { _id: 1 } }
    ]).toArray();

    if (upcConflicts.length > 0) {
        const conflictUpcs = upcConflicts.map(c => c._id);
        const upcResult = await productList.deleteMany({
            upc: { $in: conflictUpcs }
        });
        const upcRemoved = upcResult.deletedCount ?? 0;
        totalRemoved += upcRemoved;
        console.log(`  Removed ${upcRemoved} products from ${conflictUpcs.length} UPCs with multiple SKUs`);
    } else {
        console.log(`  No UPCs with multiple SKUs found`);
    }

    console.timeEnd("duplicateCleanup");
    console.log(`✅ Duplicate cleanup complete: ${totalRemoved} total removed`);

    return { removed: totalRemoved };
}

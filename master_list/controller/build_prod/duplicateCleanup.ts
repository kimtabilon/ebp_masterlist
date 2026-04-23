import { getDb } from "../../config/mongdodb.config";

/**
 * Remove duplicate/conflicting products from the product_list collection
 * using MongoDB aggregation instead of in-memory maps.
 *
 * Rules (same as original in-memory cleanup):
 * 1. Remove products with null/empty UPC (after stripping non-digits)
 * 2. Remove SKUs that map to multiple UPCs
 * 3. Remove UPCs that map to multiple SKUs
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

    // 2. Find SKUs that map to multiple UPCs and remove them
    const skuConflicts = await productList.aggregate([
        { $match: { upc: { $nin: [null, ""] } } },
        { $group: { _id: "$normalized_sku", upcs: { $addToSet: "$upc" } } },
        { $match: { $expr: { $gt: [{ $size: "$upcs" }, 1] } } },
        { $project: { _id: 1 } }
    ]).toArray();

    if (skuConflicts.length > 0) {
        const conflictSkus = skuConflicts.map(c => c._id);
        const skuResult = await productList.deleteMany({
            normalized_sku: { $in: conflictSkus }
        });
        const skuRemoved = skuResult.deletedCount ?? 0;
        totalRemoved += skuRemoved;
        console.log(`  Removed ${skuRemoved} products from ${conflictSkus.length} SKUs with multiple UPCs`);
    } else {
        console.log(`  No SKUs with multiple UPCs found`);
    }

    // 3. Find UPCs that map to multiple SKUs and remove them
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

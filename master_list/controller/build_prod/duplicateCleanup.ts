import { getDb } from "../../config/mongdodb.config";

/**
 * Remove duplicate/conflicting products from the product_list collection
 * using MongoDB aggregation instead of in-memory maps.
 *
 * Rules (matching original in-memory cleanup behavior):
 * 1. Remove products with null/empty UPC
 * 2. SKUs with multiple UPCs — keep the first inserted doc, remove the rest
 * 3. UPCs with multiple SKUs — keep the first inserted doc, remove the rest
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

    // 2. SKUs with multiple UPCs — keep first (lowest _id), remove duplicates
    const skuConflicts = await productList.aggregate([
        { $match: { upc: { $nin: [null, ""] } } },
        {
            $group: {
                _id: "$normalized_sku",
                upcs: { $addToSet: "$upc" },
                keepId: { $first: "$_id" },   // keep the first doc (by insert order)
                allIds: { $push: "$_id" },
            }
        },
        { $match: { $expr: { $gt: [{ $size: "$upcs" }, 1] } } },
    ]).toArray();

    if (skuConflicts.length > 0) {
        // Collect all IDs to remove (everything except the keepId)
        const removeIds: any[] = [];
        for (const conflict of skuConflicts) {
            for (const id of conflict.allIds) {
                if (id.toString() !== conflict.keepId.toString()) {
                    removeIds.push(id);
                }
            }
        }

        if (removeIds.length > 0) {
            const skuResult = await productList.deleteMany({ _id: { $in: removeIds } });
            const skuRemoved = skuResult.deletedCount ?? 0;
            totalRemoved += skuRemoved;
            console.log(`  Removed ${skuRemoved} duplicates from ${skuConflicts.length} SKUs with multiple UPCs (kept 1 each)`);
        }
    } else {
        console.log(`  No SKUs with multiple UPCs found`);
    }

    // 3. UPCs with multiple SKUs — keep first (lowest _id), remove duplicates
    const upcConflicts = await productList.aggregate([
        { $match: { upc: { $nin: [null, ""] } } },
        {
            $group: {
                _id: "$upc",
                skus: { $addToSet: "$normalized_sku" },
                keepId: { $first: "$_id" },
                allIds: { $push: "$_id" },
            }
        },
        { $match: { $expr: { $gt: [{ $size: "$skus" }, 1] } } },
    ]).toArray();

    if (upcConflicts.length > 0) {
        const removeIds: any[] = [];
        for (const conflict of upcConflicts) {
            for (const id of conflict.allIds) {
                if (id.toString() !== conflict.keepId.toString()) {
                    removeIds.push(id);
                }
            }
        }

        if (removeIds.length > 0) {
            const upcResult = await productList.deleteMany({ _id: { $in: removeIds } });
            const upcRemoved = upcResult.deletedCount ?? 0;
            totalRemoved += upcRemoved;
            console.log(`  Removed ${upcRemoved} duplicates from ${upcConflicts.length} UPCs with multiple SKUs (kept 1 each)`);
        }
    } else {
        console.log(`  No UPCs with multiple SKUs found`);
    }

    console.timeEnd("duplicateCleanup");
    console.log(`✅ Duplicate cleanup complete: ${totalRemoved} total removed`);

    return { removed: totalRemoved };
}

// controllers/distNullUpc.controller.ts

import type { Request, Response } from "express";
import { getDb } from "../../config/mongdodb.config";

export const exportNullUpcToXlsx = async () => {
    try {
        const db = await getDb("master_list");

        const sourceCol = db.collection("dist_combined_raw");
        const targetCol = db.collection("filter_null_upc");


        // Clear target collection (faster than dropCollection)
        await targetCol.deleteMany({});

        // Build aggregation pipeline
        const pipeline: any[] = [
            {
                // Match NULL or missing UPC
                $match: {
                    $or: [
                        { upc: null },
                        { upc: { $exists: false } }
                    ]
                }
            },
            {
                // Optional projection (remove if you want full document)
                $project: {
                    sku: 1,
                    normalized_sku: 1,
                    upc: 1,
                    normalized_upc: 1,
                    manufacturer: 1,
                    distributor: 1,
                    manufacturer_map: 1,
                }
            },
            {
                $addFields: {
                    copied_from: "dist_combined_raw",
                    copied_at: new Date()
                }
            }
        ];


        pipeline.push({
            $merge: {
                into: "filter_null_upc",
                whenMatched: "keepExisting",
                whenNotMatched: "insert"
            }
        });

        // Execute aggregation
        await sourceCol.aggregate(pipeline, { allowDiskUse: true }).toArray();

        return

    } catch (err: any) {
        console.error(err);
        return
    }
};
// controllers/groupRemainingRaw.controller.ts

import type { Request, Response } from "express";
import { getDb } from "../../config/mongdodb.config";

export const buildGroupedUpcData = async (

) => {
    try {
        const db = await getDb("master_list");

        const rawCol = db.collection("dist_combined_raw");
        const targetCol = db.collection("grouped_upc_data");

        // 1️⃣ Empty grouped table first
        await targetCol.deleteMany({});

        // Pre-load small exclusion sets (same_sku typically 0, same_upc ~4.5k)
        const excludeIds = [
            ...(await db.collection("filter_same_upc").find({}, { projection: { _id: 1 } }).toArray()).map(d => d._id),
            ...(await db.collection("filter_same_sku").find({}, { projection: { _id: 1 } }).toArray()).map(d => d._id),
        ];
        console.log(`📋 Pre-loaded ${excludeIds.length} exclusion IDs (same_upc + same_sku)`);

        await rawCol.aggregate(
            [
                // 🔎 Filter by UPC first — eliminates ~78% of rows before lookups
                // Also exclude small filter tables via pre-loaded $nin
                {
                    $match: {
                        normalized_upc: { $nin: [null, ""] },
                        ...(excludeIds.length > 0 ? { _id: { $nin: excludeIds } } : {}),
                    }
                },

                // 🔎 Exclude rows in filter_null_manufacturer (~269k rows after UPC filter)
                // filter_null_upc lookup removed — 0 overlap with rows that have a UPC
                {
                    $lookup: {
                        from: "filter_null_manufacturer",
                        localField: "_id",
                        foreignField: "_id",
                        as: "inNullManufacturer"
                    }
                },
                {
                    $match: {
                        inNullManufacturer: { $size: 0 },
                    }
                },

                // 🏗 Group by normalized_upc
                {
                    $group: {
                        _id: "$normalized_upc",
                        upc: { $first: "$upc" },
                        normalized_upc: { $first: "$normalized_upc" },

                        sku_list: { $addToSet: "$sku" },
                        normalized_sku_list: { $addToSet: "$normalized_sku" },
                        manufacturer_map_list: { $addToSet: "$manufacturer_map" },

                        distributor_rows: {
                            $addToSet: {
                                raw_sku: "$sku",
                                normalized_sku: "$normalized_sku",
                                distributor: "$distributor"
                            }
                        }
                    }
                },

                // 🔄 Build distributor_list structure
                {
                    $addFields: {
                        distributor_list: {
                            $map: {
                                input: "$distributor_rows",
                                as: "row",
                                in: {
                                    raw_sku: "$$row.raw_sku",
                                    normalized_sku: "$$row.normalized_sku",
                                    distributors: ["$$row.distributor"]
                                }
                            }
                        },
                        canonical_manufacturer: {
                            $arrayElemAt: ["$manufacturer_map_list", 0]
                        },
                        sku_count: { $size: "$normalized_sku_list" }
                    }
                },

                {
                    $project: {
                        distributor_rows: 0
                    }
                },

                {
                    $merge: {
                        into: "grouped_upc_data",
                        whenMatched: "replace",
                        whenNotMatched: "insert"
                    }
                }
            ],
            { allowDiskUse: true }
        ).toArray();

        return

    } catch (err: any) {
        console.error(err);
        return
    }
};
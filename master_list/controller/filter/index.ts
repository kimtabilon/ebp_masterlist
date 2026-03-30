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

        await rawCol.aggregate(
            [
                // 🔎 Exclude rows already in filter tables
                {
                    $lookup: {
                        from: "filter_null_manufacturer",
                        localField: "_id",
                        foreignField: "_id",
                        as: "inNullManufacturer"
                    }
                },
                {
                    $lookup: {
                        from: "filter_null_upc",
                        localField: "_id",
                        foreignField: "_id",
                        as: "inNullUpc"
                    }
                },
                {
                    $lookup: {
                        from: "filter_same_sku",
                        localField: "_id",
                        foreignField: "_id",
                        as: "inSameSku"
                    }
                },
                {
                    $lookup: {
                        from: "filter_same_upc",
                        localField: "_id",
                        foreignField: "_id",
                        as: "inSameUpc"
                    }
                },
                {
                    $match: {
                        inNullManufacturer: { $size: 0 },
                        inNullUpc: { $size: 0 },
                        inSameSku: { $size: 0 },
                        inSameUpc: { $size: 0 },
                        normalized_upc: { $nin: [null, ""] }
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
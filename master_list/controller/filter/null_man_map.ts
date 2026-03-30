// controllers/distNullManufacturer.controller.ts

import type { Request, Response } from "express";
import { getDb } from "../../config/mongdodb.config";

export const insertAllNullManufacturerMapSkus = async (

) => {
  try {
    const db = await getDb("master_list");
    const source = db.collection("dist_combined_raw");
    const target = db.collection("filter_null_manufacturer");

    // 1️⃣ Empty target collection (keeps indexes)
    await target.deleteMany({});

    // 2️⃣ Aggregation pipeline
    await source.aggregate(
      [
        {
          $match: {
            sku: { $nin: [null, ""] }
          }
        },

        {
          $group: {
            _id: "$sku",
            rows: { $push: "$$ROOT" },

            // Count rows where manufacturer_map has value
            nonNullCount: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $ne: ["$manufacturer_map", null] },
                      { $ne: ["$manufacturer_map", ""] }
                    ]
                  },
                  1,
                  0
                ]
              }
            }
          }
        },

        // Keep only SKUs where ALL manufacturer_map are null/empty
        {
          $match: {
            nonNullCount: 0
          }
        },

        { $unwind: "$rows" },
        { $replaceRoot: { newRoot: "$rows" } },

        {
          $addFields: {
            copied_from: "dist_combined_raw",
            copied_at: new Date()
          }
        },

        {
          $merge: {
            into: "filter_null_manufacturer",
            whenMatched: "keepExisting",
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
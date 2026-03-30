// controllers/distSameUpc.controller.ts
import type { Request, Response } from "express";
import type { Db } from "mongodb";
import ExcelJS from "exceljs";
import { getDb } from "../../config/mongdodb.config";


export const exportSameUpcToXlsx = async () => {
    try {
        const db = await getDb('master_list');
        db.dropCollection('filter_same_upc')
        const sourceCol = db.collection("dist_combined_raw");
        const targetCol = db.collection("filter_same_upc");

        //LG - UA

        const pipeline: any[] = [
          {
            $match: {
              upc: { $nin: [null, ""] },
              normalized_sku: { $nin: [null, ""] },
              $or: [
                // Keep ALL non-Canon
                { manufacturer_map: { $ne: "CANON" } },

                // For Canon → exclude AA / BA
                {
                  $and: [
                    { manufacturer_map: "CANON" },
                    { normalized_sku: { $not: /AA$/ } },
                    { normalized_sku: { $not: /BA$/ } }
                  ]
                }
              ]
            }
          },
          {
            $group: {
              _id: "$upc",
              skuSet: { $addToSet: "$normalized_sku" },
              rowCount: { $sum: 1 }
            }
          },
          {
            $addFields: {
              skuCount: { $size: "$skuSet" }
            }
          },
          {
            $match: {
              skuCount: { $gt: 1 }
            }
          },
          { $sort: { skuCount: -1 } }
        ];


        const duplicateUpcs = await sourceCol.aggregate(pipeline).toArray();

        if (!duplicateUpcs.length) {
            return
        }

        const upcList = duplicateUpcs.map(d => d._id);

        // ================================
        // STEP 2: Get all rows for those UPCs
        // ================================
        const docs = await sourceCol.find({
            upc: { $in: upcList }
        }).toArray();

        // ================================
        // STEP 3: Insert into filter_same_upc (upsert)
        // ================================
        const bulkOps = docs.map(d => ({
            updateOne: {
                filter: { _id: d._id },
                update: {
                    $setOnInsert: {
                        ...d,
                        copied_from: "dist_combined_raw",
                        copied_at: new Date()
                    }
                },
                upsert: true
            }
        }));

        await targetCol.bulkWrite(bulkOps, { ordered: false });
        return

    } catch (err: any) {
        console.error(err);
        return
    }
};

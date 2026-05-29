// controllers/distSameSku.controller.ts
import type { Request, Response } from "express";
import type { Db } from "mongodb";
import ExcelJS from "exceljs";
import { getDb } from "../../config/mongdodb.config";



export const exportSameSkuToXlsx = async () => {
  try {
    const db = await getDb('master_list');

    const sourceCol = db.collection("dist_combined_raw");
    const targetCol = db.collection("filter_same_sku");



    // ================================
    // STEP 1: Find SKU with multiple UPC
    // ================================
    // ================================
    // STEP 1: Find SKU with multiple NORMALIZED UPC
    // ================================
    const pipeline: any[] = [
      {
        $match: {
          sku: { $nin: [null, ""] },
          normalized_upc: { $nin: [null, ""] }, // ✅ use normalized_upc
        },
      },
      {
        $group: {
          _id: "$sku",
          normalizedUpcSet: { $addToSet: "$normalized_upc" }, // ✅ group by normalized
        },
      },
      {
        $addFields: {
          upcCount: { $size: "$normalizedUpcSet" },
        },
      },
      {
        $match: {
          upcCount: { $gt: 1 }, // ✅ only SKUs with multiple normalized UPC
        },
      },
      { $sort: { upcCount: -1 } },
    ];



    const duplicateSkus = await sourceCol
      .aggregate(pipeline, { allowDiskUse: true })
      .toArray();

    if (!duplicateSkus.length) {
      return
    }

    const skuList = duplicateSkus.map((d) => d._id);

    // ================================
    // STEP 2: Get all rows for those SKUs
    // ================================
    const docs = await sourceCol
      .find({ sku: { $in: skuList } })
      .toArray();

    // ================================
    // STEP 3: Insert into filter_same_sku
    // ================================
    const bulkOps = docs.map((d: any) => ({
      updateOne: {
        filter: { _id: d._id },
        update: {
          $setOnInsert: {
            ...d,
            copied_from: "dist_combined_raw",
            copied_at: new Date(),
          },
        },
        upsert: true,
      },
    }));

    await targetCol.bulkWrite(bulkOps, { ordered: false });

    // const fileName = `filter_same_sku_${Date.now()}.xlsx`;

    // res.setHeader(
    //   "Content-Type",
    //   "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    // );
    // res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);

    // await workbook.xlsx.write(res);
    return
  } catch (err: any) {
    console.error(err);

  }
};

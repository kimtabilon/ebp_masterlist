import type { Request, Response } from "express";
import { ObjectId } from "mongodb";
import { getDb } from "../config/mongdodb.config";


const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_GET_ALL_LIMIT = 10000;

function escapeRegex(input: string) {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function decodeXml(str: string | null) {
    if (!str) return str;
    return str
        .replace(/\\u003C/g, "<")
        .replace(/\\u003E/g, ">")
        .replace(/\\u0026/g, "&");
}

export const query = async (req: Request, res: Response) => {
  const { filter = {}, attr = {}, sort = {}, limit = 50 } = req.body;

  // console.log("Filter:", filter);
  // console.log("Projection:", attr);
  // console.log("Sort:", sort);
  // console.log("Limit:", limit);

  try {
    const db: any = await getDb("master_list");
    const collection = db.collection("product_list");

    // Correct usage
    const cursor = collection.find(filter, { projection: attr }).sort(sort).limit(Number(limit));
    const result = await cursor.toArray(); // convert cursor to array

    return res.status(200).json({
      success: true,
      count: result.length,
      data: result,
    });
  } catch (error) {
    console.error("MongoDB query error:", error); // always log real error
    return res.status(500).json({
      success: false,
      message: "Query failed",
      error: error.message || error,
    });
  }
};

export const manufacturerList = async (req: Request, res: Response) => {
    try {
        const db: any = await getDb("master_list");
        const collection = db.collection("product_list");

        const manufacturers = await collection.distinct("manufacturer_map");

        return res.status(200).json({
            success: true,
            data: manufacturers,
        });

    } catch (error: any) {
        console.error("manufacturerList error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch manufacturerList",
            error: error?.message || "Unknown error",
        });
    }
};

export const getTmpProductList = async (req: Request, res: Response) => {
    console.log("=== getTmpProductList (Mongo Native) ===");

    try {
        const db: any = await getDb("master_list");
        const collection = db.collection("product_list");

        const {
            id,
            sku,
            specificSku,
            search,
            manufacturer,
            disti,
            page: pageQuery,
            pageSize: pageSizeQuery,
            getAll,
        } = req.query;

        let filter: any = {};

        // ✅ ID filter
        if (typeof id === "string" && ObjectId.isValid(id)) {
            filter._id = new ObjectId(id);
            console.log(`Filter _id = ${id}`);
        }

        // ✅ Specific SKU
        if (typeof specificSku === "string" && specificSku.trim() !== "") {
            filter.normalized_sku = specificSku.trim();
        }
        // ✅ SKU regex
        else if (typeof sku === "string" && sku.trim() !== "") {
            filter.normalized_sku = {
                $regex: escapeRegex(sku.trim()),
                $options: "i",
            };
        }

        // ✅ Manufacturer
        if (typeof manufacturer === "string" && manufacturer.trim() !== "") {
            filter.manufacturer = {
                $regex: escapeRegex(manufacturer.trim()),
                $options: "i",
            };
        }

        // ✅ Distributor
        if (typeof disti === "string" && disti.trim() !== "") {
            filter.distributor = {
                $regex: escapeRegex(disti.trim()),
                $options: "i",
            };
        }

        // ✅ Global search
        if (typeof search === "string" && search.trim() !== "") {
            const rx = {
                $regex: escapeRegex(search.trim()),
                $options: "i",
            };

            const orClause = {
                $or: [
                    { sku: rx },
                    { manufacturer: rx },
                    { distributor: rx },
                ],
            };

            filter =
                Object.keys(filter).length > 0
                    ? { $and: [filter, orClause] }
                    : orClause;
        }

        console.log(filter)

        const wantAll = getAll === "true";

        let records: any[] = [];
        let totalRows = 0;

        const hasFilterQuery =
            id || sku || specificSku || search || manufacturer || disti;

        const hasAnyQuery = Object.keys(req.query || {}).length > 0;
        const isNoQuery = !hasAnyQuery || !hasFilterQuery;

        if (wantAll) {
            const cursor = collection
                .find(filter)
                .sort({ _id: 1 })
                .limit(MAX_GET_ALL_LIMIT + 1);

            const found = await cursor.toArray();

            if (found.length > MAX_GET_ALL_LIMIT) {
                return res.status(413).json({
                    success: false,
                    message: `Too many records. Use pagination (max ${MAX_GET_ALL_LIMIT})`,
                });
            }

            records = found;
            totalRows = found.length;
        } else {
            const page =
                typeof pageQuery === "string"
                    ? Math.max(DEFAULT_PAGE, parseInt(pageQuery, 10) || DEFAULT_PAGE)
                    : DEFAULT_PAGE;

            const pageSize =
                isNoQuery
                    ? 100
                    : typeof pageSizeQuery === "string"
                        ? Math.max(
                            1,
                            parseInt(pageSizeQuery, 10) || DEFAULT_PAGE_SIZE
                        )
                        : DEFAULT_PAGE_SIZE;

            const skip = (page - 1) * pageSize;

            totalRows = await collection.countDocuments(filter);

            records = await collection
                .find(filter)
                .sort({ _id: 1 })
                .skip(skip)
                .limit(pageSize)
                .toArray();

            console.log(`Page ${page} fetched ${records.length} records`);
        }

        // ✅ Compute total_count only
        const enhancedRecords = records.map((item) => {
            const total_count =
                Number(item.supplies_count || 0) +
                Number(item.dandh_count || 0) +
                Number(item.synnex_count || 0) +
                Number(item.ingram_count || 0);

            return {
                ...item,
                total_count,
            };
        });

        return res.status(200).json({
            success: true,
            data: enhancedRecords,
            pagination: wantAll
                ? undefined
                : {
                    totalRows,
                    currentPage:
                        typeof pageQuery === "string"
                            ? parseInt(pageQuery, 10) || DEFAULT_PAGE
                            : DEFAULT_PAGE,
                    pageSize:
                        isNoQuery
                            ? 100
                            : typeof pageSizeQuery === "string"
                                ? parseInt(pageSizeQuery, 10) || DEFAULT_PAGE_SIZE
                                : DEFAULT_PAGE_SIZE,
                    totalPages: Math.ceil(
                        totalRows /
                        (
                            isNoQuery
                                ? 100
                                : typeof pageSizeQuery === "string"
                                    ? parseInt(pageSizeQuery, 10) || DEFAULT_PAGE_SIZE
                                    : DEFAULT_PAGE_SIZE
                        )
                    ),
                },
        });
    } catch (error: any) {
        console.error("getTmpProductList error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch product list",
            error: error?.message || "Unknown error",
        });
    }
};
const safeParseInt = (val: any, fallback = 0) => {
    const n = Number(val);
    return Number.isFinite(n) && !Number.isNaN(n) ? Math.trunc(n) : fallback;
};

const safeString = (val: any) => (val === null || val === undefined ? '' : String(val));

const logError = (context: string, err: any) => {
    console.error(`❌ [${context}]`, err && err.stack ? err.stack : err);
};
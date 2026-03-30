// src/jobs/syncMongoToMysql.ts
import mysql from "mysql2/promise";
import { getDb } from "../../config/mongdodb.config";


/**
 * Helper: clean manufacturer_map (remove surrounding curly braces if present)
 */
function cleanManufacturerMap(value: any): string | null {
    if (value === undefined || value === null) return null;
    const s = value.toString();
    const cleaned = s.replace(/[{}]/g, "").trim();
    return cleaned === "" ? null : cleaned;
}

/**
 * Helper: format distributor_list into Postgres-style array string {a,b,c}
 * If incoming is already a string, keep it as-is; if array -> join.
 */
function formatDistributorList(list: any): string | null {
    if (!list) return null;
    if (Array.isArray(list)) {
        return `{${list.join(",")}}`;
    }
    const s = list.toString().trim();
    return s === "" ? null : s;
}
function toTwoDecimals(val: any): number {
    const n = parseFloat(val);
    return isNaN(n) ? 0 : parseFloat(n.toFixed(2));
}


// export async function syncMongoToMysql() {
//     const db = getDb();
//     const cursor = db.collection("product_list").find();

//     const conn = await mysql.createConnection({
//         host: "190.92.158.197",
//         user: "ecomm_vgAdmin",
//         password: "Ri4z^{@q)EaR",
//         database: process.env.DB_NAME || "ecomm_test_db",
//         multipleStatements: true,
//     });

//     console.log("🚀 Building distributor caches...");

//     const [
//         synnexCache,
//         dandhCache,
//         suppliesCache,
//     ] = await Promise.all([
//         buildDistCache(db, "dist_synnex_raw"),
//         buildDistCache(db, "dist_dandh_raw"),
//         buildDistCache(db, "dist_supplies_raw"),
//     ]);

//     console.log("✅ Caches loaded");

//     const BATCH_SIZE = 5000;
//     let batch: any[] = [];

//     while (await cursor.hasNext()) {
//         const doc: any = await cursor.next();

//         const rawSku = doc.sku?.toString().trim() || null;
//         if (!rawSku) continue;

//         const normalizedSku =
//             doc.normalized_sku ||
//             rawSku.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();

//         const synnex = synnexCache.get(rawSku);
//         const dandh = dandhCache.get(rawSku);
//         const supplies = suppliesCache.get(rawSku);

//         const { ingram_map, ingram_msrp } =
//             extractIngramMapMsrp(doc.ingram_response);

//         batch.push([
//             rawSku,
//             normalizedSku,
//             doc.upc || null,
//             cleanManufacturerMap(doc.manufacturer_map),
//             formatDistributorList(doc.distributor_list),

//             doc.synnex_response || null,
//             toTwoDecimals(doc.synnex_price),
//             doc.synnex_quantity ?? 0,
//             synnex?.map ?? 0,
//             synnex?.msrp ?? 0,

//             doc.ingram_response || null,
//             toTwoDecimals(doc.ingram_price),
//             doc.ingram_quantity ?? 0,
//             ingram_map,
//             ingram_msrp,

//             doc.dandh_response || null,
//             toTwoDecimals(doc.dandh_price),
//             doc.dandh_quantity ?? 0,
//             dandh?.map ?? 0,
//             dandh?.msrp ?? 0,

//             doc.supplies_response || null,
//             toTwoDecimals(doc.supplies_price),
//             doc.supplies_count ?? 0,
//             supplies?.map ?? 0,
//             supplies?.msrp ?? 0,

//             (doc.synnex_quantity ?? 0) +
//             (doc.ingram_quantity ?? 0) +
//             (doc.dandh_quantity ?? 0) +
//             (doc.supplies_count ?? 0),

//             doc.condition || "new",
//             doc.category_class || null,
//             doc.category_class_l2 || null,
//             doc.category_class_l3 || null,
//             doc.priority || null,
//             doc.created_at || new Date(),
//             doc.updated_at || new Date(),
//         ]);

//         if (batch.length >= BATCH_SIZE) {
//             await upsertBatch(conn, batch);
//             batch = [];
//         }
//     }

//     if (batch.length) {
//         await upsertBatch(conn, batch);
//     }

//     await conn.end();
//     console.log("🎉 Sync complete");
// }
export async function syncMongoToMysql() {
    const db = await getDb('master_list');
    const cursor = db.collection("product_list").find();

    const conn = await mysql.createConnection({
        host: "190.92.158.197",
        user: "ecomm_vgAdmin",
        password: "Ri4z^{@q)EaR",
        database:"ecomm_ebp_test",
        multipleStatements: true,
    });

    console.log("🚀 Building distributor caches...");

    const [synnexCache, dandhCache, suppliesCache] = await Promise.all([
        buildDistCache(db, "dist_synnex_raw"),
        buildDistCache(db, "dist_dandh_raw"),
        buildDistCache(db, "dist_supplies_raw"),
    ]);

    console.log("✅ Caches loaded");

    const BATCH_SIZE = 5000;
    let batch: any[] = [];

    while (await cursor.hasNext()) {
        const doc: any = await cursor.next();

        const rawSku = doc.sku?.toString().trim() || null;
        if (!rawSku) continue;

        const normalizedSku =
            doc.normalized_sku || rawSku.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();

        const synnex = synnexCache.get(rawSku);
        const dandh = dandhCache.get(rawSku);
        const supplies = suppliesCache.get(rawSku);

        const { ingram_map, ingram_msrp } = extractIngramMapMsrp(doc.ingram_response);

        // ✅ NEW: name from product_list
        const name = (doc.name ?? null) ? String(doc.name).trim() : null;

        batch.push([
            rawSku,
            normalizedSku,

            // ✅ NEW FIELD (must match MySQL insert column order)
            name,

            doc.upc || null,
            cleanManufacturerMap(doc.manufacturer_map),
            formatDistributorList(doc.distributor_list),

            doc.synnex_response || null,
            toTwoDecimals(doc.synnex_price),
            doc.synnex_quantity ?? 0,
            synnex?.map ?? 0,
            synnex?.msrp ?? 0,

            doc.ingram_response || null,
            toTwoDecimals(doc.ingram_price),
            doc.ingram_quantity ?? 0,
            ingram_map,
            ingram_msrp,

            doc.dandh_response || null,
            toTwoDecimals(doc.dandh_price),
            doc.dandh_quantity ?? 0,
            dandh?.map ?? 0,
            dandh?.msrp ?? 0,

            doc.supplies_response || null,
            toTwoDecimals(doc.supplies_price),
            doc.supplies_count ?? 0,
            supplies?.map ?? 0,
            supplies?.msrp ?? 0,

            (doc.synnex_quantity ?? 0) +
            (doc.ingram_quantity ?? 0) +
            (doc.dandh_quantity ?? 0) +
            (doc.supplies_count ?? 0),

            doc.condition || "new",
            doc.category_class || null,
            doc.category_class_l2 || null,
            doc.category_class_l3 || null,
            doc.priority || null,
            doc.created_at || new Date(),
            doc.updated_at || new Date(),
        ]);

        if (batch.length >= BATCH_SIZE) {
            await upsertBatch(conn, batch);
            batch = [];
        }
    }

    if (batch.length) {
        await upsertBatch(conn, batch);
    }

    await conn.end();
    console.log("🎉 Sync complete");
}

async function buildDistCache(db: any, collection: string) {
    const cursor = db.collection(collection).find(
        {},
        { projection: { sku: 1, map: 1, msrp: 1 } }
    );

    const cache = new Map<string, { map: number; msrp: number }>();

    while (await cursor.hasNext()) {
        const row: any = await cursor.next();
        if (!row?.sku) continue;

        cache.set(row.sku.trim(), {
            map: toTwoDecimals(row.map),
            msrp: toTwoDecimals(row.msrp),
        });
    }

    return cache;
}

function extractIngramMapMsrp(ingramResponse: any) {
    try {
        const data =
            typeof ingramResponse === "string"
                ? JSON.parse(ingramResponse)
                : ingramResponse;

        const pricing = data?.pricing || {};

        return {
            ingram_map: toTwoDecimals(pricing.mapPrice),
            ingram_msrp: toTwoDecimals(pricing.retailPrice),
        };
    } catch {
        return { ingram_map: 0, ingram_msrp: 0 };
    }
}
/**
 * UPSERT BATCH HELPER (matches on sku only)
 */

async function upsertBatch(conn: mysql.Connection, batch: any[]) {
    const sql = `
    INSERT INTO tmp_product_list_master (
      sku,
      normalized_sku,
      product_name,   -- ✅ FIXED NAME
      upc,
      manufacturer,
      distributor,

      synnex_response,
      synnex_price,
      synnex_count,
      synnex_map,
      synnex_msrp,

      ingram_response,
      ingram_price,
      ingram_count,
      ingram_map,
      ingram_msrp,

      dandh_response,
      dandh_price,
      dandh_count,
      dandh_map,
      dandh_msrp,

      supplies_response,
      supplies_price,
      supplies_count,
      supplies_map,
      supplies_msrp,

      total_count,
      \`condition\`,
      category_class,
      category_class_l2,
      category_class_l3,
      priority,
      created_at,
      updated_at
    )
    VALUES ?
    ON DUPLICATE KEY UPDATE
      normalized_sku = VALUES(normalized_sku),
      product_name = VALUES(product_name),   -- ✅ IMPORTANT
      upc = VALUES(upc),
      manufacturer = VALUES(manufacturer),
      distributor = VALUES(distributor),

      synnex_response = VALUES(synnex_response),
      synnex_price = VALUES(synnex_price),
      synnex_count = VALUES(synnex_count),
      synnex_map = VALUES(synnex_map),
      synnex_msrp = VALUES(synnex_msrp),

      ingram_response = VALUES(ingram_response),
      ingram_price = VALUES(ingram_price),
      ingram_count = VALUES(ingram_count),
      ingram_map = VALUES(ingram_map),
      ingram_msrp = VALUES(ingram_msrp),

      dandh_response = VALUES(dandh_response),
      dandh_price = VALUES(dandh_price),
      dandh_count = VALUES(dandh_count),
      dandh_map = VALUES(dandh_map),
      dandh_msrp = VALUES(dandh_msrp),

      supplies_response = VALUES(supplies_response),
      supplies_price = VALUES(supplies_price),
      supplies_count = VALUES(supplies_count),
      supplies_map = VALUES(supplies_map),
      supplies_msrp = VALUES(supplies_msrp),

      total_count = VALUES(total_count),
      \`condition\` = VALUES(\`condition\`),

      category_class = IF(tmp_product_list_master.category_class IS NULL,
                          VALUES(category_class),
                          tmp_product_list_master.category_class),

      category_class_l2 = IF(tmp_product_list_master.category_class_l2 IS NULL,
                             VALUES(category_class_l2),
                             tmp_product_list_master.category_class_l2),

      category_class_l3 = IF(tmp_product_list_master.category_class_l3 IS NULL,
                             VALUES(category_class_l3),
                             tmp_product_list_master.category_class_l3),

      priority = VALUES(priority),
      updated_at = VALUES(updated_at)
  `;

    await conn.query(sql, [batch]);
}


async function getSynnexMapMsrp(db: any, sku: string | null) {
    if (!sku) {
        return { synnex_map: 0, synnex_msrp: 0 };
    }

    const row = await db
        .collection("dist_synnex_raw")
        .findOne(
            { sku },
            { projection: { map: 1, msrp: 1 } }
        );

    return {
        synnex_map: row?.map ?? 0,
        synnex_msrp: row?.msrp ?? 0,
    };
}

/**
 * Migrate dist_combined_raw collection → MySQL dist_combined_rawdata
 */
export async function migrateDistCombinedRaw() {
    try {
        const db = await getDb('master_list');
        const mongoCursor = db.collection("dist_combined_raw").find();

        const connection = await mysql.createConnection({
            host: "190.92.158.197",
            user: "ecomm_vgAdmin",
            password: "Ri4z^{@q)EaR",
            database: process.env.DB_NAME || "ecomm_test_db",
            multipleStatements: true,
        });

        try {
            console.log("📌 Connected to MySQL (dist_combined_rawdata)");

            const INSERT_BATCH = 5000;
            let batch: any[] = [];
            let attempted = 0;

            while (await mongoCursor.hasNext()) {
                const doc: any = await mongoCursor.next();

                const manufacturerClean = cleanManufacturerMap(doc.manufacturer_map);

                const row = [
                    doc.sku || null,
                    doc.upc || null,
                    manufacturerClean, // cleaned manufacturer_map
                    doc.manufacturer || null,
                    doc.distributor || null,
                    doc.flag ?? 0,
                    doc.normalized_sku || null,
                ];

                batch.push(row);

                if (batch.length >= INSERT_BATCH) {
                    await insertBatchIgnore(connection, batch);
                    attempted += batch.length;
                    console.log(`⚡ Inserted ${attempted} rows (IGNORE duplicates)`);
                    batch = [];
                }
            }

            if (batch.length > 0) {
                await insertBatchIgnore(connection, batch);
                attempted += batch.length;
                console.log(`⚡ Inserted final: ${batch.length} rows`);
            }

            await connection.end();

            console.log("============================================");
            console.log(`🎉 Migration Completed → Total attempted inserts: ${attempted}`);
            console.log("============================================");
        } catch (innerErr) {
            await connection.end();
            throw innerErr;
        }
    } catch (err) {
        console.error("❌ migrateDistCombinedRaw error:", err);
    }
}



// ------------------------------------------------------
// FAST BATCH INSERT — IGNORE DUPLICATES
// ------------------------------------------------------
async function insertBatchIgnore(conn: any, batch: any[]) {
    const sql = `
        INSERT IGNORE INTO dist_combined_rawdata 
        (sku, upc, manufacturer_map, manufacturer, distributor, flag, normalized_sku)
        VALUES ?
    `;

    await conn.query(sql, [batch]);
}


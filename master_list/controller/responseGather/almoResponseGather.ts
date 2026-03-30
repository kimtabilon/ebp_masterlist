import pLimit from "p-limit";
import { getDb } from "../../config/mongdodb.config";

function cleanString(val: any): string {
    if (val === null || val === undefined) return "";
    return String(val).replace(/["']/g, "").replace(/\s+/g, " ").trim();
}

export async function buildAlmoResponseTable() {
    const db = await getDb("master_list");

    console.log("🚀 Building ALMO response table...");

    await db.dropCollection("almo_response_table").catch(() => { });
    await db.createCollection("almo_response_table");

    const table = db.collection("almo_response_table");
    await table.createIndex({ sku: 1 }, { unique: true }).catch(() => { });

    // ----------------------------------------------------
    // 1️⃣ Collect ALMO SKUs from grouped_upc_data
    // ----------------------------------------------------

    const groupedCursor = db.collection("grouped_upc_data").find();

    const skuMeta: Record<
        string,
        {
            raw_sku: string;
            normalized_sku: string;
            upc: string | null;
            normalized_upc: string | null;
            manufacturer_map: string | null;
        }
    > = {};

    while (await groupedCursor.hasNext()) {
        const g: any = await groupedCursor.next();

        const upc = cleanString(g.upc);
        const normalized_upc = cleanString(g.normalized_upc);

        const manufacturer_map = Array.isArray(g.manufacturer_map_list)
            ? cleanString(g.manufacturer_map_list.find((m: any) => m !== null) ?? "")
            : null;

        for (const dl of g.distributor_list || []) {
            if (!dl.distributors?.includes("almo")) continue;

            const rawSku = cleanString(dl.raw_sku);
            const normalized_sku = cleanString(dl.normalized_sku);

            skuMeta[rawSku] = {
                raw_sku: rawSku,
                normalized_sku,
                upc,
                normalized_upc,
                manufacturer_map,
            };
        }
    }

    const allSkus = Object.keys(skuMeta);
    if (allSkus.length === 0) {
        console.log("⚠ No ALMO SKUs found in grouped_upc_data");
        return true;
    }

    console.log(`📦 Found ${allSkus.length} ALMO SKUs`);

    // ----------------------------------------------------
    // 2️⃣ Process in parallel batches
    // ----------------------------------------------------

    const batchSize = 500;
    const batches: string[][] = [];

    for (let i = 0; i < allSkus.length; i += batchSize) {
        batches.push(allSkus.slice(i, i + batchSize));
    }

    const limit = pLimit(5);

    await Promise.all(
        batches.map((batch) =>
            limit(async () => {
                const rows = await db
                    .collection("dist_almo_raw")
                    .find({ sku: { $in: batch } })
                    .toArray();

                const rowMap: Record<string, any> = {};
                for (const r of rows) {
                    rowMap[cleanString(r.sku)] = r;
                }

                const docs: any[] = [];

                for (const skuRaw of batch) {
                    const sku = cleanString(skuRaw);
                    const meta = skuMeta[sku];

                    const rec =
                        rowMap[sku] ??
                        (await db.collection("dist_almo_raw").findOne({
                            sku: meta.normalized_sku,
                        })) ??
                        null;

                    if (!rec) {
                        docs.push({
                            sku,
                            raw_sku: sku,
                            normalized_sku: meta.normalized_sku,
                            upc: meta.upc,
                            normalized_upc: meta.normalized_upc,
                            manufacturer_map: meta.manufacturer_map,
                            distributor: "almo",
                            almo_response: "missing",
                            almo_price: null,
                            almo_count: 0,
                            created_at: new Date(),
                            updated_at: new Date(),
                        });
                        continue;
                    }

                    const OH = Number(rec.OH || 0);
                    const PA = Number(rec.PA || 0);
                    const NV = Number(rec.NV || 0);
                    const GA = Number(rec.GA || 0);
                    const AZ = Number(rec.AZ || 0);
                    const TX = Number(rec.TX || 0);
                    const WI = Number(rec.WI || 0);
                    const PACabot = Number(rec["PA-Cabot"] || 0);

                    const total =
                        OH + PA + NV + GA + AZ + TX + WI + PACabot;

                    docs.push({
                        sku,
                        raw_sku: sku,
                        normalized_sku: meta.normalized_sku,
                        upc: meta.upc,
                        normalized_upc: meta.normalized_upc,
                        manufacturer_map: meta.manufacturer_map,
                        distributor: "almo",
                        almo_response: {
                            OH,
                            PA,
                            NV,
                            GA,
                            AZ,
                            TX,
                            WI,
                            PACabot,
                        },
                        almo_price: rec.price ?? null,
                        almo_count: total,
                        created_at: new Date(),
                        updated_at: new Date(),
                    });
                }

                if (docs.length) {
                    await table.insertMany(docs, { ordered: false }).catch(() => { });
                }
            })
        )
    );

    console.log("🎉 ALMO response table build complete");
    return true;
}

export default buildAlmoResponseTable;
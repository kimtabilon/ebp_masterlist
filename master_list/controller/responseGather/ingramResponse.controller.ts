import axios from "axios";
import pLimit from "p-limit";
import qs from "qs";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import { getDb } from "../../config/mongdodb.config";

const IM_CLIENT_ID = process.env.INGRAM_CLIENT_ID ?? "okl7XFfn5LX4nCD6qgbfvXtTDuJNBL1N";
const IM_CLIENT_SECRET = process.env.INGRAM_CLIENT_SECRET ?? "5mBmQs5ZYqU6GzHL";
const IM_CUSTOMER_NUMBER = process.env.INGRAM_CUSTOMER_NUMBER ?? "14-730262";
const IM_COUNTRY_CODE = process.env.INGRAM_COUNTRY_CODE ?? "US";

type SkuMeta = {
  raw_sku: string;
  normalized_sku: string;
  upc: string | null;
  normalized_upc: string | null;
  manufacturer_map: string | null;
};

function cleanStr(v: any) {
  if (typeof v !== "string") return v;
  return v.trim();
}

function toNum(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function extractVendorPartNumber(item: any): string | null {
  return (
    item?.vendorPartNumber ??
    item?.vendorpartnumber ??
    item?.vendorPartnumber ??
    item?.vendorpartNumber ??
    null
  );
}

let cachedToken: { access_token: string; expires_at: number } | null = null;

async function getIngramToken() {
  const now = Date.now();
  if (cachedToken && cachedToken.expires_at > now + 5000) return cachedToken;

  const data = qs.stringify({
    grant_type: "client_credentials",
    client_id: IM_CLIENT_ID,
    client_secret: IM_CLIENT_SECRET,
  });

  const res = await axios.post("https://api.ingrammicro.com:443/oauth/oauth20/token", data, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 30000,
    validateStatus: () => true,
  });

  if (!res.data?.access_token) {
    throw new Error(`Token failed: ${res.status} ${JSON.stringify(res.data ?? {})}`);
  }

  cachedToken = {
    access_token: res.data.access_token,
    expires_at: Date.now() + (res.data.expires_in ?? 3600) * 1000,
  };

  return cachedToken;
}

async function callIngramAPI(batchSkus: string[]) {
  const token = await getIngramToken();
  const correlationId = uuidv4();

  const payload = {
    products: batchSkus.map((sku) => ({ vendorpartnumber: sku })),
  };

  const { data, status } = await axios.post(
    "https://api.ingrammicro.com:443/resellers/v6/catalog/priceandavailability?includeAvailability=true&includePricing=true",
    payload,
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token.access_token}`,
        "IM-CustomerNumber": IM_CUSTOMER_NUMBER,
        "IM-CountryCode": IM_COUNTRY_CODE,
        "IM-CorrelationID": correlationId,
      },
      timeout: 480000,
      validateStatus: () => true,
    }
  );

  return { data, status };
}

type ParsedNode = { price: number | null; qty: number; authorized: boolean };
type ParsedEntry = { nodes: ParsedNode[]; rawItem: any | null };

export async function buildIngramResponseTable() {
  const db = await getDb("master_list");

  await db.dropCollection("ingram_response_table").catch(() => {});
  await db.createCollection("ingram_response_table").catch(() => {});
  const ingramTable = db.collection("ingram_response_table");

  await ingramTable.createIndex({ sku: 1 }, { unique: true }).catch(() => {});
  await ingramTable.createIndex({ ingram_status: 1 }).catch(() => {});

  const BUFFER_DIR = path.resolve("buffer");
  const BUFFER_FILE = path.join(BUFFER_DIR, "ingram_buffer.jsonl");
  fs.mkdirSync(BUFFER_DIR, { recursive: true });
  fs.writeFileSync(BUFFER_FILE, "", { encoding: "utf8" });

  const BUFFER_LIMIT = 1000;
  let bufferCount = 0;
  let totalInserted = 0;

  async function flushBuffer(silent = true) {
    try {
      const raw = fs.readFileSync(BUFFER_FILE, "utf8").trim();
      if (!raw) {
        bufferCount = 0;
        return;
      }

      const lines = raw.split("\n");
      const docs = lines.map((l) => JSON.parse(l));

      if (!silent) console.log(`📦 Flushing ${docs.length} → MongoDB...`);

      await ingramTable.insertMany(docs, { ordered: false }).catch((err: any) => {
        if (err?.code !== 11000) console.log("insertMany error:", err?.message || err);
      });

      totalInserted += docs.length;
      bufferCount = 0;
      fs.writeFileSync(BUFFER_FILE, "", { encoding: "utf8" });

      if (!silent) console.log(`✔ Ingram Flush complete. Total inserted: ${totalInserted}\n`);
    } catch (err: any) {
      console.log("❌ flushBuffer error:", err.message || err);
    }
  }

  async function writeToBuffer(doc: any) {
    for (const k of Object.keys(doc)) doc[k] = cleanStr(doc[k]);
    fs.appendFileSync(BUFFER_FILE, JSON.stringify(doc) + "\n", { encoding: "utf8" });
    bufferCount++;
    if (bufferCount >= BUFFER_LIMIT) await flushBuffer(false);
  }

  const groupedCursor = db.collection("grouped_upc_data").find();

  const skuMeta: Record<string, SkuMeta> = {};
  let totalSkuCount = 0;

  while (await groupedCursor.hasNext()) {
    const g: any = await groupedCursor.next();

    const upc = g.upc ?? null;
    const normalized_upc = g.normalized_upc ?? null;
    const manufacturer_map = Array.isArray(g.manufacturer_map_list)
      ? g.manufacturer_map_list.find((m: any) => m !== null) ?? null
      : null;

    for (const dl of g.distributor_list || []) {
      if (!Array.isArray(dl.distributors) || !dl.distributors.includes("ingram")) continue;

      const rawSku = dl.raw_sku;
      if (!rawSku) continue;

      skuMeta[rawSku] = {
        raw_sku: rawSku,
        normalized_sku: dl.normalized_sku ?? rawSku,
        upc,
        normalized_upc,
        manufacturer_map,
      };
      totalSkuCount++;
    }
  }

  if (totalSkuCount === 0) return true;

  const allSkus = Object.keys(skuMeta);
  const batchSize = 50;

  const batches: string[][] = [];
  for (let i = 0; i < allSkus.length; i += batchSize) {
    batches.push(allSkus.slice(i, i + batchSize));
  }

  const concurrency = 4;
  const limit = pLimit(concurrency);

  let currentBatchNumber = 0;

  const now = new Date();

  await Promise.all(
    batches.map((batch) =>
      limit(async () => {
        currentBatchNumber++;
        const bn = currentBatchNumber;

        let attempt = 0;
        const maxAttempts = 25;
        let ok = false;

        while (attempt < maxAttempts && !ok) {
          attempt++;
          try {
            const { data, status } = await callIngramAPI(batch);

            if (status === 429 || data?.status === 429 || data?.error) {
              await new Promise((r) => setTimeout(r, 3000));
              continue;
            }

            const products = Array.isArray(data) ? data : data?.products ?? [];

            const batchResults: Record<string, ParsedEntry> = {};
            const parsedSkus = new Set<string>();

            for (const item of products) {
              const sku = extractVendorPartNumber(item);
              if (!sku) continue;
              parsedSkus.add(sku);

              const authorizedFlag = item?.productAuthorized === false ? false : true;
              const totalAvailability = toNum(item?.availability?.totalAvailability ?? 0);

              const addNode = (priceVal: any, qtyVal: any) => {
                const priceNum = priceVal !== undefined && priceVal !== null ? Number(priceVal) : null;
                const qtyNum = toNum(qtyVal ?? 0);
                if (!batchResults[sku]) batchResults[sku] = { nodes: [], rawItem: item ?? null };
                batchResults[sku].nodes.push({
                  price: Number.isFinite(priceNum as any) ? (priceNum as number) : null,
                  qty: qtyNum,
                  authorized: authorizedFlag,
                });
                if (!batchResults[sku].rawItem) batchResults[sku].rawItem = item ?? null;
              };

              if (Array.isArray(item?.pricing) && item.pricing.length > 0) {
                for (const p of item.pricing) {
                  const priceVal = p?.customerPrice ?? p?.price ?? p?.listPrice ?? p?.unitPrice ?? null;
                  const qtyVal = p?.availability?.totalAvailability ?? totalAvailability;
                  addNode(priceVal, qtyVal);
                }
              } else if (item?.pricing && typeof item.pricing === "object") {
                const p = item.pricing;
                const priceVal = p?.customerPrice ?? p?.price ?? p?.listPrice ?? p?.unitPrice ?? null;
                const qtyVal = p?.availability?.totalAvailability ?? totalAvailability;
                addNode(priceVal, qtyVal);
              } else {
                const priceVal = item?.customerPrice ?? item?.price ?? null;
                addNode(priceVal, totalAvailability);
              }
            }

            // Write results for SKUs we got back
            for (const skuKey of Object.keys(batchResults)) {
              const entry = batchResults[skuKey];

              const authorizedNodes = entry.nodes.filter(
                (n) => n.authorized && n.price !== null && (n.price as number) > 0
              ) as { price: number; qty: number; authorized: boolean }[];

              let lowestPrice: number | null = null;
              let lowestQty = 0;
              let ingram_status = "ok";

              if (authorizedNodes.length > 0) {
                lowestPrice = Math.min(...authorizedNodes.map((n) => n.price));
                const nodeForLowest = authorizedNodes.find((n) => n.price === lowestPrice) || null;
                lowestQty = nodeForLowest ? nodeForLowest.qty : 0;
              } else {
                const anyNodes = entry.nodes.length > 0;
                const anyAuthorized = entry.nodes.some((n) => n.authorized);
                if (anyNodes && !anyAuthorized) {
                  ingram_status = "unauthorized";
                  lowestPrice = null;
                  lowestQty = 0;
                } else {
                  lowestPrice = null;
                  lowestQty = 0;
                }
              }

              const meta = skuMeta[skuKey];

              await writeToBuffer({
                sku: meta?.raw_sku ?? skuKey,
                raw_sku: meta?.raw_sku ?? skuKey,
                normalized_sku: meta?.normalized_sku ?? skuKey,
                upc: meta?.upc ?? null,
                normalized_upc: meta?.normalized_upc ?? null,
                manufacturer: null,
                manufacturer_map: meta?.manufacturer_map ?? null,
                distributor: "ingram",

                // ✅ status string
                ingram_status,

                ingram_price: lowestPrice,
                ingram_quantity: lowestQty,

                // ✅ raw response object stored here
                ingram_response: entry.rawItem ?? null,

                created_at: now,
                updated_at: now,
              });
            }

            // Any SKUs not returned by API => missing
            for (const sku of batch) {
              if (!parsedSkus.has(sku)) {
                const meta = skuMeta[sku];
                await writeToBuffer({
                  sku: meta?.raw_sku ?? sku,
                  raw_sku: meta?.raw_sku ?? sku,
                  normalized_sku: meta?.normalized_sku ?? sku,
                  upc: meta?.upc ?? null,
                  normalized_upc: meta?.normalized_upc ?? null,
                  manufacturer: null,
                  manufacturer_map: meta?.manufacturer_map ?? null,
                  distributor: "ingram",

                  ingram_status: "missing",

                  ingram_price: null,
                  ingram_quantity: 0,
                  ingram_response: null,

                  created_at: now,
                  updated_at: now,
                });
              }
            }

            ok = true;
            // await flushBuffer(false);
          } catch (err: any) {
            console.log(`❌ Batch ${bn} attempt ${attempt} failed:`, err?.message || err);
            await new Promise((r) => setTimeout(r, 3000));
          }
        }

        if (!ok) {
          for (const sku of batch) {
            const meta = skuMeta[sku];
            await writeToBuffer({
              sku: meta?.raw_sku ?? sku,
              raw_sku: meta?.raw_sku ?? sku,
              normalized_sku: meta?.normalized_sku ?? sku,
              upc: meta?.upc ?? null,
              normalized_upc: meta?.normalized_upc ?? null,
              manufacturer: null,
              manufacturer_map: meta?.manufacturer_map ?? null,
              distributor: "ingram",

              ingram_status: "error",

              ingram_price: null,
              ingram_quantity: 0,
              ingram_response: null,

              created_at: now,
              updated_at: now,
            });
          }
          // await flushBuffer(false);
        }
      })
    )
  );

  // await flushBuffer(false);

  // ✅ Retry based on ingram_status (NOT ingram_response, which is now an object)
  const toRetryRows = await ingramTable
    .find({ ingram_status: { $in: ["missing", "error"] } }, { projection: { sku: 1 } })
    .toArray();

  const retrySkus = toRetryRows.map((r: any) => cleanStr(r.sku));
  if (retrySkus.length === 0) return true;

  const retryBatchSize = 20;
  const retryBatches: string[][] = [];
  for (let i = 0; i < retrySkus.length; i += retryBatchSize) {
    retryBatches.push(retrySkus.slice(i, i + retryBatchSize));
  }

  const retryLimit = pLimit(3);

  await Promise.all(
    retryBatches.map((rb) =>
      retryLimit(async () => {
        try {
          const { data, status } = await callIngramAPI(rb);

          if (status === 429 || data?.status === 429 || data?.error) {
            for (const sku of rb) {
              await ingramTable.updateOne(
                { sku },
                {
                  $set: {
                    ingram_status: "missing_final",
                    ingram_response: null,
                    ingram_price: null,
                    ingram_quantity: 0,
                    updated_at: new Date(),
                  },
                }
              );
            }
            return;
          }

          const products = Array.isArray(data) ? data : data?.products ?? [];
          const found = new Set<string>();

          const results: Record<string, ParsedEntry> = {};

          for (const item of products) {
            const sku = extractVendorPartNumber(item);
            if (!sku) continue;
            found.add(sku);

            const authorizedFlag = item?.productAuthorized === false ? false : true;
            const totalAvailability = toNum(item?.availability?.totalAvailability ?? 0);

            const addNode = (priceVal: any, qtyVal: any) => {
              const priceNum = priceVal !== undefined && priceVal !== null ? Number(priceVal) : null;
              const qtyNum = toNum(qtyVal ?? 0);
              if (!results[sku]) results[sku] = { nodes: [], rawItem: item ?? null };
              results[sku].nodes.push({
                price: Number.isFinite(priceNum as any) ? (priceNum as number) : null,
                qty: qtyNum,
                authorized: authorizedFlag,
              });
              if (!results[sku].rawItem) results[sku].rawItem = item ?? null;
            };

            if (Array.isArray(item?.pricing) && item.pricing.length > 0) {
              for (const p of item.pricing) {
                const priceVal = p?.customerPrice ?? p?.price ?? p?.listPrice ?? p?.unitPrice ?? null;
                const qtyVal = p?.availability?.totalAvailability ?? totalAvailability;
                addNode(priceVal, qtyVal);
              }
            } else if (item?.pricing && typeof item.pricing === "object") {
              const p = item.pricing;
              const priceVal = p?.customerPrice ?? p?.price ?? p?.listPrice ?? p?.unitPrice ?? null;
              const qtyVal = p?.availability?.totalAvailability ?? totalAvailability;
              addNode(priceVal, qtyVal);
            } else {
              const priceVal = item?.customerPrice ?? item?.price ?? null;
              addNode(priceVal, totalAvailability);
            }
          }

          for (const sku of Object.keys(results)) {
            const entry = results[sku];

            const authorizedNodes = entry.nodes.filter(
              (n) => n.authorized && n.price !== null && (n.price as number) > 0
            ) as { price: number; qty: number; authorized: boolean }[];

            let lowestPrice: number | null = null;
            let lowestQty = 0;
            let ingram_status = "ok";

            if (authorizedNodes.length > 0) {
              lowestPrice = Math.min(...authorizedNodes.map((n) => n.price));
              const nodeForLowest = authorizedNodes.find((n) => n.price === lowestPrice) || null;
              lowestQty = nodeForLowest ? nodeForLowest.qty : 0;
            } else {
              const anyNodes = entry.nodes.length > 0;
              const anyAuthorized = entry.nodes.some((n) => n.authorized);
              if (anyNodes && !anyAuthorized) {
                ingram_status = "unauthorized";
                lowestPrice = null;
                lowestQty = 0;
              } else {
                lowestPrice = null;
                lowestQty = 0;
              }
            }

            await ingramTable.updateOne(
              { sku },
              {
                $set: {
                  ingram_status,
                  ingram_price: lowestPrice,
                  ingram_quantity: lowestQty,
                  ingram_response: entry.rawItem ?? null,
                  updated_at: new Date(),
                },
              }
            );
          }

          for (const sku of rb) {
            if (!found.has(sku)) {
              await ingramTable.updateOne(
                { sku },
                {
                  $set: {
                    ingram_status: "missing_final",
                    ingram_response: null,
                    ingram_price: null,
                    ingram_quantity: 0,
                    updated_at: new Date(),
                  },
                }
              );
            }
          }
        } catch {
          for (const sku of rb) {
            await ingramTable.updateOne(
              { sku },
              {
                $set: {
                  ingram_status: "missing_final",
                  ingram_response: null,
                  ingram_price: null,
                  ingram_quantity: 0,
                  updated_at: new Date(),
                },
              }
            );
          }
        }
      })
    )
  );

  return true;
}

export default buildIngramResponseTable;
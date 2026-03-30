import axios from "axios";
import qs from "qs";
import { v4 as uuidv4 } from "uuid";
import { getDb } from "../../config/mongdodb.config";

/* ============================================
   CONFIG
============================================ */
const IM_CLIENT_ID = process.env.INGRAM_CLIENT_ID ?? "okl7XFfn5LX4nCD6qgbfvXtTDuJNBL1N";
const IM_CLIENT_SECRET = process.env.INGRAM_CLIENT_SECRET ?? "5mBmQs5ZYqU6GzHL";
const IM_CUSTOMER_NUMBER = process.env.INGRAM_CUSTOMER_NUMBER ?? "14-730262";
const IM_COUNTRY_CODE = process.env.INGRAM_COUNTRY_CODE ?? "US";

const MAX_ROW_RETRIES = 30;
const PER_REQUEST_DELAY = 20;
const LOOP_DELAY = 500;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/* ============================================
   TOKEN CACHE
============================================ */
let cachedToken: { access_token: string; expires_at: number } | null = null;

async function getIngramToken() {
  const now = Date.now();

  if (cachedToken && cachedToken.expires_at > now + 5000) {
    return cachedToken;
  }

  const payload = qs.stringify({
    grant_type: "client_credentials",
    client_id: IM_CLIENT_ID,
    client_secret: IM_CLIENT_SECRET,
  });

  const res = await axios.post(
    "https://api.ingrammicro.com:443/oauth/oauth20/token",
    payload,
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 30000,
      validateStatus: () => true,
    }
  );

  if (!res.data?.access_token) {
    throw new Error("Failed to acquire Ingram token");
  }

  cachedToken = {
    access_token: res.data.access_token,
    expires_at: Date.now() + (res.data.expires_in ?? 3600) * 1000,
  };

  return cachedToken;
}

/* ============================================
   DETAILS API
============================================ */
async function callDetails(rawSku: string, token: string) {
  const url = `https://api.ingrammicro.com:443/resellers/v6/catalog/details/${encodeURIComponent(rawSku)}`;

  try {
    const res = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "IM-CustomerNumber": IM_CUSTOMER_NUMBER,
        "IM-CountryCode": IM_COUNTRY_CODE,
        "IM-CorrelationID": uuidv4(),
      },
      timeout: 30000,
      validateStatus: () => true,
    });

    return { status: res.status, data: res.data };
  } catch (err: any) {
    console.log(`🔥 HTTP ERROR for ${rawSku}: ${err.message}`);
    return { status: null, data: null };
  }
}

/* ============================================
   VALID CATEGORY CHECK
============================================ */
function isValidCategory(entry: any) {
  if (!entry) return false;
  if (!entry.productCategory) return false;
  if (entry.productCategory === "Unknown") return false;
  if (entry.productCategory === "NotFound") return false;
  return true;
}

/* ============================================
   PROCESS ONE SKU
============================================ */
async function processOne(row: any, db: any) {
  const permanentTable = db.collection("ingram_details_category");

  const sku = row.sku;
  const rawSku = row.raw_sku ?? row.sku;

  let attempt = 0;

  while (attempt < MAX_ROW_RETRIES) {
    attempt++;

    try {
      await delay(PER_REQUEST_DELAY);

      const tokenObj = await getIngramToken();
      const token = tokenObj.access_token;

      const { status, data } = await callDetails(rawSku, token);

      if (status === 404 || data?.message === "Record not found") {
        console.log(`❌ NOT FOUND: ${sku}`);

        await permanentTable.updateOne(
          { sku },
          {
            $set: {
              sku,
              raw_sku: rawSku,
              productCategory: "NotFound",
              productSubCategory: "NotFound",
              category: "NotFound",
              sub_category: "NotFound",
              updated_at: new Date(),
            },
          },
          { upsert: true }
        );
        return false;
      }

      if (status === 500 && data?.ingramPartNumber) {
        console.log(`⚠️ 500 WITH DATA: ${sku}`);
      }

      if (data?.ingramPartNumber) {
        const pc = data.productCategory?.trim() || "Unknown";
        const psc = data.productSubCategory?.trim() || "Unknown";

        await permanentTable.updateOne(
          { sku },
          {
            $set: {
              sku,
              raw_sku: rawSku,
              productCategory: pc,
              productSubCategory: psc,
              category: pc,
              sub_category: psc,
              description: data.description ?? null,
              vendor_name: data.vendorName ?? null,
              updated_at: new Date(),
            },
          },
          { upsert: true }
        );

        console.log(`✔ UPDATED: ${sku} → ${pc} / ${psc}`);
        return true;
      }

      console.log(`⚠️ INVALID RESPONSE: ${sku}`);
      return false;

    } catch (err: any) {
      console.log(`💥 ERROR for ${sku} (attempt ${attempt}): ${err.message}`);
      await delay(300 * attempt);
    }
  }

  return false;
}

/* ============================================
   MAIN LOOP — FILTER SKUs BEFORE PROCESSING
============================================ */
export async function enrichCategories() {
  const db = await getDb("master_list");

  const responseTable = db.collection("ingram_response_table");
  const permanentTable = db.collection("ingram_details_category");

  console.log("🚀 Starting Ingram category enrichment (filtered)…");

  // 1️⃣ Get SKUs already processed
  const permanentSKUs = await permanentTable.distinct("sku");

  // 2️⃣ Get SKUs that still need processing
  const cursor = responseTable.find({
    sku: { $nin: permanentSKUs }
  });

  const totalNeeded = await responseTable.countDocuments({
    sku: { $nin: permanentSKUs }
  });

  console.log(`📦 Total SKUs needing processing: ${totalNeeded}`);

  let processed = 0;

  while (await cursor.hasNext()) {
    const row = await cursor.next();
    if (!row) continue;

    const sku = row.sku;

    const remaining = totalNeeded - processed;
    const percent = ((processed / totalNeeded) * 100).toFixed(2);

    console.log(`📊 Remaining: ${remaining} | Processed: ${processed}/${totalNeeded} (${percent}%)`);
    console.log(`➡️ Processing SKU: ${sku}`);

    await processOne(row, db);

    // Delete only SKUs actually processed
    await responseTable.deleteOne({ sku });

    processed++;
    await delay(LOOP_DELAY);
  }

  console.log("🎉 ALL SKUs processed. DONE!");
  return true;
}

export default enrichCategories;

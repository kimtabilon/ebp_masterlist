import axios from "axios";
import { create } from "xmlbuilder2";
import pLimit from "p-limit";
import fs from "fs";
import path from "path";
import { parseStringPromise } from "xml2js";
import { getDb } from "../../config/mongdodb.config";

function cleanString(val: any): string {
  if (val === null || val === undefined) return "";
  return String(val).replace(/["']/g, "").replace(/\s+/g, " ").trim();
}

function isDropshipXml(xmlFragment: string): boolean {
  return /MFG Drop Shipped/i.test(xmlFragment) || /MGS Drop/i.test(xmlFragment) || /Drop Ship/i.test(xmlFragment);
}

function toNum(v: any): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function firstText(v: any): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return firstText(v[0]);
  if (typeof v === "object") return "";
  return cleanString(v);
}

function processPriceAvailabilityNode(nodeXmlRaw: string) {
  const nodeXml = nodeXmlRaw;

  const skuMatch = nodeXml.match(/<mfgPN>(.*?)<\/mfgPN>/i);
  const sku = skuMatch ? cleanString(skuMatch[1]) : "";

  const priceMatch = nodeXml.match(/<price>(.*?)<\/price>/i);
  const price = priceMatch ? Number(cleanString(priceMatch[1])) : null;

  const warehouseMatches = [...nodeXml.matchAll(/<AvailabilityByWarehouse>[\s\S]*?<\/AvailabilityByWarehouse>/gi)];
  let modifiedNodeXml = nodeXml;
  let totalQtyFromWarehouses = 0;

  for (const wm of warehouseMatches) {
    const whXml = wm[0];
    const whIsDropship = isDropshipXml(whXml);

    const qtyMatch = whXml.match(/<qty>(.*?)<\/qty>/i);
    const qty = qtyMatch ? Number(cleanString(qtyMatch[1])) : 0;

    const finalQty = whIsDropship ? 0 : qty;
    totalQtyFromWarehouses += finalQty;

    const whXmlEscaped = wm[0];
    let newWhXml: string;

    if (/<qty>[\s\S]*?<\/qty>/i.test(whXmlEscaped)) {
      newWhXml = whXmlEscaped.replace(/<qty>[\s\S]*?<\/qty>/i, `<qty>${finalQty}</qty>`);
    } else {
      newWhXml = whXmlEscaped.replace(/<\/AvailabilityByWarehouse>/i, `<qty>${finalQty}</qty></AvailabilityByWarehouse>`);
    }

    modifiedNodeXml = modifiedNodeXml.replace(whXmlEscaped, newWhXml);
  }

  if (/<totalQuantity>[\s\S]*?<\/totalQuantity>/i.test(modifiedNodeXml)) {
    modifiedNodeXml = modifiedNodeXml.replace(
      /<totalQuantity>[\s\S]*?<\/totalQuantity>/i,
      `<totalQuantity>${totalQtyFromWarehouses}</totalQuantity>`
    );
  } else if (/<price>[\s\S]*?<\/price>/i.test(modifiedNodeXml)) {
    modifiedNodeXml = modifiedNodeXml.replace(
      /(<price>[\s\S]*?<\/price>)/i,
      `$1\n  <totalQuantity>${totalQtyFromWarehouses}</totalQuantity>`
    );
  }

  return { sku, price, totalQty: totalQtyFromWarehouses, modifiedXml: modifiedNodeXml };
}

function formatParsedNode(n: any) {
  const whRaw = n?.AvailabilityByWarehouse;
  const warehouses = Array.isArray(whRaw) ? whRaw : whRaw ? [whRaw] : [];

  return {
    synnexSKU: firstText(n?.synnexSKU),
    mfgPN: firstText(n?.mfgPN),
    mfgCode: firstText(n?.mfgCode),
    status: firstText(n?.status),
    description: firstText(n?.description),
    GlobalProductStatusCode: firstText(n?.GlobalProductStatusCode),
    price: toNum(firstText(n?.price)),
    totalQuantity: toNum(firstText(n?.totalQuantity)) ?? 0,
    lineNumber: firstText(n?.lineNumber),
    AvailabilityByWarehouse: warehouses.map((w: any) => ({
      warehouseInfo: {
        number: firstText(w?.warehouseInfo?.number),
        zipcode: firstText(w?.warehouseInfo?.zipcode),
        city: firstText(w?.warehouseInfo?.city),
        addr: firstText(w?.warehouseInfo?.addr),
      },
      qty: toNum(firstText(w?.qty)) ?? 0,
    })),
  };
}

/**
 * Parse the full API response XML once and return a map of SKU → formatted nodes.
 * Replaces per-SKU parseStringPromise calls.
 */
async function parseFullResponse(modifiedXmlBySku: Record<string, string[]>): Promise<Record<string, any[]>> {
  const allXml = Object.values(modifiedXmlBySku).flat().join("\n");
  if (!allXml.trim()) return {};

  const wrapped = `<Root>${allXml}</Root>`;
  let parsed: any;
  try {
    parsed = await parseStringPromise(wrapped, {
      explicitArray: false,
      ignoreAttrs: false,
      trim: true,
      normalize: true,
      explicitRoot: false,
    });
  } catch {
    return {};
  }

  const listsRaw = parsed?.PriceAvailabilityList;
  const lists = Array.isArray(listsRaw) ? listsRaw : listsRaw ? [listsRaw] : [];

  const result: Record<string, any[]> = {};
  for (const n of lists) {
    const sku = cleanString(firstText(n?.mfgPN));
    if (!sku) continue;
    if (!result[sku]) result[sku] = [];
    result[sku].push(formatParsedNode(n));
  }
  return result;
}

export async function buildSynnexResponseTable() {
  const db = await getDb("master_list");

  await db.dropCollection("synnex_response_table").catch(() => { });
  await db.createCollection("synnex_response_table");
  const synnexTable = db.collection("synnex_response_table");

  await synnexTable.createIndex({ sku: 1 }, { unique: true }).catch(() => { });
  await synnexTable.createIndex({ synnex_status: 1 }).catch(() => { });
  await synnexTable.createIndex({ synnex_price: 1 }).catch(() => { });
  await synnexTable.createIndex({ synnex_quantity: 1 }).catch(() => { });

  const BUFFER_DIR = path.resolve("buffer");
  const BUFFER_FILE = path.join(BUFFER_DIR, "synnex_buffer.jsonl");
  fs.mkdirSync(BUFFER_DIR, { recursive: true });
  fs.writeFileSync(BUFFER_FILE, "");

  const BUFFER_LIMIT = 1000;
  let bufferCount = 0;
  let totalInserted = 0;

  async function flushBuffer() {
    try {
      const raw = fs.readFileSync(BUFFER_FILE, "utf8").trim();
      if (!raw) {
        bufferCount = 0;
        return;
      }

      const docs = raw.split("\n").map((l) => JSON.parse(l));

      await synnexTable.insertMany(docs, { ordered: false }).catch((err: any) => {
        if (err?.code !== 11000) throw err;
      });

      totalInserted += docs.length;
      bufferCount = 0;
      fs.writeFileSync(BUFFER_FILE, "");
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (!/E11000|duplicate key/i.test(msg)) console.log("flushBuffer error:", msg);
      bufferCount = 0;
      fs.writeFileSync(BUFFER_FILE, "");
    }
  }

  async function writeToBuffer(doc: any) {
    fs.appendFileSync(BUFFER_FILE, JSON.stringify(doc) + "\n");
    bufferCount++;
    if (bufferCount >= BUFFER_LIMIT) await flushBuffer();
  }

  const groupedCursor = db.collection("grouped_upc_data").find();

  const skuMeta: Record<
    string,
    { raw_sku: string; normalized_sku: string; upc: string; normalized_upc: string; manufacturer_map: string | null }
  > = {};

  let totalSkuCount = 0;

  while (await groupedCursor.hasNext()) {
    const g: any = await groupedCursor.next();

    const upc = cleanString(g.upc);
    const normalized_upc = cleanString(g.normalized_upc);

    const manufacturer_map = Array.isArray(g.manufacturer_map_list)
      ? cleanString(g.manufacturer_map_list.find((x: any) => x !== null) ?? "")
      : null;

    for (const dl of g.distributor_list || []) {
      if (!Array.isArray(dl.distributors)) continue;
      if (!dl.distributors.includes("synnex")) continue;

      const rawSku = cleanString(dl.raw_sku);
      const normalized_sku = cleanString(dl.normalized_sku);

      skuMeta[rawSku] = { raw_sku: rawSku, normalized_sku, upc, normalized_upc, manufacturer_map };
      totalSkuCount++;
    }
  }

  if (totalSkuCount === 0) return true;

  const allSkus = Object.keys(skuMeta).map(cleanString);
  const batchSize = parseInt(process.env.SYNNEX_BATCH_SIZE || "50", 10);
  const batches: string[][] = [];
  for (let i = 0; i < allSkus.length; i += batchSize) batches.push(allSkus.slice(i, i + batchSize));

  async function callSynnexAPI(batchSkus: string[]) {
    const xmlObj = {
      priceRequest: {
        customerNo: "617490",
        userName: "sales@ecommercebusinessprime.com",
        password: "EcomEBP@2025",
        skuList: batchSkus.map((s, idx) => ({ mfgPN: cleanString(s), lineNumber: idx + 1 })),
      },
    };

    const xml = create(xmlObj).end({ prettyPrint: true });
    const res = await axios.post("https://ec.us.tdsynnex.com/SynnexXML/PriceAvailability", xml, {
      headers: { "Content-Type": "application/xml" },
      timeout: 480000,
    });
    return res.data as string;
  }

  const limit = pLimit(10);
  let batchIndex = 0;
  const totalBatches = batches.length;
  const now = new Date();
  await Promise.all(
    batches.map((batch) =>
      limit(async () => {
        batchIndex++;
        const bn = batchIndex;

        let xmlData = "";
        try {
          xmlData = await callSynnexAPI(batch);
        } catch {
          for (const skuRaw of batch) {
            const sku = cleanString(skuRaw);
            const meta = skuMeta[sku];
            await writeToBuffer({
              sku,
              raw_sku: sku,
              normalized_sku: cleanString(meta?.normalized_sku),
              upc: cleanString(meta?.upc),
              normalized_upc: cleanString(meta?.normalized_upc),
              manufacturer_map: cleanString(meta?.manufacturer_map),
              distributor: "synnex",
              synnex_status: "error",
              synnex_price: null,
              synnex_quantity: 0,
              synnex_response: null,
              created_at: now,
              updated_at: now,
            });
          }
          // await flushBuffer();
          return;
        }

        const matches = [...xmlData.matchAll(/<PriceAvailabilityList>[\s\S]*?<\/PriceAvailabilityList>/gi)];
        const results: Record<string, { nodes: { price: number | null; qty: number; xml: string }[] }> = {};
        const parsedSkus = new Set<string>();

        for (const m of matches) {
          const processed = processPriceAvailabilityNode(m[0]);
          if (!processed.sku) continue;
          const sku = cleanString(processed.sku);
          parsedSkus.add(sku);
          if (!results[sku]) results[sku] = { nodes: [] };
          results[sku].nodes.push({ price: processed.price, qty: processed.totalQty, xml: processed.modifiedXml });
        }

        // Single XML parse for the entire batch instead of per-SKU
        const modifiedXmlBySku: Record<string, string[]> = {};
        for (const [sku, entry] of Object.entries(results)) {
          modifiedXmlBySku[sku] = entry.nodes.map((n) => n.xml);
        }
        const parsedResponses = await parseFullResponse(modifiedXmlBySku);

        for (const skuKey of Object.keys(results)) {
          const sku = cleanString(skuKey);
          const entry = results[sku];

          const valid = entry.nodes.filter((n) => n.price !== null);
          let lowestPrice: number | null = null;
          if (valid.length) lowestPrice = Math.min(...valid.map((x) => x.price as number));

          const totalQtyAcrossNodes = entry.nodes.reduce((acc, n) => acc + (n.qty || 0), 0);

          const meta = skuMeta[sku];

          await writeToBuffer({
            sku,
            raw_sku: sku,
            normalized_sku: cleanString(meta?.normalized_sku ?? sku),
            upc: cleanString(meta?.upc),
            normalized_upc: cleanString(meta?.normalized_upc),
            manufacturer_map: cleanString(meta?.manufacturer_map),
            distributor: "synnex",
            synnex_status: "ok",
            synnex_price: lowestPrice,
            synnex_quantity: totalQtyAcrossNodes,
            synnex_response: parsedResponses[sku] ?? null,
            created_at: now,
            updated_at: now,
          });
        }

        for (const skuRaw of batch) {
          const sku = cleanString(skuRaw);
          if (!parsedSkus.has(sku)) {
            const meta = skuMeta[sku];
            await writeToBuffer({
              sku,
              raw_sku: sku,
              normalized_sku: cleanString(meta?.normalized_sku),
              upc: cleanString(meta?.upc),
              normalized_upc: cleanString(meta?.normalized_upc),
              manufacturer_map: cleanString(meta?.manufacturer_map),
              distributor: "synnex",
              synnex_status: "missing",
              synnex_price: null,
              synnex_quantity: 0,
              synnex_response: null,
              created_at: now,
              updated_at: now,
            });
          }
        }

        // if (bn % 1 === 0) await flushBuffer();
      })
    )
  );

  // await flushBuffer();

  const retryDocs = await synnexTable
    .find({ synnex_status: { $in: ["missing", "error"] } }, { projection: { sku: 1 } })
    .toArray();

  const retrySkus = retryDocs.map((d: any) => cleanString(d.sku));
  if (retrySkus.length === 0) return true;

  const retryBatchSize = 20;
  const retryBatches: string[][] = [];
  for (let i = 0; i < retrySkus.length; i += retryBatchSize) retryBatches.push(retrySkus.slice(i, i + retryBatchSize));

  let retryIndex = 0;
  const retryLimit = pLimit(3);

  await Promise.all(
    retryBatches.map((rb) =>
      retryLimit(async () => {
        retryIndex++;

        let xmlData = "";
        try {
          xmlData = await callSynnexAPI(rb);
        } catch {
          await synnexTable.updateMany(
            { sku: { $in: rb.map(cleanString) } },
            { $set: { synnex_status: "missing_final", updated_at: now } }
          );
          return;
        }

        const matches = [...xmlData.matchAll(/<PriceAvailabilityList>[\s\S]*?<\/PriceAvailabilityList>/gi)];
        const results: Record<string, { nodes: { price: number | null; qty: number; xml: string }[] }> = {};
        const found = new Set<string>();

        for (const m of matches) {
          const processed = processPriceAvailabilityNode(m[0]);
          if (!processed.sku) continue;
          const sku = cleanString(processed.sku);
          found.add(sku);
          if (!results[sku]) results[sku] = { nodes: [] };
          results[sku].nodes.push({ price: processed.price, qty: processed.totalQty, xml: processed.modifiedXml });
        }

        for (const sku of Object.keys(results)) {
          const entry = results[sku];

          const valid = entry.nodes.filter((n) => n.price !== null);
          let lowestPrice: number | null = null;
          if (valid.length) lowestPrice = Math.min(...valid.map((v) => v.price as number));

          const totalQtyAcrossNodes = entry.nodes.reduce((acc, n) => acc + (n.qty || 0), 0);
          const combinedXml = entry.nodes.map((n) => n.xml).join("\n");

          let synnexResponse: any = null;
          try {
            synnexResponse = await synnexPriceAvailabilityListOnly(combinedXml);
          } catch {
            synnexResponse = null;
          }

          await synnexTable.updateOne(
            { sku: cleanString(sku) },
            {
              $set: {
                synnex_status: "ok",
                synnex_price: lowestPrice,
                synnex_quantity: totalQtyAcrossNodes,
                synnex_response: synnexResponse,
                updated_at: now,
              },
            }
          );
        }

        const rbClean = rb.map(cleanString);
        const notFound = rbClean.filter((s) => !found.has(s));
        if (notFound.length) {
          await synnexTable.updateMany(
            { sku: { $in: notFound } },
            { $set: { synnex_status: "missing_final", updated_at: now } }
          );
        }
      })
    )
  );

  // await flushBuffer();

  return true;
}
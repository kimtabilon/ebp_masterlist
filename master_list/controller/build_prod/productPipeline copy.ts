import axios from "axios";
import { getDb } from "../../config/mongdodb.config";
import { fixMissingCategoriesFast } from "../prod_category/missingcategoryUpdate";

const MIN_WAREHOUSE_QTY = 5;
const MIN_TOTAL_WAREHOUSE_QTY = 20;

function cleanString(val: any): string {
  if (val === null || val === undefined) return "";
  return String(val).replace(/["']/g, "").replace(/\s+/g, " ").trim();
}

function normalizeSku(sku: any): string {
  const cleaned = cleanString(sku);
  return cleaned.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

function detectCondition(name: any): "refurbished" | "new" {
  const s = cleanString(name).toLowerCase();
  if (!s) return "new";

  const refurbWords = [
    "refurb",
    "refurbished",
    "recondition",
    "renew",
    "renewed",
    "used",
    "pre-owned",
    "preowned",
    "grade a",
    "grade b",
    "grade c",
    "open box",
    "open-box",
    "remanufactured",
    "re-manufactured",
  ];

  return refurbWords.some((w) => s.includes(w)) ? "refurbished" : "new";
}

const UPLOADED_FILE_PATH = "/mnt/data/c7a4e68d-2369-4c02-a25b-2ef9cff7e7bc.png";

/* =========================================================
   NAME PICKING
========================================================= */

type NameMaps = {
  syn: Record<string, string>;
  dnh: Record<string, string>;
  ing: Record<string, string>;
  sup: Record<string, string>;
};

function pickNameForSku(
  normalizedSku: string,
  distributorList: any,
  maps: NameMaps
): { name: string | null; source: string | null } {
  const key = normalizeSku(normalizedSku);
  if (!key) return { name: null, source: null };

  const synName = cleanString(maps.syn[key]);
  if (synName) return { name: synName, source: "synnex" };

  const list: string[] = Array.isArray(distributorList)
    ? distributorList.map((x) => cleanString(x)).filter(Boolean)
    : [];

  const order = list.length ? list : ["dandh", "ingram", "supplies"];

  for (const rawDist of order) {
    const dist = rawDist.toLowerCase();

    if (dist === "synnex") continue;

    if (dist === "dandh") {
      const v = cleanString(maps.dnh[key]);
      if (v) return { name: v, source: "dandh" };
      continue;
    }

    if (dist === "ingram") {
      const v = cleanString(maps.ing[key]);
      if (v) return { name: v, source: "ingram" };
      continue;
    }

    if (dist === "supplies" || dist === "suppliesnetwork") {
      const v = cleanString(maps.sup[key]);
      if (v)
        return {
          name: v,
          source: dist === "suppliesnetwork" ? "suppliesNetwork" : "supplies",
        };
      continue;
    }
  }

  return { name: null, source: null };
}

/* =========================================================
   INVENTORY STATS (UPDATED TO MATCH YOUR NEW RESPONSE SHAPES)
========================================================= */

function toNum(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

type WhStats = { max: number; total: number };

/**
 * SYNNEX shape (unchanged):
 * synnex_response: Array<{
 *   totalQuantity: number|string
 *   AvailabilityByWarehouse: Array<{ qty: number|string }>
 * }>
 */
function synnexWarehouseStats(resp: any): WhStats {
  if (!Array.isArray(resp) || resp.length === 0) return { max: 0, total: 0 };

  let max = 0;
  let total = 0;

  for (const node of resp) {
    const whs = Array.isArray(node?.AvailabilityByWarehouse)
      ? node.AvailabilityByWarehouse
      : node?.AvailabilityByWarehouse
        ? [node.AvailabilityByWarehouse]
        : [];

    for (const w of whs) {
      const q = toNum(w?.qty);
      total += q;
      if (q > max) max = q;
    }

    // Sometimes totalQuantity is present; it should match sum, but we ignore it
    // to avoid double-counting. Sum of warehouse qty is the safest.
  }

  return { max, total };
}

/**
 * D&H NEW shape (your example):
 * dandh_response: {
 *   status: "ok" | ...,
 *   items: [
 *     {
 *       totalQty: number,
 *       branches: [{ qty: number, branch: string, inStockDate: string|null }]
 *     }
 *   ]
 * }
 */
function dandhWarehouseStats(resp: any): WhStats {
  const items = Array.isArray(resp?.items) ? resp.items : [];
  if (!items.length) return { max: 0, total: 0 };

  let max = 0;
  let total = 0;

  for (const item of items) {
    // Prefer branch breakdown
    const branches = Array.isArray(item?.branches) ? item.branches : [];
    if (branches.length) {
      for (const b of branches) {
        const q = toNum(b?.qty);
        total += q;
        if (q > max) max = q;
      }
      continue;
    }

    // Fallback: totalQty only
    const tq = toNum(item?.totalQty);
    total += tq;
    if (tq > max) max = tq;
  }

  return { max, total };
}

/**
 * Ingram NEW shape (your example):
 * ingram_response: {
 *   availability: {
 *     totalAvailability: number,
 *     availabilityByWarehouse: [{ quantityAvailable: number, ... }, ...]
 *   }
 * }
 *
 * NOTE:
 * - totalAvailability may include vendor warehouse amounts and may NOT equal
 *   sum(quantityAvailable) depending on Ingram rules.
 * - For eligibility you asked: MIN_WAREHOUSE_QTY per warehouse and MIN_TOTAL_WAREHOUSE_QTY total.
 *   We'll compute:
 *     max = max(quantityAvailable)
 *     total = totalAvailability (preferred) else sum(quantityAvailable)
 */
function ingramWarehouseStats(resp: any): WhStats {
  const av = resp?.availability;
  if (!av || typeof av !== "object") return { max: 0, total: 0 };

  const arr = Array.isArray(av?.availabilityByWarehouse) ? av.availabilityByWarehouse : [];
  let max = 0;
  let sum = 0;

  for (const w of arr) {
    const q = toNum(w?.quantityAvailable);
    sum += q;
    if (q > max) max = q;
  }

  const totalAvailability = toNum(av?.totalAvailability);
  const total = totalAvailability > 0 ? totalAvailability : sum;

  return { max, total };
}

/**
 * Supplies NEW shape (your example):
 * supplies_response: {
 *   qqh_stl: number,
 *   qqh_dal: number,
 *   qqh_car: number,
 *   qqh_frn: number
 * }
 */
function suppliesWarehouseStats(resp: any): WhStats {
  if (!resp || typeof resp !== "object") return { max: 0, total: 0 };

  let max = 0;
  let total = 0;

  for (const v of Object.values(resp)) {
    const q = toNum(v);
    total += q;
    if (q > max) max = q;
  }

  return { max, total };
}

function warehouseStatsByDist(dist: string, doc: any): WhStats {
  switch (dist) {
    case "synnex":
      return synnexWarehouseStats(doc?.synnex_response);

    case "dandh":
      return dandhWarehouseStats(doc?.dandh_response);

    case "ingram":
      return ingramWarehouseStats(doc?.ingram_response);

    case "suppliesNetwork":
    case "supplies":
      return suppliesWarehouseStats(doc?.supplies_response);

    case "almo":
      return { max: 0, total: 0 };

    default:
      return { max: 0, total: 0 };
  }
}

function isEligibleInventory(dist: string, doc: any): boolean {
  const { max, total } = warehouseStatsByDist(dist, doc);
  return max >= MIN_WAREHOUSE_QTY && total >= MIN_TOTAL_WAREHOUSE_QTY;
}

/**
 * Updated "hasAnyDataForDist" to reflect the new wrapper shapes:
 * - dandh_response.status === "ok" and has items
 * - ingram_response.availability exists (or ingram_status ok if you store it)
 * - supplies_response is object
 * - synnex_response is array
 */
function hasAnyDataForDist(dist: string, doc: any): boolean {
  switch (dist) {
    case "synnex":
      return Array.isArray(doc?.synnex_response) && doc.synnex_response.length > 0;

    case "dandh": {
      const r = doc?.dandh_response;
      const items = Array.isArray(r?.items) ? r.items : [];
      // treat status "ok" + items present as "has data"
      if (r?.status) return cleanString(r.status).toLowerCase() === "ok" && items.length > 0;
      return items.length > 0;
    }

    case "ingram": {
      const r = doc?.ingram_response;
      const hasAvailability = !!r?.availability && typeof r.availability === "object";
      if (r?.productStatusCode) return true; // still has a record
      return hasAvailability;
    }

    case "suppliesNetwork":
    case "supplies":
      return doc?.supplies_response !== null && doc?.supplies_response !== undefined;

    case "almo":
      return false;

    default:
      return false;
  }
}

/* =========================================================
   MAIN BUILD
========================================================= */

export async function buildProductList() {
  const db = await getDb("master_list");
  await db.dropCollection("product_list").catch(() => {});
  await db.createCollection("product_list");

  const productList = db.collection("product_list");
  await productList.createIndex({ normalized_sku: 1 });
  await productList.createIndex({ sku: 1 });

  const responseTables = [
    { name: "synnex_response_table", dist: "synnex" },
    { name: "dandh_response_table", dist: "dandh" },
    { name: "ingram_response_table", dist: "ingram" },
    { name: "supplies_response_table", dist: "supplies" },
  ];

  const merged: Record<string, any> = {};

  for (const t of responseTables) {
    const cursor = db.collection(t.name).find();

    while (await cursor.hasNext()) {
      const row: any = await cursor.next();

      const rawSku = cleanString(row.sku ?? row.raw_sku ?? "");
      const normalized = row.normalized_sku ?? normalizeSku(rawSku);
      if (!normalized) continue;

      if (!merged[normalized]) {
        merged[normalized] = {
          sku: rawSku,
          normalized_sku: normalized,

          upc: cleanString(row.upc ?? null),
          normalized_upc: cleanString(row.normalized_upc ?? null),

          manufacturer_map: cleanString(row.manufacturer_map ?? null),

          synnex_response: null,
          synnex_price: null,
          synnex_quantity: null,

          dandh_response: null,
          dandh_price: null,
          dandh_quantity: null,

          ingram_response: null,
          ingram_price: null,
          ingram_quantity: null,

          supplies_response: null,
          supplies_price: null,
          supplies_count: null,

          distributor_list: [],

          category_class: null,
          category_class_l2: null,
          category_class_l3: null,

          condition: "new",
          name: null,
          name_source: null,

          uploaded_file_url: UPLOADED_FILE_PATH,
          created_at: new Date(),
          updated_at: new Date(),
        };
      }

      const rec = merged[normalized];

      switch (t.dist) {
        case "synnex":
          rec.synnex_response = Array.isArray(row?.synnex_response) ? row.synnex_response : null;
          rec.synnex_price = row.synnex_price ?? row.price ?? null;
          rec.synnex_quantity = row.synnex_quantity ?? row.quantity ?? null;
          if (!rec.distributor_list.includes("synnex")) rec.distributor_list.push("synnex");
          break;

        case "dandh":
          // NEW: dandh_response already wrapped {status, items:[...]}
          rec.dandh_response = row.dandh_response ?? row.response ?? null;
          rec.dandh_price = row.dandh_price ?? row.price ?? null;
          rec.dandh_quantity = row.dandh_quantity ?? row.quantity ?? null;
          if (!rec.distributor_list.includes("dandh")) rec.distributor_list.push("dandh");
          break;

        case "ingram":
          // NEW: ingram_response already includes availability object
          rec.ingram_response = row.ingram_response ?? row.response ?? null;
          rec.ingram_price = row.ingram_price ?? row.price ?? null;
          rec.ingram_quantity = row.ingram_quantity ?? row.quantity ?? null;
          if (!rec.distributor_list.includes("ingram")) rec.distributor_list.push("ingram");
          break;

        case "supplies":
          // NEW: supplies_response is object {qqh_*: number}
          rec.supplies_response = row.supplies_response ?? row.response ?? null;
          rec.supplies_price = row.supplies_price ?? row.price ?? null;
          rec.supplies_count = row.supplies_count ?? row.count ?? null;
          if (!rec.distributor_list.includes("supplies")) rec.distributor_list.push("supplies");
          break;
      }
    }
  }

  // Categories from raw sources (keep your existing logic)
  const rawSynnex = db.collection("dist_synnex_raw");
  const rawDandh = db.collection("dist_dandh_raw");

  const keys = Object.keys(merged);
  const BATCH = 5000;

  for (let i = 0; i < keys.length; i += BATCH) {
    const batchKeys = keys.slice(i, i + BATCH);

    const synMap: any = {};
    const synCur = rawSynnex.find({ normalized_sku: { $in: batchKeys } });
    while (await synCur.hasNext()) {
      const r: any = await synCur.next();
      synMap[r.normalized_sku] = {
        c1: cleanString(r.category_class),
        c2: cleanString(r.category_class_l2),
        c3: cleanString(r.category_class_l3),
      };
    }

    const dandhMap: any = {};
    const dCur = rawDandh.find({ normalized_sku: { $in: batchKeys } });
    while (await dCur.hasNext()) {
      const r: any = await dCur.next();
      dandhMap[r.normalized_sku] = {
        c1: cleanString(r.category_class),
        c2: cleanString(r.category_class_l2),
        c3: cleanString(r.category_class_l3),
      };
    }

    for (const key of batchKeys) {
      const entry = merged[key];
      if (synMap[key]) {
        entry.category_class = synMap[key].c1;
        entry.category_class_l2 = synMap[key].c2;
        entry.category_class_l3 = synMap[key].c3;
      } else if (dandhMap[key]) {
        entry.category_class = dandhMap[key].c1;
        entry.category_class_l2 = dandhMap[key].c2;
        entry.category_class_l3 = dandhMap[key].c3;
      }
    }
  }

  // Name maps from raw sources (keep your existing logic)
  const rawIngram = db.collection("dist_ingram_raw");
  const rawSupplies = db.collection("dist_supplies_raw");

  const synNames: Record<string, string> = {};
  const dNames: Record<string, string> = {};
  const iNames: Record<string, string> = {};
  const sNames: Record<string, string> = {};

  {
    const cur = rawSynnex.find({}, { projection: { normalized_sku: 1, sku: 1, name: 1 } });
    while (await cur.hasNext()) {
      const r: any = await cur.next();
      const k = normalizeSku(r.normalized_sku ?? r.sku);
      if (k) synNames[k] = cleanString(r.name);
    }
  }
  {
    const cur = rawDandh.find({}, { projection: { normalized_sku: 1, sku: 1, name: 1 } });
    while (await cur.hasNext()) {
      const r: any = await cur.next();
      const k = normalizeSku(r.normalized_sku ?? r.sku);
      if (k) dNames[k] = cleanString(r.name);
    }
  }
  {
    const cur = rawIngram.find({}, { projection: { normalized_sku: 1, sku: 1, name: 1 } });
    while (await cur.hasNext()) {
      const r: any = await cur.next();
      const k = normalizeSku(r.normalized_sku ?? r.sku);
      if (k) iNames[k] = cleanString(r.name);
    }
  }
  {
    const cur = rawSupplies.find({}, { projection: { normalized_sku: 1, sku: 1, name: 1 } });
    while (await cur.hasNext()) {
      const r: any = await cur.next();
      const k = normalizeSku(r.normalized_sku ?? r.sku);
      if (k) sNames[k] = cleanString(r.name);
    }
  }

  const maps: NameMaps = { syn: synNames, dnh: dNames, ing: iNames, sup: sNames };

  for (const rawKey of Object.keys(merged)) {
    const key = normalizeSku(rawKey);

    const nameForCond = synNames[key] || dNames[key] || iNames[key] || sNames[key];
    merged[rawKey].condition = detectCondition(nameForCond);

    const { name, source } = pickNameForSku(key, merged[rawKey].distributor_list, maps);
    merged[rawKey].name = name;
    merged[rawKey].name_source = source;
  }

  // UPC / SKU duplicate cleanup (keep your existing logic)
  const upcMap: Record<string, Set<string>> = {};
  const skuMap: Record<string, Set<string>> = {};
  const remove = new Set<string>();

  for (const key of Object.keys(merged)) {
    let upc = cleanString(merged[key].upc);
    upc = upc.replace(/\D/g, "");
    if (!upc) {
      merged[key].upc = null;
      remove.add(key);
      continue;
    }

    merged[key].upc = upc;

    if (!upcMap[upc]) upcMap[upc] = new Set();
    upcMap[upc].add(key);

    if (!skuMap[key]) skuMap[key] = new Set();
    skuMap[key].add(upc);
  }

  for (const key of Object.keys(skuMap)) if (skuMap[key].size > 1) remove.add(key);
  for (const upc of Object.keys(upcMap))
    if (upcMap[upc].size > 1) for (const sku of upcMap[upc]) remove.add(sku);
  for (const key of remove) delete merged[key];

  const allDocs = Object.values(merged);

  const BATCH_INSERT = 10000;
  let inserted = 0;

  for (let i = 0; i < allDocs.length; i += BATCH_INSERT) {
    const chunk = allDocs.slice(i, i + BATCH_INSERT);

    for (const doc of chunk) {
      doc.sku = cleanString(doc.sku);
      doc.normalized_sku = normalizeSku(doc.sku);

      doc.upc = cleanString(doc.upc);
      doc.normalized_upc = cleanString(doc.normalized_upc);

      doc.category_class = cleanString(doc.category_class);
      doc.category_class_l2 = cleanString(doc.category_class_l2);
      doc.category_class_l3 = cleanString(doc.category_class_l3);

      doc.manufacturer_map = cleanString(doc.manufacturer_map);
      doc.name = doc.name ? cleanString(doc.name) : null;
      doc.name_source = doc.name_source ? cleanString(doc.name_source) : null;

      doc.updated_at = new Date();
    }

    await productList.insertMany(chunk, { ordered: false }).catch(() => {});
    inserted += chunk.length;
  }

  const { updated: customUp } = await applyCustomCategoriesFromDB();

  const { updated: fixed } = await fixMissingCategoriesFastv2();
  await fixMissingCategoriesFast();

  const { updated: prio } = await updatePriority();

  return { inserted, total: allDocs.length, customUp, fixed, prio };
}

/* =========================================================
   CUSTOM CATEGORY APPLY
========================================================= */

export async function applyCustomCategoriesFromDB(): Promise<{ updated: number }> {
  const db = await getDb("master_list");
  const customCol = db.collection("custom_category");
  const productList = db.collection("product_list");

  const customList = await customCol.find({}).toArray();
  if (!customList || customList.length === 0) return { updated: 0 };

  let updated = 0;
  const ops: any[] = [];

  for (const item of customList) {
    const sku = normalizeSku(item.sku);
    if (!sku) continue;

    const set: any = {};

    if (item.category_class !== undefined) set.category_class = cleanString(item.category_class);
    if (item.category_class_l2 !== undefined) set.category_class_l2 = cleanString(item.category_class_l2);
    if (item.category_class_l3 !== undefined) set.category_class_l3 = cleanString(item.category_class_l3);

    if (Object.keys(set).length === 0) continue;

    ops.push({ updateOne: { filter: { normalized_sku: sku }, update: { $set: set } } });
    updated++;
  }

  if (ops.length > 0) await productList.bulkWrite(ops, { ordered: false });
  return { updated };
}

/* =========================================================
   FIX MISSING CATEGORIES (UNCHANGED)
========================================================= */

export async function fixMissingCategoriesFastv2(): Promise<{ updated: number }> {
  const db = await getDb("master_list");
  const productList = db.collection("product_list");
  const synnexRaw = db.collection("dist_synnex_raw");
  const dandhRaw = db.collection("dist_dandh_raw");
  const ingramRaw = db.collection("dist_ingram_raw");
  const suppliesRaw = db.collection("dist_supplies_raw");

  const missing = await productList
    .find({ category_class: null }, { projection: { sku: 1, normalized_sku: 1 } })
    .toArray();

  const synMap = new Map<string, any>();
  const ingTypeMap = new Map<string, Set<string>>();
  const dandhCatMap = new Map<string, Set<string>>();
  const suppliesCatMap = new Map<string, Set<string>>();
  const metaMap = new Map<string, any>();
  const productCat = new Map<string, any>();

  const synC = synnexRaw.find({});
  while (await synC.hasNext()) {
    const r: any = await synC.next();
    const key = normalizeSku(r.normalized_sku ?? r.sku);
    if (!key) continue;
    synMap.set(key, {
      c1: cleanString(r.category_class ?? null),
      c2: cleanString(r.category_class_l2 ?? null),
      c3: cleanString(r.category_class_l3 ?? null),
    });
  }

  const ingC = ingramRaw.find({});
  while (await ingC.hasNext()) {
    const r: any = await ingC.next();
    const key = normalizeSku(r.normalized_sku ?? r.sku);
    if (!key) continue;

    const m = { manufacturer: cleanString(r.manufacturer ?? ""), type: cleanString(r.type ?? "") };
    metaMap.set(key, m);

    if (m.manufacturer && m.type) {
      const id = `${m.manufacturer}|${m.type}`;
      if (!ingTypeMap.has(id)) ingTypeMap.set(id, new Set());
      ingTypeMap.get(id)!.add(key);
    }
  }

  const dC = dandhRaw.find({});
  while (await dC.hasNext()) {
    const r: any = await dC.next();
    const key = normalizeSku(r.normalized_sku ?? r.sku);
    if (!key) continue;

    const m = { manufacturer: cleanString(r.manufacturer ?? ""), cat: cleanString(r.category_class ?? null) };
    metaMap.set(key, m);

    if (m.manufacturer && m.cat) {
      const id = `${m.manufacturer}|${m.cat}`;
      if (!dandhCatMap.has(id)) dandhCatMap.set(id, new Set());
      dandhCatMap.get(id)!.add(key);
    }
  }

  const sC = suppliesRaw.find({});
  while (await sC.hasNext()) {
    const r: any = await sC.next();
    const key = normalizeSku(r.normalized_sku ?? r.sku);
    if (!key) continue;

    const m = { manufacturer: cleanString(r.manufacturer ?? ""), cat: cleanString(r.category_class ?? null) };
    metaMap.set(key, m);

    if (m.manufacturer && m.cat) {
      const id = `${m.manufacturer}|${m.cat}`;
      if (!suppliesCatMap.has(id)) suppliesCatMap.set(id, new Set());
      suppliesCatMap.get(id)!.add(key);
    }
  }

  const pcur = productList.find({ category_class: { $ne: null } });
  while (await pcur.hasNext()) {
    const r: any = await pcur.next();
    const key = normalizeSku(r.normalized_sku);
    productCat.set(key, { c1: r.category_class, c2: r.category_class_l2, c3: r.category_class_l3 });
  }

  let updated = 0;
  let ops: any[] = [];

  for (const item of missing) {
    const key = normalizeSku(item.normalized_sku ?? item.sku);
    if (!key) continue;

    let cat: any = null;

    if (synMap.has(key)) {
      cat = synMap.get(key);
    } else {
      const m = metaMap.get(key);

      if (m?.manufacturer && m?.type) {
        const id = `${m.manufacturer}|${m.type}`;
        const group = ingTypeMap.get(id);
        if (group) for (const g of group) if (productCat.has(g)) cat = productCat.get(g);
      }

      if (!cat && m?.manufacturer && m?.cat) {
        const id = `${m.manufacturer}|${m.cat}`;
        const group = dandhCatMap.get(id);
        if (group) for (const g of group) if (productCat.has(g)) cat = productCat.get(g);
      }

      if (!cat && m?.manufacturer && m?.cat) {
        const id = `${m.manufacturer}|${m.cat}`;
        const group = suppliesCatMap.get(id);
        if (group) for (const g of group) if (productCat.has(g)) cat = productCat.get(g);
      }
    }

    if (cat) {
      ops.push({ updateOne: { filter: { normalized_sku: key }, update: { $set: cat } } });
      updated++;
    }

    if (ops.length >= 1000) {
      await productList.bulkWrite(ops, { ordered: false });
      ops = [];
    }
  }

  if (ops.length) await productList.bulkWrite(ops, { ordered: false });
  return { updated };
}

/* =========================================================
   PRIORITY UPDATE (USES UPDATED STATS)
========================================================= */

async function getMWStockingInventory(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  let page = 1;

  while (true) {
    const url = `https://m.dev.ecommercebusinessprime.com/api/v1/stockingInventory?page=${page}&pageSize=200`;
    const res = await axios.get(url, { timeout: 8000 });
    const rows = res?.data?.data ?? [];
    if (rows.length === 0) break;

    for (const row of rows) {
      const sku = normalizeSku(row.sku);
      const mw = Number(row.mw_inventory ?? 0);
      map.set(sku, Number.isFinite(mw) ? mw : 0);
    }

    const totalPages = res?.data?.pagination?.totalPages ?? 1;
    if (page >= totalPages) break;
    page++;
  }

  return map;
}

export async function updatePriority(): Promise<{ updated: number }> {
  const db = await getDb("master_list");
  const productList = db.collection("product_list");

  const mwStockingMap = await getMWStockingInventory();

  const cursor = productList.find(
    {},
    {
      projection: {
        normalized_sku: 1,
        category_class: 1,
        category_class_l2: 1,
        synnex_response: 1,
        dandh_response: 1,
        ingram_response: 1,
        supplies_response: 1,
      },
    }
  );

  let ops: any[] = [];
  let updated = 0;

  while (await cursor.hasNext()) {
    const doc: any = await cursor.next();
    const sku = normalizeSku(doc.normalized_sku);

    const mwInv = mwStockingMap.get(sku) ?? 0;
    if (mwInv > 0) {
      ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { priority: "stocking" } } } });
      updated++;
      if (ops.length >= 1000) {
        await productList.bulkWrite(ops, { ordered: false });
        ops = [];
      }
      continue;
    }

    const c1 = cleanString(doc.category_class);
    const c2 = cleanString(doc.category_class_l2);

    let rules: string[];
    if (c1 === "Printers" && c2 === "Printer Consumables") {
      rules = ["suppliesNetwork", "synnex", "dandh", "ingram"];
    } else if (
      c1 === "Commercial Display" ||
      c2 === "Large Format Displays" ||
      c2 === "LCD Display" ||
      c2 === "Plasma/LCD/CRT TV"
    ) {
      rules = ["almo", "dandh", "synnex", "ingram"];
    } else {
      rules = ["synnex", "dandh", "suppliesNetwork", "ingram"];
    }

    let chosen: string | undefined;

    // 1) Prefer eligible inventory by per-warehouse + total rules
    for (const dist of rules) {
      if (isEligibleInventory(dist, doc)) {
        chosen = dist;
        break;
      }
    }

    // 2) If none eligible, pick first one that at least has data
    if (!chosen) {
      for (const dist of rules) {
        if (hasAnyDataForDist(dist, doc)) {
          chosen = dist;
          break;
        }
      }
    }

    if (!chosen) chosen = rules[0];

    ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { priority: chosen } } } });
    updated++;

    if (ops.length >= 1000) {
      await productList.bulkWrite(ops, { ordered: false });
      ops = [];
    }
  }

  if (ops.length) await productList.bulkWrite(ops, { ordered: false });

  return { updated };
}
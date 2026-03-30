import fs from "fs";
import path from "path";
import { getDb } from "../../config/mongdodb.config";
// -------------------------------- CONFIG --------------------------------
const BATCH_WRITE = 600;                    // slightly higher for fewer writes
const LOG_FILE = path.join(process.cwd(), "logs", "fastko.log");

// -------------------------------- HELPERS --------------------------------
const nowIso = () => new Date().toISOString();

function normalizeSkuStrict(s: any): string {
  if (!s) return "";
  return String(s)
    .trim()
    .replace(/[\u2010-\u2015\u2212\u2043\uFE58]/g, "-");
}

function normalizeSkuForCompare(v: any): string {
  if (!v) return "";
  return String(v)
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[^A-Za-z0-9]/g, "")
    .trim()
    .toUpperCase();
}

function cleanString(v: any): string {
  return v ? String(v).replace(/\s+/g, " ").trim() : "";
}

// Lightweight single-file logger
let LOG_BUFFER: string[] = [];
function log(line: string) {
  LOG_BUFFER.push(`[${nowIso()}] ${line}`);
  if (LOG_BUFFER.length > 20000) flushLogSync(); // prevent RAM growth
}
function flushLogSync() {
  const data = LOG_BUFFER.join("\n") + "\n";
  LOG_BUFFER = [];
  fs.appendFileSync(LOG_FILE, data);
}

// --------------------------- MAIN LOGIC ------------------------------
export async function fixMissingCategoriesFastko() {
  const db = await getDb("master_list");

  const productList = db.collection("product_list");
  const ingramRaw = db.collection("dist_ingram_raw");
  const dandhRaw = db.collection("dist_dandh_raw");
  const suppliesRaw = db.collection("dist_supplies_raw");
  const synnexRaw = db.collection("dist_synnex_raw");

  // ---------------- LOAD MISSING SKUs ----------------
  const missingDocs = await productList
    .find({ $or: [{ category_class: null }, { category_class: "" }] }, { projection: { sku: 1 } })
    .toArray();

  const missing = missingDocs.map((r: any) => {
    const strict = normalizeSkuStrict(r.sku);
    const cmp = normalizeSkuForCompare(strict);
    return { raw: r.sku, strict, cmp };
  }).filter((m: any) => m.strict);

  // ---------------- LOAD product_list CATEGORY MAP ----------------
  const productCategoryMap = new Map();

  const plCursor = productList.find(
    { category_class: { $exists: true, $ne: null } },
    { projection: { sku: 1, normalized_sku: 1, category_class: 1, category_class_l2: 1, category_class_l3: 1 } }
  );

  await plCursor.forEach((r: any) => {
    const base = r.normalized_sku || r.sku;
    const cmp = normalizeSkuForCompare(base);
    if (!cmp) return;
    productCategoryMap.set(cmp, {
      c1: r.category_class,
      c2: r.category_class_l2,
      c3: r.category_class_l3,
    });
  });

  // ---------------- FAST DISTRIBUTOR LOADER -------------------
  async function loadDist(collection: any, extract: (r: any) => any, proj: any) {
    const skuMap = new Map();
    const groupMap = new Map();

    const cursor = collection.find({}, { projection: proj });

    await cursor.forEach((r: any) => {
      const strict = normalizeSkuStrict(r.sku);
      if (!strict) return;

      if (!skuMap.has(strict)) skuMap.set(strict, r);

      const { man, type } = extract(r);
      const m = cleanString(man);
      if (!m) return;

      const types = Array.isArray(type) ? type : type ? [type] : [];

      for (const t of types) {
        const tc = cleanString(t);
        if (!tc) continue;

        const key = `${m}|${tc}`;
        const arr = groupMap.get(key) || [];
        arr.push(normalizeSkuForCompare(strict));
        groupMap.set(key, arr);
      }

      // also push manufacturer-only key
      const arr2 = groupMap.get(m) || [];
      arr2.push(normalizeSkuForCompare(strict));
      groupMap.set(m, arr2);
    });

    return { skuMap, groupMap };
  }

  const [ingram, dandh, supplies, synnex] = await Promise.all([
    loadDist(ingramRaw, (r) => ({ man: r.manufacturer, type: r.type }), { sku: 1, manufacturer: 1, type: 1 }),
    loadDist(dandhRaw, (r) => ({ man: r.manufacturer, type: r.category_class ?? r.category_class_l2 ?? r.category_class_l3 }),
      { sku: 1, manufacturer: 1, category_class: 1, category_class_l2: 1, category_class_l3: 1 }),
    loadDist(suppliesRaw, (r) => ({ man: r.manufacturer, type: [r.category_class, r.type] }),
      { sku: 1, manufacturer: 1, category_class: 1, type: 1 }),
    loadDist(synnexRaw, (r) => ({ man: r.manufacturer, type: r.category_class ?? r.category_class_l2 ?? r.category_class_l3 }),
      { sku: 1, manufacturer: 1, category_class: 1, category_class_l2: 1, category_class_l3: 1 }),
  ]);

  // ---------------- CATEGORY FINDER ----------------
  function categoryFromGroup(groupSkus: string[]) {
    for (const s of groupSkus) {
      const c = productCategoryMap.get(s);
      if (c) return c;
    }
    return null;
  }

  async function tryDist(dist: any, strict: string, cmp: string, extractKeys: (r: any) => string[]) {
    const rec = dist.skuMap.get(strict);
    if (!rec) return null;

    const keys = extractKeys(rec);

    for (const k of keys) {
      const arr = dist.groupMap.get(k);
      if (!arr) continue;

      const found = categoryFromGroup(arr);
      if (found) return found;
    }
    return null;
  }

  // ---------------- MAIN LOOP ----------------
  let updated = 0;
  const bulkOps = [];

  for (const m of missing) {
    const { raw, strict, cmp } = m;

    // direct hit
    const direct = productCategoryMap.get(cmp);
    if (direct) {
      bulkOps.push({
        updateOne: {
          filter: { sku: raw },
          update: { $set: { category_class: direct.c1, category_class_l2: direct.c2, category_class_l3: direct.c3 } },
        },
      });
      log(`${strict} DIRECT`);
      updated++;
    } else {
      const cat =
        (await tryDist(ingram, strict, cmp, (r) => {
          const man = cleanString(r.manufacturer);
          const t = cleanString(r.type);
          return man && t ? [`${man}|${t}`, man] : man ? [man] : [];
        })) ||
        (await tryDist(dandh, strict, cmp, (r) => {
          const man = cleanString(r.manufacturer);
          const t = cleanString(r.category_class ?? r.category_class_l2 ?? r.category_class_l3);
          return man && t ? [`${man}|${t}`, man] : man ? [man] : [];
        })) ||
        (await tryDist(supplies, strict, cmp, (r) => {
          const man = cleanString(r.manufacturer);
          return [
            r.category_class ? `${man}|${cleanString(r.category_class)}` : null,
            r.type ? `${man}|${cleanString(r.type)}` : null,
          ].filter(Boolean) as string[];
        })) ||
        (await tryDist(synnex, strict, cmp, (r) => {
          const man = cleanString(r.manufacturer);
          const t = cleanString(r.category_class ?? r.category_class_l2 ?? r.category_class_l3);
          return man && t ? [`${man}|${t}`, man] : man ? [man] : [];
        }));

      if (cat) {
        bulkOps.push({
          updateOne: {
            filter: { sku: raw },
            update: { $set: { category_class: cat.c1, category_class_l2: cat.c2, category_class_l3: cat.c3 } },
          },
        });
        updated++;
        log(`${strict} DIST`);
      } else {
        log(`${strict} NO_MATCH`);
      }
    }

    if (bulkOps.length >= BATCH_WRITE) {
      await productList.bulkWrite(bulkOps, { ordered: false });
      bulkOps.length = 0;
    }
  }

  if (bulkOps.length) await productList.bulkWrite(bulkOps, { ordered: false });

  // Flush one combined log
  flushLogSync();

  return { updated, processed: missing.length };
}

/**
 * Layer 1: Unit tests for pure functions.
 * No database, no network, no setup required.
 *
 * Usage: npx tsx --test tests/unit.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { cleanString, normalizeSku, normalizeUpc, normalizeManufacturer } from "../master_list/utils/normalize.js";

// ============================================================
// normalizeSku
// ============================================================
describe("normalizeSku", () => {
  it("strips non-alphanumeric and uppercases", () => {
    assert.equal(normalizeSku("ABC-123"), "ABC123");
    assert.equal(normalizeSku("abc-123"), "ABC123");
    assert.equal(normalizeSku("MIX-ed_CaSe!@#"), "MIXEDCASE");
  });

  it("handles whitespace", () => {
    assert.equal(normalizeSku(" ABC 123 "), "ABC123");
    assert.equal(normalizeSku("   leading-trailing   "), "LEADINGTRAILING");
  });

  it("handles null/undefined/empty", () => {
    assert.equal(normalizeSku(null), "");
    assert.equal(normalizeSku(undefined), "");
    assert.equal(normalizeSku(""), "");
    assert.equal(normalizeSku("  "), "");
  });

  it("handles numeric input", () => {
    assert.equal(normalizeSku(0), "0");
    assert.equal(normalizeSku(12345), "12345");
  });

  it("strips quotes", () => {
    assert.equal(normalizeSku("'quoted-sku'"), "QUOTEDSKU");
    assert.equal(normalizeSku('"double-quoted"'), "DOUBLEQUOTED");
  });
});

// ============================================================
// normalizeUpc
// ============================================================
describe("normalizeUpc", () => {
  it("strips non-digits and leading zeros", () => {
    assert.equal(normalizeUpc("00012345"), "12345");
    assert.equal(normalizeUpc("012345678901"), "12345678901");
    assert.equal(normalizeUpc("0012345"), "12345");
  });

  it("returns null for all-zero or empty", () => {
    assert.equal(normalizeUpc("0000000"), null);
    assert.equal(normalizeUpc("0"), null);
    assert.equal(normalizeUpc("000"), null);
    assert.equal(normalizeUpc(""), null);
  });

  it("handles null/undefined", () => {
    assert.equal(normalizeUpc(null), null);
    assert.equal(normalizeUpc(undefined), null);
  });

  it("strips non-digits", () => {
    assert.equal(normalizeUpc("abc123"), "123");
    assert.equal(normalizeUpc("  00123  "), "123");
    assert.equal(normalizeUpc("'00456'"), "456");
  });

  it("handles numeric input", () => {
    assert.equal(normalizeUpc(123), "123");
    assert.equal(normalizeUpc(0), null);
  });

  it("preserves valid UPC without leading zeros", () => {
    assert.equal(normalizeUpc("846127012345"), "846127012345");
    assert.equal(normalizeUpc("12345"), "12345");
  });
});

// ============================================================
// normalizeManufacturer
// ============================================================
describe("normalizeManufacturer", () => {
  it("lowercases and strips punctuation", () => {
    assert.equal(normalizeManufacturer("Hewlett-Packard"), "hewlettpackard");
    assert.equal(normalizeManufacturer("HEWLETT-PACKARD"), "hewlettpackard");
    assert.equal(normalizeManufacturer("HP Inc."), "hp inc");
  });

  it("collapses whitespace", () => {
    assert.equal(normalizeManufacturer("  Samsung  "), "samsung");
    assert.equal(normalizeManufacturer("hewlett  packard"), "hewlett packard");
  });

  it("handles null/undefined/empty", () => {
    assert.equal(normalizeManufacturer(""), "");
    assert.equal(normalizeManufacturer(null as any), "");
    assert.equal(normalizeManufacturer(undefined as any), "");
  });

  it("strips quotes and apostrophes", () => {
    assert.equal(normalizeManufacturer("Dell's"), "dells");
    assert.equal(normalizeManufacturer("L.G. Electronics"), "lg electronics");
  });
});

// ============================================================
// cleanString
// ============================================================
describe("cleanString", () => {
  it("strips quotes and trims", () => {
    assert.equal(cleanString("'hello'"), "hello");
    assert.equal(cleanString('"world"'), "world");
    assert.equal(cleanString("  spaced  "), "spaced");
  });

  it("collapses whitespace", () => {
    assert.equal(cleanString("  multiple   spaces  "), "multiple spaces");
  });

  it("handles null/undefined", () => {
    assert.equal(cleanString(null), "");
    assert.equal(cleanString(undefined), "");
  });

  it("converts non-strings", () => {
    assert.equal(cleanString(0), "0");
    assert.equal(cleanString(123), "123");
  });
});

// ============================================================
// Import productPipeline helpers — need to test these too
// ============================================================
// These are defined in productPipeline.ts but not exported.
// We'll test the behavior through the streaming build's output
// rather than importing directly. For now, test the logic inline.

describe("detectCondition (logic test)", () => {
  // Reproducing the logic from productPipeline.ts
  const refurbWords = [
    "refurb", "refurbished", "recondition", "renew", "renewed",
    "used", "pre-owned", "preowned", "grade a", "grade b", "grade c",
    "open box", "open-box", "remanufactured", "re-manufactured",
  ];

  function detectCondition(name: any): "refurbished" | "new" {
    const s = cleanString(name).toLowerCase();
    if (!s) return "new";
    return refurbWords.some((w) => s.includes(w)) ? "refurbished" : "new";
  }

  it("detects refurbished keywords", () => {
    assert.equal(detectCondition("HP LaserJet Refurbished"), "refurbished");
    assert.equal(detectCondition("Dell Monitor - Open Box"), "refurbished");
    assert.equal(detectCondition("Renewed Laptop"), "refurbished");
    assert.equal(detectCondition("Grade A Desktop"), "refurbished");
    assert.equal(detectCondition("Pre-Owned Printer"), "refurbished");
    assert.equal(detectCondition("Remanufactured Toner"), "refurbished");
  });

  it("returns new for normal products", () => {
    assert.equal(detectCondition("HP LaserJet Pro M404n"), "new");
    assert.equal(detectCondition("Dell UltraSharp Monitor"), "new");
    assert.equal(detectCondition("Epson WorkForce Printer"), "new");
  });

  it("handles null/empty", () => {
    assert.equal(detectCondition(null), "new");
    assert.equal(detectCondition(""), "new");
    assert.equal(detectCondition(undefined), "new");
  });
});

describe("getQty (logic test)", () => {
  // Reproducing the fixed logic from sku_packed.ts
  function toNum(v: any) {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
  }

  function getQty(doc: any, d: string): number {
    const raw = doc?.[`${d}_quantity`];
    if (raw != null) return toNum(raw);
    return toNum(doc?.[`${d}_count`]);
  }

  it("returns quantity when present", () => {
    assert.equal(getQty({ synnex_quantity: 42 }, "synnex"), 42);
    assert.equal(getQty({ dandh_quantity: 0 }, "dandh"), 0);
  });

  it("zero is not treated as missing (falsy-zero fix)", () => {
    assert.equal(getQty({ synnex_quantity: 0, synnex_count: 99 }, "synnex"), 0);
  });

  it("falls back to count when quantity is null/undefined", () => {
    assert.equal(getQty({ synnex_count: 50 }, "synnex"), 50);
    assert.equal(getQty({ synnex_quantity: null, synnex_count: 25 }, "synnex"), 25);
    assert.equal(getQty({ synnex_quantity: undefined, synnex_count: 10 }, "synnex"), 10);
  });

  it("returns 0 when both are missing", () => {
    assert.equal(getQty({}, "synnex"), 0);
    assert.equal(getQty(null, "synnex"), 0);
  });
});

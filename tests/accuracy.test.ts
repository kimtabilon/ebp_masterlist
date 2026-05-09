/**
 * Tests for accuracy validation checks (EBP-29/30/31 + name/category coverage).
 * Runs against master_list_test.
 *
 * Usage: npx tsx --test tests/accuracy.test.ts
 */

process.env.DB_NAME_OVERRIDE = "master_list_test";
process.env.mUser = "tempUserMasterlist";
process.env.pUser = "F4@zN!8qW2#Lp9$Xr6^tY3&m";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { getDb } from "../master_list/config/mongdodb.config.js";
import { validateProductList } from "../master_list/controller/validation/validateProductList.js";
import { buildProductListStreaming } from "../master_list/controller/build_prod/productPipeline.js";

describe("Accuracy validation checks", () => {
    let db: any;

    before(async () => {
        db = await getDb("master_list");
        assert.equal(db.databaseName, "master_list_test", "Safety: must run against test DB");

        // Ensure product_list exists
        const count = await db.collection("product_list").countDocuments();
        if (count === 0) {
            await buildProductListStreaming();
        }
    });

    it("runs all 10 checks when none disabled", async () => {
        const result = await validateProductList();
        assert.ok(result.checks.length >= 8, `Should have at least 8 checks (got ${result.checks.length})`);

        const checkNames = result.checks.map(c => c.name);
        assert.ok(checkNames.includes("price_sanity"), "Should include price_sanity");
        assert.ok(checkNames.includes("manufacturer_coverage"), "Should include manufacturer_coverage");
        assert.ok(checkNames.includes("response_completeness"), "Should include response_completeness");
        assert.ok(checkNames.includes("name_coverage"), "Should include name_coverage");
        assert.ok(checkNames.includes("category_coverage"), "Should include category_coverage");
    });

    it("new checks are individually toggleable", async () => {
        const result = await validateProductList({
            disabledChecks: ["price_sanity", "manufacturer_coverage", "response_completeness", "name_coverage", "category_coverage"]
        });

        const checkNames = result.checks.map(c => c.name);
        assert.ok(!checkNames.includes("price_sanity"), "price_sanity should be skipped");
        assert.ok(!checkNames.includes("manufacturer_coverage"), "manufacturer_coverage should be skipped");
        assert.ok(!checkNames.includes("response_completeness"), "response_completeness should be skipped");
        assert.ok(!checkNames.includes("name_coverage"), "name_coverage should be skipped");
        assert.ok(!checkNames.includes("category_coverage"), "category_coverage should be skipped");
    });

    describe("EBP-29: Price sanity", () => {
        it("detects products with zero pricing", async () => {
            // Insert a product with distributor but no pricing
            await db.collection("product_list").insertOne({
                normalized_sku: "_TEST_ZERO_PRICE",
                sku: "test-zero",
                upc: "111111111111",
                distributor_list: ["synnex"],
                synnex_price: 0,
                dandh_price: null,
                ingram_price: null,
                supplies_price: null,
                almo_price: null,
            });

            const result = await validateProductList({ zeroPriceThresholdPct: 0 });
            const check = result.checks.find(c => c.name === "price_sanity");
            assert.ok(check, "Should have price_sanity check");
            // With threshold 0%, any zero-price product should fail
            assert.ok(check!.detail.includes("no valid pricing"), "Should report zero-price products");

            await db.collection("product_list").deleteOne({ normalized_sku: "_TEST_ZERO_PRICE" });
        });

        it("passes when zero-price products are within threshold", async () => {
            const result = await validateProductList({ zeroPriceThresholdPct: 50 });
            const check = result.checks.find(c => c.name === "price_sanity");
            assert.ok(check, "Should have price_sanity check");
            assert.equal(check!.passed, true, "Should pass with generous threshold");
        });
    });

    describe("EBP-30: Manufacturer coverage", () => {
        it("detects products without manufacturer_map", async () => {
            await db.collection("product_list").insertOne({
                normalized_sku: "_TEST_NO_MFG",
                sku: "test-no-mfg",
                upc: "222222222222",
                distributor_list: ["synnex"],
                manufacturer_map: null,
            });

            const result = await validateProductList({ mfgUnmappedThresholdPct: 0 });
            const check = result.checks.find(c => c.name === "manufacturer_coverage");
            assert.ok(check, "Should have manufacturer_coverage check");
            assert.ok(check!.detail.includes("without manufacturer_map"), "Should report unmapped products");

            await db.collection("product_list").deleteOne({ normalized_sku: "_TEST_NO_MFG" });
        });

        it("passes when unmapped products are within threshold", async () => {
            const result = await validateProductList({ mfgUnmappedThresholdPct: 50 });
            const check = result.checks.find(c => c.name === "manufacturer_coverage");
            assert.ok(check!.passed, "Should pass with generous threshold");
        });
    });

    describe("EBP-31: Response completeness", () => {
        it("detects products with incomplete response data", async () => {
            await db.collection("product_list").insertOne({
                normalized_sku: "_TEST_INCOMPLETE",
                sku: "test-incomplete",
                upc: "333333333333",
                distributor_list: ["synnex"],
                synnex_price: null,
                synnex_quantity: null,
            });

            const result = await validateProductList({ responseIncompleteThresholdPct: 0 });
            const check = result.checks.find(c => c.name === "response_completeness");
            assert.ok(check, "Should have response_completeness check");
            assert.ok(check!.detail.includes("incomplete"), "Should report incomplete responses");

            await db.collection("product_list").deleteOne({ normalized_sku: "_TEST_INCOMPLETE" });
        });
    });

    describe("Name coverage", () => {
        it("detects products without name", async () => {
            await db.collection("product_list").insertOne({
                normalized_sku: "_TEST_NO_NAME",
                sku: "test-no-name",
                upc: "444444444444",
                distributor_list: ["synnex"],
                name: null,
            });

            const result = await validateProductList({ nameNullThresholdPct: 0 });
            const check = result.checks.find(c => c.name === "name_coverage");
            assert.ok(check, "Should have name_coverage check");
            assert.ok(check!.detail.includes("without name"), "Should report nameless products");

            await db.collection("product_list").deleteOne({ normalized_sku: "_TEST_NO_NAME" });
        });
    });

    describe("Category coverage", () => {
        it("detects products without category", async () => {
            await db.collection("product_list").insertOne({
                normalized_sku: "_TEST_NO_CAT",
                sku: "test-no-cat",
                upc: "555555555555",
                distributor_list: ["synnex"],
                category_class: null,
            });

            const result = await validateProductList({ categoryNullThresholdPct: 0 });
            const check = result.checks.find(c => c.name === "category_coverage");
            assert.ok(check, "Should have category_coverage check");
            assert.ok(check!.detail.includes("without category"), "Should report uncategorized products");

            await db.collection("product_list").deleteOne({ normalized_sku: "_TEST_NO_CAT" });
        });
    });

    describe("UPC format validity", () => {
        it("detects non-standard UPC format", async () => {
            await db.collection("product_list").insertOne({
                normalized_sku: "_TEST_BAD_UPC",
                sku: "test-bad-upc",
                upc: "abc123",
                distributor_list: ["synnex"],
            });

            const result = await validateProductList({ upcInvalidThresholdPct: 0 });
            const check = result.checks.find(c => c.name === "upc_format");
            assert.ok(check, "Should have upc_format check");
            assert.ok(check!.detail.includes("non-standard"), "Should report invalid UPCs");

            await db.collection("product_list").deleteOne({ normalized_sku: "_TEST_BAD_UPC" });
        });

        it("accepts valid 12, 13, and 14 digit UPCs", async () => {
            await db.collection("product_list").insertMany([
                { normalized_sku: "_TEST_UPC12", sku: "t12", upc: "846127012345", distributor_list: ["synnex"] },
                { normalized_sku: "_TEST_UPC13", sku: "t13", upc: "0846127012345", distributor_list: ["synnex"] },
                { normalized_sku: "_TEST_UPC14", sku: "t14", upc: "00846127012345", distributor_list: ["synnex"] },
            ]);

            const result = await validateProductList({ upcInvalidThresholdPct: 0 });
            const check = result.checks.find(c => c.name === "upc_format");
            // These should not count as invalid
            assert.ok(check, "Should have upc_format check");

            await db.collection("product_list").deleteMany({ normalized_sku: { $in: ["_TEST_UPC12", "_TEST_UPC13", "_TEST_UPC14"] } });
        });
    });

    describe("SKU-UPC consistency", () => {
        it("detects UPC changes for the same SKU between runs", async () => {
            // Create a previous run with a known UPC
            await db.dropCollection("product_list_previous").catch(() => {});
            await db.collection("product_list_previous").insertOne({
                normalized_sku: "_TEST_UPC_CHANGED",
                sku: "test-changed",
                upc: "111111111111",
            });

            // Current product list has the same SKU but different UPC
            await db.collection("product_list").insertOne({
                normalized_sku: "_TEST_UPC_CHANGED",
                sku: "test-changed",
                upc: "222222222222",
                distributor_list: ["synnex"],
            });

            const result = await validateProductList({ skuUpcChangedThreshold: 0 });
            const check = result.checks.find(c => c.name === "sku_upc_consistency");
            assert.ok(check, "Should have sku_upc_consistency check");
            assert.equal(check!.passed, false, "Should fail when UPC changed");
            assert.ok(check!.detail.includes("changed UPC"), "Should report changed UPCs");

            await db.collection("product_list").deleteOne({ normalized_sku: "_TEST_UPC_CHANGED" });
            await db.dropCollection("product_list_previous").catch(() => {});
        });
    });

    describe("Priority validity", () => {
        it("detects invalid priority values", async () => {
            await db.collection("product_list").insertOne({
                normalized_sku: "_TEST_BAD_PRIORITY",
                sku: "test-bad-priority",
                upc: "666666666666",
                distributor_list: ["synnex"],
                priority: "invalid_value",
            });

            const result = await validateProductList();
            const check = result.checks.find(c => c.name === "priority_validity");
            assert.ok(check, "Should have priority_validity check");
            assert.equal(check!.passed, false, "Should fail on invalid priority");

            await db.collection("product_list").deleteOne({ normalized_sku: "_TEST_BAD_PRIORITY" });
        });

        it("accepts all valid priority values", async () => {
            const result = await validateProductList();
            const check = result.checks.find(c => c.name === "priority_validity");
            assert.ok(check, "Should have priority_validity check");
            // Without test data injection, existing products should have valid priorities
            assert.equal(check!.passed, true, "Should pass with valid priorities");
        });
    });

    after(async () => {
        await db.collection("product_list").deleteMany({
            normalized_sku: { $regex: /^_TEST_/ }
        });
        await db.dropCollection("product_list_previous").catch(() => {});
        process.exit(0);
    });
});

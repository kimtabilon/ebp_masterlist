/**
 * Tests for distributor disagreement report (EBP-32).
 * Runs against master_list_test.
 *
 * Usage: npx tsx --test tests/disagreements.test.ts
 */

process.env.DB_NAME_OVERRIDE = "master_list_test";
process.env.mUser = "tempUserMasterlist";
process.env.pUser = "F4@zN!8qW2#Lp9$Xr6^tY3&m";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { getDb } from "../master_list/config/mongdodb.config.js";
import { analyzeDistributorDisagreements } from "../master_list/controller/validation/distributorDisagreements.js";

describe("Distributor Disagreement Report", () => {
    let db: any;

    before(async () => {
        db = await getDb("master_list");
        assert.equal(db.databaseName, "master_list_test", "Safety: must run against test DB");
    });

    it("returns structured result with counts and samples", async () => {
        const result = await analyzeDistributorDisagreements();

        assert.ok(typeof result.priceDisagreements.count === "number");
        assert.ok(Array.isArray(result.priceDisagreements.samples));
        assert.ok(typeof result.inventoryDisagreements.count === "number");
        assert.ok(Array.isArray(result.inventoryDisagreements.samples));
        assert.ok(typeof result.summary === "string");
    });

    it("detects price disagreements", async () => {
        // Insert product with conflicting prices
        await db.collection("product_list").insertOne({
            normalized_sku: "_TEST_PRICE_DISAGREE",
            sku: "test-disagree",
            upc: "999999999999",
            distributor_list: ["synnex", "ingram"],
            synnex_price: 10,
            ingram_price: 100, // 900% difference
            dandh_price: null,
            supplies_price: null,
            almo_price: null,
        });

        const result = await analyzeDistributorDisagreements({ priceThresholdPct: 50, maxSamples: 10000 });
        assert.ok(result.priceDisagreements.count > 0, "Should detect price disagreement");

        const sample = result.priceDisagreements.samples.find(s => s.sku === "_TEST_PRICE_DISAGREE");
        assert.ok(sample, "Should include test product in samples");
        assert.equal(sample!.prices.synnex, 10);
        assert.equal(sample!.prices.ingram, 100);

        await db.collection("product_list").deleteOne({ normalized_sku: "_TEST_PRICE_DISAGREE" });
    });

    it("does not flag products within threshold", async () => {
        await db.collection("product_list").insertOne({
            normalized_sku: "_TEST_PRICE_OK",
            sku: "test-ok",
            upc: "888888888888",
            distributor_list: ["synnex", "ingram"],
            synnex_price: 100,
            ingram_price: 110, // 10% difference — within 50% threshold
            dandh_price: null,
            supplies_price: null,
            almo_price: null,
        });

        const result = await analyzeDistributorDisagreements({ priceThresholdPct: 50 });
        const sample = result.priceDisagreements.samples.find(s => s.sku === "_TEST_PRICE_OK");
        assert.equal(sample, undefined, "Should NOT flag products within threshold");

        await db.collection("product_list").deleteOne({ normalized_sku: "_TEST_PRICE_OK" });
    });

    it("detects inventory disagreements (stock vs zero)", async () => {
        await db.collection("product_list").insertOne({
            normalized_sku: "_TEST_INV_DISAGREE",
            sku: "test-inv",
            upc: "777777777777",
            distributor_list: ["synnex", "ingram"],
            synnex_quantity: 50,
            ingram_quantity: 0,
            dandh_quantity: null,
            supplies_count: null,
            almo_quantity: null,
        });

        const result = await analyzeDistributorDisagreements({ maxSamples: 100000 });
        assert.ok(result.inventoryDisagreements.count > 0, "Should detect inventory disagreement");

        const sample = result.inventoryDisagreements.samples.find(s => s.sku === "_TEST_INV_DISAGREE");
        assert.ok(sample, "Should include test product in samples");

        await db.collection("product_list").deleteOne({ normalized_sku: "_TEST_INV_DISAGREE" });
    });

    it("respects maxSamples limit", async () => {
        const result = await analyzeDistributorDisagreements({ maxSamples: 3 });
        assert.ok(result.priceDisagreements.samples.length <= 3, "Should respect maxSamples for price");
        assert.ok(result.inventoryDisagreements.samples.length <= 3, "Should respect maxSamples for inventory");
    });

    it("configurable price threshold", async () => {
        // Very low threshold should catch more disagreements
        const lowThreshold = await analyzeDistributorDisagreements({ priceThresholdPct: 5 });
        // Very high threshold should catch fewer
        const highThreshold = await analyzeDistributorDisagreements({ priceThresholdPct: 500 });

        assert.ok(
            lowThreshold.priceDisagreements.count >= highThreshold.priceDisagreements.count,
            "Lower threshold should catch more or equal disagreements"
        );
    });

    after(async () => {
        await db.collection("product_list").deleteMany({
            normalized_sku: { $regex: /^_TEST_/ }
        });
        process.exit(0);
    });
});

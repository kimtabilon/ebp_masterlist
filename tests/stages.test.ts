/**
 * EBP-25: Per-stage integration tests against fixture data.
 * EBP-26: Failure injection tests.
 *
 * Tests each testable pipeline stage independently, plus failure scenarios.
 * Runs against master_list_test.
 *
 * Usage: npx tsx --test tests/stages.test.ts
 */

process.env.DB_NAME_OVERRIDE = "master_list_test";
process.env.mUser = "tempUserMasterlist";
process.env.pUser = "F4@zN!8qW2#Lp9$Xr6^tY3&m";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { getDb } from "../master_list/config/mongdodb.config.js";
import { buildProductListStreaming } from "../master_list/controller/build_prod/productPipeline.js";
import { cleanupDuplicates } from "../master_list/controller/build_prod/duplicateCleanup.js";
import { validateProductList } from "../master_list/controller/validation/validateProductList.js";
import { diffProductList } from "../master_list/controller/validation/diffProductList.js";
import { PipelineRunCollector } from "../master_list/controller/validation/pipelineRunLog.js";
import { sendPipelineAlert } from "../master_list/controller/validation/alerting.js";

describe("EBP-25: Per-stage integration tests", () => {
  let db: any;

  before(async () => {
    db = await getDb("master_list");
    assert.equal(db.databaseName, "master_list_test", "Safety: must run against test DB");
  });

  describe("Stage: Build product list (streaming)", () => {
    it("produces products from response table data", async () => {
      const result = await buildProductListStreaming();

      assert.ok(result.inserted > 0, `Should insert products (got ${result.inserted})`);
      assert.ok(result.total > 0, `Should process groups (got ${result.total})`);
    });

    it("product docs have required fields", async () => {
      const requiredFields = [
        "sku", "normalized_sku", "upc", "distributor_list",
        "condition", "created_at", "updated_at"
      ];

      const sample = await db.collection("product_list").findOne();
      assert.ok(sample, "Should have at least one product");

      for (const field of requiredFields) {
        assert.ok(field in sample, `Product should have field: ${field}`);
      }
    });

    it("distributor_list is a non-empty array for each product", async () => {
      const emptyDist = await db.collection("product_list").countDocuments({
        $or: [
          { distributor_list: { $exists: false } },
          { distributor_list: { $size: 0 } },
        ]
      });
      assert.equal(emptyDist, 0, `No products should have empty distributor_list (found ${emptyDist})`);
    });

    it("normalized_sku is unique", async () => {
      const dupes = await db.collection("product_list").aggregate([
        { $group: { _id: "$normalized_sku", count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
        { $count: "total" }
      ]).toArray();

      const dupCount = dupes[0]?.total ?? 0;
      assert.equal(dupCount, 0, `No duplicate normalized_sku (found ${dupCount})`);
    });

    it("condition is either 'new' or 'refurbished'", async () => {
      const invalidCondition = await db.collection("product_list").countDocuments({
        condition: { $nin: ["new", "refurbished"] }
      });
      assert.equal(invalidCondition, 0, `All conditions should be new or refurbished (found ${invalidCondition} invalid)`);
    });

    it("priority is set for all products", async () => {
      const nullPriority = await db.collection("product_list").countDocuments({
        priority: null
      });
      assert.equal(nullPriority, 0, `All products should have priority set (found ${nullPriority} null)`);
    });
  });

  describe("Stage: Duplicate cleanup", () => {
    it("removes products with null/empty UPC", async () => {
      // Insert a test product with null UPC
      await db.collection("product_list").insertOne({
        normalized_sku: "_TEST_NULL_UPC",
        sku: "test",
        upc: null,
        distributor_list: ["synnex"],
      });

      const result = await cleanupDuplicates();

      const testDoc = await db.collection("product_list").findOne({ normalized_sku: "_TEST_NULL_UPC" });
      assert.equal(testDoc, null, "Product with null UPC should be removed");
    });

    it("removes all products when UPC maps to multiple SKUs", async () => {
      // Insert two products with the same UPC but different SKUs
      await db.collection("product_list").insertMany([
        { normalized_sku: "_TEST_DUP_UPC_A", sku: "test-a", upc: "999999999999", distributor_list: ["synnex"] },
        { normalized_sku: "_TEST_DUP_UPC_B", sku: "test-b", upc: "999999999999", distributor_list: ["dandh"] },
      ]);

      await cleanupDuplicates();

      const remaining = await db.collection("product_list").countDocuments({
        upc: "999999999999"
      });
      assert.equal(remaining, 0, "Both products with conflicting UPC should be removed");
    });
  });

  describe("Stage: Validation", () => {
    it("returns 5 checks when all enabled", async () => {
      // Need a previous list for count check
      const docs = await db.collection("product_list").find({}, { projection: { _id: 0 } }).limit(100).toArray();
      await db.dropCollection("product_list_previous").catch(() => {});
      if (docs.length > 0) {
        await db.collection("product_list_previous").insertMany(docs);
      }

      const result = await validateProductList();
      assert.equal(result.checks.length, 5, `Should have 5 checks (got ${result.checks.length})`);

      const checkNames = result.checks.map(c => c.name).sort();
      assert.deepEqual(checkNames, [
        "distributor_coverage",
        "distributor_minimums",
        "duplicate_sku",
        "inventory_plausibility",
        "product_count",
      ]);

      await db.dropCollection("product_list_previous").catch(() => {});
    });

    it("each check has name, passed, and detail", async () => {
      const result = await validateProductList();
      for (const check of result.checks) {
        assert.ok(typeof check.name === "string", "Check should have name");
        assert.ok(typeof check.passed === "boolean", "Check should have passed boolean");
        assert.ok(typeof check.detail === "string", "Check should have detail string");
      }
    });
  });

  describe("Stage: Diff", () => {
    it("returns all required fields", async () => {
      const diff = await diffProductList();

      assert.ok(typeof diff.added === "number", "Should have added");
      assert.ok(typeof diff.removed === "number", "Should have removed");
      assert.ok(typeof diff.priceChanges === "number", "Should have priceChanges");
      assert.ok(typeof diff.inventorySwings === "number", "Should have inventorySwings");
      assert.ok(typeof diff.distributorChanges === "number", "Should have distributorChanges");
      assert.ok(diff.details, "Should have details object");
      assert.ok(Array.isArray(diff.details.addedSkus), "Should have addedSkus array");
      assert.ok(Array.isArray(diff.details.removedSkus), "Should have removedSkus array");
    });
  });

  describe("Stage: Audit log", () => {
    it("record has complete schema", async () => {
      await db.dropCollection("pipeline_runs").catch(() => {});

      const collector = new PipelineRunCollector();
      collector.addStage({ name: "stage1", durationSec: 5.2, heapDeltaMb: 12.5 });
      collector.addStage({ name: "stage2", durationSec: 3.1, heapDeltaMb: -2.0 });

      await collector.persist({
        status: "success",
        validation: await validateProductList(),
        diff: await diffProductList(),
      });

      const record = await db.collection("pipeline_runs").findOne();
      assert.ok(record, "Should have a record");

      // Verify schema
      assert.ok(record.startedAt instanceof Date, "startedAt should be Date");
      assert.ok(record.completedAt instanceof Date, "completedAt should be Date");
      assert.ok(typeof record.durationSec === "number", "durationSec should be number");
      assert.equal(record.status, "success");
      assert.equal(record.stages.length, 2);
      assert.equal(record.stages[0].name, "stage1");
      assert.equal(record.stages[0].durationSec, 5.2);
      assert.ok(record.validation, "Should have validation");
      assert.ok(record.diff, "Should have diff");
      assert.equal(record.error, null);

      await db.dropCollection("pipeline_runs").catch(() => {});
    });
  });

  after(async () => {
    await db.dropCollection("product_list_previous").catch(() => {});
    await db.dropCollection("pipeline_runs").catch(() => {});
  });
});

describe("EBP-26: Failure injection tests", () => {
  let db: any;

  before(async () => {
    db = await getDb("master_list");
    assert.equal(db.databaseName, "master_list_test", "Safety: must run against test DB");

    // Ensure we have a product list to work with
    await buildProductListStreaming();
  });

  describe("Validation failure: missing distributor data", () => {
    it("catches products with mismatched distributor_list vs response", async () => {
      // Insert a product claiming synnex but with null response
      await db.collection("product_list").insertOne({
        normalized_sku: "_TEST_MISSING_RESP",
        sku: "test-missing",
        upc: "888888888888",
        distributor_list: ["synnex", "dandh"],
        synnex_response: null,
        dandh_response: null,
      });

      const result = await validateProductList();
      const coverageCheck = result.checks.find(c => c.name === "distributor_coverage");
      assert.ok(coverageCheck, "Should have distributor_coverage check");
      // The check uses a percentage threshold so one product won't fail it,
      // but the detail should mention the gap count
      assert.ok(coverageCheck!.detail.includes("coverage gaps"), "Should report coverage gaps");

      // Cleanup
      await db.collection("product_list").deleteOne({ normalized_sku: "_TEST_MISSING_RESP" });
    });
  });

  describe("Validation failure: product count drop", () => {
    it("fails when count drops more than threshold", async () => {
      const currentCount = await db.collection("product_list").countDocuments();

      // Create a previous list that's much larger
      await db.dropCollection("product_list_previous").catch(() => {});
      const fakePrevious = Array.from({ length: Math.ceil(currentCount * 1.5) }, (_, i) => ({
        normalized_sku: `FAKE_PREV_${i}`,
        sku: `fake-${i}`,
        upc: `${i}`,
      }));
      await db.collection("product_list_previous").insertMany(fakePrevious);

      const result = await validateProductList();
      const countCheck = result.checks.find(c => c.name === "product_count");
      assert.ok(countCheck, "Should have product_count check");
      assert.equal(countCheck!.passed, false, `Count check should fail (current ${currentCount} vs previous ${fakePrevious.length})`);
      assert.equal(result.passed, false, "Overall validation should fail");

      await db.dropCollection("product_list_previous").catch(() => {});
    });
  });

  describe("Validation failure: duplicate SKUs", () => {
    it("catches duplicate normalized_sku entries", async () => {
      // Drop unique index temporarily and insert a duplicate
      await db.collection("product_list").dropIndex("normalized_sku_1").catch(() => {});
      await db.collection("product_list").insertOne({
        normalized_sku: (await db.collection("product_list").findOne())?.normalized_sku || "TEST",
        sku: "duplicate-test",
        upc: "777777777777",
        distributor_list: ["synnex"],
      });

      const result = await validateProductList();
      const dupCheck = result.checks.find(c => c.name === "duplicate_sku");
      assert.ok(dupCheck, "Should have duplicate_sku check");
      assert.equal(dupCheck!.passed, false, "Duplicate check should fail");

      // Cleanup — remove the duplicate and restore index
      await db.collection("product_list").deleteOne({ sku: "duplicate-test" });
      await db.collection("product_list").createIndex({ normalized_sku: 1 }, { unique: true }).catch(() => {});
    });
  });

  describe("Validation failure: negative inventory", () => {
    it("catches negative inventory values", async () => {
      await db.collection("product_list").insertOne({
        normalized_sku: "_TEST_NEG_INV",
        sku: "neg-inv",
        upc: "666666666666",
        distributor_list: ["synnex"],
        synnex_quantity: -5,
      });

      const result = await validateProductList();
      const invCheck = result.checks.find(c => c.name === "inventory_plausibility");
      assert.ok(invCheck, "Should have inventory_plausibility check");
      assert.equal(invCheck!.passed, false, "Inventory check should fail on negative value");

      await db.collection("product_list").deleteOne({ normalized_sku: "_TEST_NEG_INV" });
    });
  });

  describe("Failure produces audit log entry", () => {
    it("rolled_back status persisted with error details", async () => {
      await db.dropCollection("pipeline_runs").catch(() => {});

      // Create a scenario that fails validation
      await db.dropCollection("product_list_previous").catch(() => {});
      const bigPrev = Array.from({ length: 99999 }, (_, i) => ({
        normalized_sku: `AUDIT_PREV_${i}`, sku: `a-${i}`, upc: `${i}`,
      }));
      await db.collection("product_list_previous").insertMany(bigPrev);

      const collector = new PipelineRunCollector();
      const validation = await validateProductList();
      assert.equal(validation.passed, false, "Should fail for this test");

      await collector.persist({
        status: "rolled_back",
        validation,
        error: "Injected failure for testing",
      });

      const record = await db.collection("pipeline_runs").findOne({ status: "rolled_back" });
      assert.ok(record, "Should have rolled_back record");
      assert.equal(record.error, "Injected failure for testing");
      assert.equal(record.validation.passed, false);

      await db.dropCollection("product_list_previous").catch(() => {});
      await db.dropCollection("pipeline_runs").catch(() => {});
    });
  });

  describe("Alert fires on failure", () => {
    it("sendPipelineAlert does not throw", async () => {
      // No webhook configured — should log to console without error
      await assert.doesNotReject(async () => {
        await sendPipelineAlert({
          type: "validation_failed",
          validation: { passed: false, checks: [{ name: "test", passed: false, detail: "injected failure" }] },
          error: "Test alert",
        });
      });
    });
  });

  after(async () => {
    await db.dropCollection("product_list_previous").catch(() => {});
    await db.dropCollection("pipeline_runs").catch(() => {});
    process.exit(0);
  });
});

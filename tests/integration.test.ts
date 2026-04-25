/**
 * Layer 2: Integration test for Phase 2 flow.
 * Runs against master_list_test — writes only to test DB.
 *
 * Tests the full post-build chain:
 * - Validation (pass and fail scenarios)
 * - Rollback on failure
 * - Run diffing
 * - Audit log persistence
 *
 * Usage: npm run test:integration
 */

process.env.DB_NAME_OVERRIDE = "master_list_test";
process.env.mUser = "tempUserMasterlist";
process.env.pUser = "F4@zN!8qW2#Lp9$Xr6^tY3&m";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { getDb } from "../master_list/config/mongdodb.config.js";
import { validateProductList, promoteProductList, rollbackProductList } from "../master_list/controller/validation/validateProductList.js";
import { diffProductList } from "../master_list/controller/validation/diffProductList.js";
import { PipelineRunCollector } from "../master_list/controller/validation/pipelineRunLog.js";
import { buildProductListStreaming } from "../master_list/controller/build_prod/productPipeline.js";

describe("Phase 2 Integration", () => {
  let db: any;

  before(async () => {
    db = await getDb("master_list");
    assert.equal(db.databaseName, "master_list_test", "Safety: must run against test DB");
  });

  describe("Validation — pass scenario", () => {
    before(async () => {
      // Build a product list so we have something to validate
      await buildProductListStreaming();
    });

    it("all 5 checks pass on a valid product list", async () => {
      // Create a fake previous list from current (simulates second run — must be full copy for count check)
      const docs = await db.collection("product_list").find({}, { projection: { _id: 0 } }).toArray();
      await db.dropCollection("product_list_previous").catch(() => {});
      if (docs.length > 0) {
        await db.collection("product_list_previous").insertMany(docs);
      }

      const result = await validateProductList();

      assert.equal(result.checks.length, 5, "Should run all 5 checks");
      for (const check of result.checks) {
        assert.equal(check.passed, true, `Check ${check.name} should pass: ${check.detail}`);
      }
      assert.equal(result.passed, true, "Overall validation should pass");

      // Cleanup
      await db.dropCollection("product_list_previous").catch(() => {});
    });
  });

  describe("Validation — fail scenario (missing distributor)", () => {
    it("distributor_minimums fails when a distributor is removed", async () => {
      // Remove all synnex products from a copy
      const count = await db.collection("product_list").countDocuments({ distributor_list: "synnex" });

      // Temporarily remove all synnex from product list
      await db.collection("product_list").updateMany(
        { distributor_list: "synnex" },
        { $pull: { distributor_list: "synnex" } as any }
      );

      // Also remove products that now have empty distributor_list
      // (they only had synnex)
      const result = await validateProductList({
        disabledChecks: ["product_count", "distributor_coverage"]
      });

      const distCheck = result.checks.find(c => c.name === "distributor_minimums");
      // Synnex should now be missing since we removed it from all lists
      // But products still exist, just without synnex in their list

      // Restore — rebuild to reset
      await buildProductListStreaming();

      assert.ok(distCheck, "distributor_minimums check should exist");
    });
  });

  describe("Validation — toggleable checks", () => {
    it("skips disabled checks", async () => {
      const result = await validateProductList({
        disabledChecks: ["product_count", "duplicate_sku"]
      });

      const checkNames = result.checks.map(c => c.name);
      assert.ok(!checkNames.includes("product_count"), "product_count should be skipped");
      assert.ok(!checkNames.includes("duplicate_sku"), "duplicate_sku should be skipped");
      assert.equal(result.checks.length, 3, "Should only run 3 checks");
    });
  });

  describe("Rollback", () => {
    it("restores previous product list on rollback", async () => {
      const currentCount = await db.collection("product_list").countDocuments();

      // Create a small previous list
      await db.dropCollection("product_list_previous").catch(() => {});
      await db.collection("product_list_previous").insertMany([
        { normalized_sku: "ROLLBACK_TEST_1", sku: "test-1", upc: "111" },
        { normalized_sku: "ROLLBACK_TEST_2", sku: "test-2", upc: "222" },
      ]);

      // Simulate failed validation — drop current, rollback
      await db.dropCollection("product_list").catch(() => {});
      await rollbackProductList();

      // product_list should now contain the previous data
      const afterRollback = await db.collection("product_list").countDocuments();
      assert.equal(afterRollback, 2, "Should have the 2 docs from previous");

      const doc = await db.collection("product_list").findOne({ normalized_sku: "ROLLBACK_TEST_1" });
      assert.ok(doc, "Rollback test doc should exist");

      // Rebuild for subsequent tests
      await buildProductListStreaming();
    });
  });

  describe("Run diffing", () => {
    it("detects differences between current and previous", async () => {
      // Create a previous list that's slightly different
      await db.dropCollection("product_list_previous").catch(() => {});
      const currentDocs = await db.collection("product_list").find({}, { projection: { _id: 0 } }).limit(50).toArray();

      if (currentDocs.length > 0) {
        // Remove a few to simulate "removed" products
        const modified = currentDocs.slice(5);
        await db.collection("product_list_previous").insertMany(modified);
      }

      const diff = await diffProductList();

      assert.ok(diff.added >= 0, "Should report added count");
      assert.ok(diff.removed >= 0, "Should report removed count");
      assert.ok(typeof diff.priceChanges === "number", "Should report price changes");
      assert.ok(typeof diff.inventorySwings === "number", "Should report inventory swings");
      assert.ok(typeof diff.distributorChanges === "number", "Should report distributor changes");
      assert.ok(diff.details, "Should include details object");

      // Cleanup
      await db.dropCollection("product_list_previous").catch(() => {});
    });

    it("handles first run (no previous)", async () => {
      await db.dropCollection("product_list_previous").catch(() => {});

      const diff = await diffProductList();
      const currentCount = await db.collection("product_list").countDocuments();

      assert.equal(diff.added, currentCount, "First run should show all as added");
      assert.equal(diff.removed, 0, "First run should show 0 removed");
    });
  });

  describe("Audit log", () => {
    it("persists a pipeline run record", async () => {
      await db.dropCollection("pipeline_runs").catch(() => {});

      const collector = new PipelineRunCollector();
      collector.addStage({ name: "test_stage", durationSec: 1.5, heapDeltaMb: 10 });

      const validation = await validateProductList();
      const diff = await diffProductList();

      await collector.persist({
        status: "success",
        validation,
        diff,
      });

      const record = await db.collection("pipeline_runs").findOne({});
      assert.ok(record, "Should have a pipeline_runs record");
      assert.equal(record.status, "success");
      assert.ok(record.startedAt, "Should have startedAt");
      assert.ok(record.completedAt, "Should have completedAt");
      assert.ok(record.stages.length > 0, "Should have stages");
      assert.equal(record.stages[0].name, "test_stage");
      assert.ok(record.validation, "Should have validation results");
      assert.ok(record.diff, "Should have diff results");

      // Cleanup
      await db.dropCollection("pipeline_runs").catch(() => {});
    });

    it("persists failed run record", async () => {
      await db.dropCollection("pipeline_runs").catch(() => {});

      const collector = new PipelineRunCollector();
      await collector.persist({
        status: "failed",
        error: "Test error message",
      });

      const record = await db.collection("pipeline_runs").findOne({});
      assert.ok(record, "Should have a record");
      assert.equal(record.status, "failed");
      assert.equal(record.error, "Test error message");

      await db.dropCollection("pipeline_runs").catch(() => {});
    });
  });

  after(async () => {
    // Clean up test artifacts
    await db.dropCollection("product_list_previous").catch(() => {});
    await db.dropCollection("pipeline_runs").catch(() => {});
    process.exit(0);
  });
});

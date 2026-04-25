/**
 * Layer 4: Partial end-to-end test.
 * Runs the full orchestrator flow against master_list_test,
 * skipping download/parse/API calls (test data is pre-seeded).
 *
 * Tests the complete chain:
 * - Build product list (streaming)
 * - Validation gate (pass → promote, fail → rollback)
 * - Run diffing
 * - Audit log persistence
 * - Alert on failure
 *
 * Usage: npm run test:e2e
 *
 * Prerequisites: run seed_test_db.ts first
 */

process.env.DB_NAME_OVERRIDE = "master_list_test";
process.env.mUser = "tempUserMasterlist";
process.env.pUser = "F4@zN!8qW2#Lp9$Xr6^tY3&m";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { getDb } from "../master_list/config/mongdodb.config.js";
import { buildProductListStreaming } from "../master_list/controller/build_prod/productPipeline.js";
import { validateProductList, promoteProductList, rollbackProductList } from "../master_list/controller/validation/validateProductList.js";
import { diffProductList } from "../master_list/controller/validation/diffProductList.js";
import { PipelineRunCollector } from "../master_list/controller/validation/pipelineRunLog.js";
import { sendPipelineAlert } from "../master_list/controller/validation/alerting.js";

describe("End-to-end: full orchestrator flow", () => {
  let db: any;

  before(async () => {
    db = await getDb("master_list");
    assert.equal(db.databaseName, "master_list_test", "Safety: must run against test DB");

    // Verify test data exists
    const groupedCount = await db.collection("grouped_upc_data").countDocuments();
    assert.ok(groupedCount > 0, `Test data missing — run seed_test_db.ts first (got ${groupedCount} groups)`);
  });

  it("successful run: build → validate → diff → audit → promote", async () => {
    const runLog = new PipelineRunCollector();
    const startHeap = process.memoryUsage().heapUsed;

    // Step 1: Preserve previous product_list (if exists)
    try {
      await db.admin().command({
        renameCollection: `${db.databaseName}.product_list`,
        to: `${db.databaseName}.product_list_previous`,
        dropTarget: true,
      });
    } catch { /* first run */ }

    // Step 2: Build
    const buildResult = await buildProductListStreaming();
    runLog.addStage({ name: "buildProductList", durationSec: 0, heapDeltaMb: 0 });
    assert.ok(buildResult.inserted > 0, `Build should insert products (got ${buildResult.inserted})`);

    const productCount = await db.collection("product_list").countDocuments();
    assert.ok(productCount > 0, `product_list should have docs (got ${productCount})`);

    // Step 3: Validate
    const validation = await validateProductList();
    runLog.addStage({ name: "validateProductList", durationSec: 0, heapDeltaMb: 0 });

    // Step 4: Handle validation result
    if (!validation.passed) {
      // This is unexpected in a normal test run but we handle it
      await rollbackProductList();
      await runLog.persist({ status: "rolled_back", validation, error: "Validation failed in e2e test" });
      assert.fail(`Validation failed: ${validation.checks.filter(c => !c.passed).map(c => `${c.name}: ${c.detail}`).join("; ")}`);
    }

    // Step 5: Diff
    const diff = await diffProductList();
    runLog.addStage({ name: "diffProductList", durationSec: 0, heapDeltaMb: 0 });
    assert.ok(typeof diff.added === "number", "Diff should have added count");
    assert.ok(typeof diff.removed === "number", "Diff should have removed count");

    // Step 6: Promote
    await promoteProductList();

    // Step 7: Persist audit log
    await runLog.persist({ status: "success", validation, diff });

    // Verify audit log
    const auditRecord = await db.collection("pipeline_runs").findOne({ status: "success" });
    assert.ok(auditRecord, "Should have audit log record");
    assert.ok(auditRecord.validation, "Audit should include validation");
    assert.ok(auditRecord.diff, "Audit should include diff");
    assert.ok(auditRecord.stages.length >= 3, `Should have 3+ stages (got ${auditRecord.stages.length})`);

    // Verify product_list_previous is gone (promote drops it)
    const prevExists = (await db.listCollections({ name: "product_list_previous" }).toArray()).length > 0;
    assert.equal(prevExists, false, "product_list_previous should be dropped after promote");

    // Memory check
    const endHeap = process.memoryUsage().heapUsed;
    const heapMb = (endHeap - startHeap) / 1024 / 1024;
    console.log(`  Heap delta: ${heapMb.toFixed(1)} MB`);

    console.log(`  ✅ Successful run: ${productCount} products, validation passed, diff computed, audit logged`);
  });

  it("failure run: build → validate fails → rollback → alert → audit", async () => {
    // Step 1: Create a known good product_list
    await buildProductListStreaming();
    const goodCount = await db.collection("product_list").countDocuments();

    // Step 2: Preserve it as previous
    await db.admin().command({
      renameCollection: `${db.databaseName}.product_list`,
      to: `${db.databaseName}.product_list_previous`,
      dropTarget: true,
    });

    // Step 3: Create a deliberately bad product_list (tiny — will fail count check)
    await db.dropCollection("product_list").catch(() => {});
    await db.createCollection("product_list");
    await db.collection("product_list").insertMany([
      { normalized_sku: "BAD1", sku: "bad-1", upc: "111", distributor_list: ["synnex"] },
      { normalized_sku: "BAD2", sku: "bad-2", upc: "222", distributor_list: ["dandh"] },
    ]);

    // Step 4: Validate — should fail (count deviation > 10%)
    const runLog = new PipelineRunCollector();
    const validation = await validateProductList();

    assert.equal(validation.passed, false, "Validation should fail on tiny product list");

    const countCheck = validation.checks.find(c => c.name === "product_count");
    assert.ok(countCheck, "Should have product_count check");
    assert.equal(countCheck!.passed, false, "Count check should fail");

    // Step 5: Rollback
    await rollbackProductList();

    // Verify rollback restored the good data
    const restoredCount = await db.collection("product_list").countDocuments();
    assert.equal(restoredCount, goodCount, `Rollback should restore ${goodCount} products (got ${restoredCount})`);

    // Step 6: Alert (logs to console since no webhook configured)
    await sendPipelineAlert({ type: "validation_failed", validation });

    // Step 7: Persist failed audit log
    await runLog.persist({ status: "rolled_back", validation, error: "Deliberately triggered failure" });

    const failRecord = await db.collection("pipeline_runs").findOne({ status: "rolled_back" });
    assert.ok(failRecord, "Should have rolled_back audit record");
    assert.ok(failRecord.error, "Should have error message");
    assert.equal(failRecord.validation.passed, false, "Audit should show validation failed");

    console.log(`  ✅ Failure run: validation failed, rolled back to ${restoredCount} products, alert fired, audit logged`);
  });

  after(async () => {
    // Clean up
    await db.dropCollection("product_list_previous").catch(() => {});
    await db.dropCollection("pipeline_runs").catch(() => {});
    process.exit(0);
  });
});

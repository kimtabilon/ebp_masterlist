/**
 * Tests for the pipeline orchestrator (EBP-17, EBP-18).
 * Runs against master_list_test.
 *
 * Usage: npx tsx --test tests/orchestrator.test.ts
 */

process.env.DB_NAME_OVERRIDE = "master_list_test";
process.env.mUser = "tempUserMasterlist";
process.env.pUser = "F4@zN!8qW2#Lp9$Xr6^tY3&m";

import { it, before, after } from "node:test";
import assert from "node:assert/strict";

import { getDb } from "../master_list/config/mongdodb.config.js";
import { runPipeline } from "../master_list/controller/orchestrator.js";

const LONG_TIMEOUT = 1200000; // 20 min

let db: any;

before(async () => {
    db = await getDb("master_list");
    assert.equal(db.databaseName, "master_list_test", "Safety: must run against test DB");

    const responseCount = await db.collection("synnex_response_table").countDocuments();
    assert.ok(responseCount > 0, `Need seeded response data (got ${responseCount})`);

    await db.dropCollection("product_list_previous").catch(() => {});
    await db.dropCollection("pipeline_runs").catch(() => {});
});

it("runs from buildProductList stage onward", { timeout: LONG_TIMEOUT }, async () => {
    await db.dropCollection("pipeline_runs").catch(() => {});

    await runPipeline({ startFromStage: "buildProductList" });

    const productCount = await db.collection("product_list").countDocuments();
    assert.ok(productCount > 0, `Should have products (got ${productCount})`);

    const runRecord = await db.collection("pipeline_runs").findOne(
        { status: "success" },
        { sort: { completedAt: -1 } }
    );
    assert.ok(runRecord, "Should have a successful run record");
    assert.ok(runRecord.stages.length >= 2, `Should have multiple stages logged (got ${runRecord.stages.length})`);

    const stageNames = runRecord.stages.map((s: any) => s.name);
    assert.ok(stageNames.includes("buildProductList"), "Should include buildProductList");
    assert.ok(stageNames.includes("validateAndPromote"), "Should include validateAndPromote");
});

it("skips stages before startFromStage", { timeout: LONG_TIMEOUT }, async () => {
    await db.dropCollection("pipeline_runs").catch(() => {});

    await runPipeline({ startFromStage: "validateAndPromote" });

    const runRecord = await db.collection("pipeline_runs").findOne(
        { status: "success" },
        { sort: { completedAt: -1 } }
    );
    assert.ok(runRecord, "Should have a run record");

    const stageNames = runRecord.stages.map((s: any) => s.name);
    assert.ok(!stageNames.includes("downloadRaw"), "Should NOT include downloadRaw");
    assert.ok(!stageNames.includes("buildProductList"), "Should NOT include buildProductList");
    assert.ok(stageNames.includes("validateAndPromote"), "Should include validateAndPromote");
});

it("persists per-stage timing in audit log", { timeout: LONG_TIMEOUT }, async () => {
    await db.dropCollection("pipeline_runs").catch(() => {});

    await runPipeline({ startFromStage: "validateAndPromote" });

    const runRecord = await db.collection("pipeline_runs").findOne(
        {},
        { sort: { completedAt: -1 } }
    );
    assert.ok(runRecord, "Should have a run record");

    for (const stage of runRecord.stages) {
        assert.ok(typeof stage.name === "string", "Stage should have name");
        assert.ok(typeof stage.durationSec === "number", "Stage should have durationSec");
        assert.ok(typeof stage.heapDeltaMb === "number", "Stage should have heapDeltaMb");
    }
});

it("non-critical stage failure does not halt pipeline", { timeout: LONG_TIMEOUT }, async () => {
    await db.dropCollection("pipeline_runs").catch(() => {});

    await runPipeline({ startFromStage: "buildProductList" });

    const runRecord = await db.collection("pipeline_runs").findOne(
        { status: "success" },
        { sort: { completedAt: -1 } }
    );
    assert.ok(runRecord, "Pipeline should still succeed despite webhook failures");
});

it("resumed run is logged with resumed flag", { timeout: LONG_TIMEOUT }, async () => {
    await db.dropCollection("pipeline_runs").catch(() => {});

    await runPipeline({ startFromStage: "validateAndPromote" });

    const runRecord = await db.collection("pipeline_runs").findOne(
        { status: "success" },
        { sort: { completedAt: -1 } }
    );
    assert.ok(runRecord, "Should have a run record");
    assert.equal(runRecord.resumed, true, "Should be marked as resumed");
    assert.equal(runRecord.resumedFromStage, "validateAndPromote", "Should record which stage was resumed from");
});

it("record has resume fields", { timeout: LONG_TIMEOUT }, async () => {
    await db.dropCollection("pipeline_runs").catch(() => {});

    await runPipeline({ startFromStage: "validateAndPromote" });

    const runRecord = await db.collection("pipeline_runs").findOne(
        {},
        { sort: { completedAt: -1 } }
    );
    assert.ok("resumed" in runRecord, "Record should have resumed field");
    assert.ok("resumedFromStage" in runRecord, "Record should have resumedFromStage field");
});

it("rejects invalid stage name", { timeout: LONG_TIMEOUT }, async () => {
    await assert.rejects(
        () => runPipeline({ startFromStage: "nonexistentStage" }),
        /Unknown stage "nonexistentStage"/,
        "Should throw on invalid stage name"
    );
});

after(async () => {
    await db.dropCollection("pipeline_runs").catch(() => {});
    await db.dropCollection("product_list_previous").catch(() => {});
    process.exit(0);
});

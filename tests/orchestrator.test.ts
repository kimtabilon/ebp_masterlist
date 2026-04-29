/**
 * Tests for the pipeline orchestrator (EBP-17).
 * Runs against master_list_test.
 *
 * Usage: npx tsx --test tests/orchestrator.test.ts
 */

process.env.DB_NAME_OVERRIDE = "master_list_test";
process.env.mUser = "tempUserMasterlist";
process.env.pUser = "F4@zN!8qW2#Lp9$Xr6^tY3&m";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { getDb } from "../master_list/config/mongdodb.config.js";
import { runPipeline } from "../master_list/controller/orchestrator.js";

describe("Pipeline Orchestrator", () => {
    let db: any;

    before(async () => {
        db = await getDb("master_list");
        assert.equal(db.databaseName, "master_list_test", "Safety: must run against test DB");

        // Verify we have seeded data
        const responseCount = await db.collection("synnex_response_table").countDocuments();
        assert.ok(responseCount > 0, `Need seeded response data (got ${responseCount})`);

        // Clean up from prior runs so validation doesn't fail on stale product_list_previous
        await db.dropCollection("product_list_previous").catch(() => {});
        await db.dropCollection("pipeline_runs").catch(() => {});
    });

    it("runs from buildProductList stage onward (--skip-merge equivalent)", async () => {
        await db.dropCollection("pipeline_runs").catch(() => {});

        // Start from buildProductList — skips download, parse, merge, filters, response tables
        await runPipeline({ startFromStage: "buildProductList" });

        // Verify product list was built
        const productCount = await db.collection("product_list").countDocuments();
        assert.ok(productCount > 0, `Should have products (got ${productCount})`);

        // Verify audit log was persisted
        const runRecord = await db.collection("pipeline_runs").findOne(
            { status: "success" },
            { sort: { completedAt: -1 } }
        );
        assert.ok(runRecord, "Should have a successful run record");
        assert.ok(runRecord.stages.length >= 2, `Should have multiple stages logged (got ${runRecord.stages.length})`);

        // Verify the stages that ran
        const stageNames = runRecord.stages.map((s: any) => s.name);
        assert.ok(stageNames.includes("buildProductList"), "Should include buildProductList");
        assert.ok(stageNames.includes("validateAndPromote"), "Should include validateAndPromote");
    });

    it("skips stages before startFromStage", async () => {
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

    it("persists per-stage timing in audit log", async () => {
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

    it("non-critical stage failure does not halt pipeline", async () => {
        // webhooks stage is non-critical — if it fails, pipeline continues
        // Since we're in test, webhooks will fail (external URLs) but pipeline should succeed
        await db.dropCollection("pipeline_runs").catch(() => {});

        // Run from buildProductList which includes webhooks at the end
        await runPipeline({ startFromStage: "buildProductList" });

        const runRecord = await db.collection("pipeline_runs").findOne(
            { status: "success" },
            { sort: { completedAt: -1 } }
        );
        assert.ok(runRecord, "Pipeline should still succeed despite webhook failures");
    });

    after(async () => {
        await db.dropCollection("pipeline_runs").catch(() => {});
        await db.dropCollection("product_list_previous").catch(() => {});
        process.exit(0);
    });
});

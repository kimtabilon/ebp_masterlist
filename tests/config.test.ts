/**
 * Tests for config externalization (EBP-19) and API auth (EBP-28).
 * No database required.
 *
 * Usage: npx tsx --test tests/config.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

describe("Config module", () => {
    // Save original env
    const origEnv = { ...process.env };

    afterEach(() => {
        // Restore original env
        for (const key of Object.keys(process.env)) {
            if (!(key in origEnv)) delete process.env[key];
        }
        Object.assign(process.env, origEnv);
    });

    it("mongo config falls back to legacy mUser/pUser", async () => {
        process.env.mUser = "testuser";
        process.env.pUser = "testpass";
        delete process.env.MONGO_USER;
        delete process.env.MONGO_PASS;

        // Re-import to pick up env changes
        const { config } = await import("../master_list/config/env.js");
        assert.equal(config.mongo.user(), "testuser");
        assert.equal(config.mongo.pass(), "testpass");
    });

    it("MONGO_USER takes precedence over mUser", async () => {
        process.env.MONGO_USER = "newuser";
        process.env.mUser = "legacyuser";

        const { config } = await import("../master_list/config/env.js");
        assert.equal(config.mongo.user(), "newuser");
    });

    it("optional values use defaults", async () => {
        delete process.env.MONGO_HOST;
        delete process.env.BUILD_BATCH_SIZE;

        const { config } = await import("../master_list/config/env.js");
        assert.equal(config.mongo.host(), "64.225.124.70");
        assert.equal(config.pipeline.batchSize(), 1000);
    });

    it("optional values use env when set", async () => {
        process.env.MONGO_HOST = "custom-host";
        process.env.BUILD_BATCH_SIZE = "5000";

        const { config } = await import("../master_list/config/env.js");
        assert.equal(config.mongo.host(), "custom-host");
        assert.equal(config.pipeline.batchSize(), 5000);
    });

    it("validateEnv warns instead of exiting on missing vars", async () => {
        delete process.env.MONGO_USER;
        delete process.env.mUser;
        delete process.env.MONGO_PASS;
        delete process.env.pUser;

        const warnings: string[] = [];
        const origWarn = console.warn;
        console.warn = (...args: any[]) => warnings.push(args.join(" "));

        const { validateEnv } = await import("../master_list/config/env.js");
        // Should NOT throw or exit — just warn
        validateEnv();

        console.warn = origWarn;
        assert.ok(warnings.some(w => w.includes("MONGO_USER")), "Should warn about missing MONGO_USER");
    });

    it("DB_NAME_OVERRIDE flows through config", async () => {
        process.env.DB_NAME_OVERRIDE = "test_db";

        const { config } = await import("../master_list/config/env.js");
        assert.equal(config.test.dbNameOverride(), "test_db");
    });
});

describe("API Key Auth Middleware", () => {
    // Mock express req/res/next
    function mockReq(headers: Record<string, string> = {}): any {
        return { headers };
    }

    function mockRes(): any {
        const res: any = {
            statusCode: 200,
            body: null,
            status(code: number) { res.statusCode = code; return res; },
            json(data: any) { res.body = data; return res; },
        };
        return res;
    }

    let nextCalled: boolean;
    function mockNext() { nextCalled = true; }

    beforeEach(() => { nextCalled = false; });

    const origEnv = { ...process.env };
    afterEach(() => {
        for (const key of Object.keys(process.env)) {
            if (!(key in origEnv)) delete process.env[key];
        }
        Object.assign(process.env, origEnv);
    });

    it("allows requests when no API_KEY configured (transition mode)", async () => {
        delete process.env.API_KEY;

        const { requireApiKey } = await import("../master_list/middleware/auth.js");
        const req = mockReq();
        const res = mockRes();

        requireApiKey(req, res, mockNext);
        assert.ok(nextCalled, "Should call next() when no API_KEY configured");
    });

    it("rejects requests with missing header when API_KEY is set", async () => {
        process.env.API_KEY = "secret123";

        // Need fresh import to pick up env change
        // Auth middleware reads config at call time, so this works
        const { requireApiKey } = await import("../master_list/middleware/auth.js");
        const req = mockReq({});
        const res = mockRes();

        requireApiKey(req, res, mockNext);
        assert.equal(nextCalled, false, "Should NOT call next()");
        assert.equal(res.statusCode, 401);
        assert.ok(res.body.error.includes("Missing"), "Should say missing header");
    });

    it("rejects requests with wrong API key", async () => {
        process.env.API_KEY = "secret123";

        const { requireApiKey } = await import("../master_list/middleware/auth.js");
        const req = mockReq({ "x-api-key": "wrongkey" });
        const res = mockRes();

        requireApiKey(req, res, mockNext);
        assert.equal(nextCalled, false);
        assert.equal(res.statusCode, 401);
        assert.ok(res.body.error.includes("Invalid"));
    });

    it("allows requests with correct API key", async () => {
        process.env.API_KEY = "secret123";

        const { requireApiKey } = await import("../master_list/middleware/auth.js");
        const req = mockReq({ "x-api-key": "secret123" });
        const res = mockRes();

        requireApiKey(req, res, mockNext);
        assert.ok(nextCalled, "Should call next() with correct key");
    });
});

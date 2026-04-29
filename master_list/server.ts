import app from "./app";
import dotenv from "dotenv";
dotenv.config();
import fs from "fs";
import path from "path";
import { runPipeline } from "./controller/orchestrator";
import cron from "node-cron";
import { log } from "./utils/logger";

const PORT = 5003;

let pipelineRunning = false;
let lastRunTimestamp: number = 0;

/**
 * Check if new distributor files have arrived since the last successful run.
 * Compares file modification times against lastRunTimestamp.
 *
 * Files checked (same as downloadRaw targets):
 * - master_list/raw/synnex-pa.zip
 * - master_list/raw/dandh-pa
 * - master_list/raw/ingram-pa.zip
 * - master_list/raw/4015068_PriceExport.CSV
 * - master_list/raw/almo.xlsx
 */
function hasNewDistributorFiles(): boolean {
    const rawDir = path.join(process.cwd(), "master_list/raw");
    const files = [
        "synnex-pa.zip",
        "dandh-pa",
        "ingram-pa.zip",
        "4015068_PriceExport.CSV",
        "almo.xlsx",
    ];

    for (const file of files) {
        const filePath = path.join(rawDir, file);
        try {
            const stat = fs.statSync(filePath);
            if (stat.mtimeMs > lastRunTimestamp) {
                return true;
            }
        } catch {
            // File doesn't exist — will be downloaded during pipeline
            continue;
        }
    }

    return false;
}

cron.schedule("0 */2 * * *", async () => {
    if (pipelineRunning) {
        log("warn", "cron", "Pipeline still running from previous invocation — skipping this run");
        return;
    }

    // Check if new files have arrived (skip on first run — lastRunTimestamp is 0)
    if (lastRunTimestamp > 0 && !hasNewDistributorFiles()) {
        log("info", "cron", "No new distributor files since last run — skipping", {
            lastRunTimestamp: new Date(lastRunTimestamp).toISOString(),
        });
        return;
    }

    pipelineRunning = true;
    try {
        log("info", "cron", "Starting pipeline run");
        await runPipeline();
        lastRunTimestamp = Date.now();
        log("info", "cron", "Pipeline run completed successfully");
    } catch (err: any) {
        log("error", "cron", `Pipeline run failed: ${err.message}`);
    } finally {
        pipelineRunning = false;
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
});

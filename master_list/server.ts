import app from "./app";
import dotenv from "dotenv";
dotenv.config();
import { runPipeline } from "./controller/orchestrator";
import cron from "node-cron";

const PORT = 5003;

let pipelineRunning = false;

cron.schedule("0 */2 * * *", async () => {
    if (pipelineRunning) {
        console.warn("⚠️ [CRON] Pipeline still running from previous invocation — skipping this run.");
        return;
    }
    pipelineRunning = true;
    try {
        await runPipeline();
    } catch (err: any) {
        console.error("❌ [CRON] Error:", err.message);
    } finally {
        pipelineRunning = false;
    }
});

app.listen(PORT, () => {
    //sync
    // generateProdLIst();
    console.log(`🚀 Server running at http://localhost:${PORT}`);
});

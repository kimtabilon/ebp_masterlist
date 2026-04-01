import app from "./app";
import dotenv from "dotenv";
dotenv.config();
import { generateProdLIst,generateProdLIst2,generateProdLIst3,generateProdLIst4 } from "./controller/generate_master_list";
import cron from "node-cron";

//test
const PORT = 5003;

let pipelineRunning = false;

cron.schedule("0 */2 * * *", async () => {
    if (pipelineRunning) {
        console.warn("⚠️ [CRON] Pipeline still running from previous invocation — skipping this run.");
        return;
    }
    pipelineRunning = true;
    try {
        await generateProdLIst();
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

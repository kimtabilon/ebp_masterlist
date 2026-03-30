import app from "./app";
import dotenv from "dotenv";
dotenv.config();
import { generateProdLIst,generateProdLIst2,generateProdLIst3,generateProdLIst4 } from "./controller/generate_master_list";
import cron from "node-cron";

//test
const PORT = 5003;

cron.schedule("0 */2 * * *", async () => { try { await generateProdLIst(); } catch (err: any) { console.error("❌ [CRON] Error:", err.message); } });

app.listen(PORT, () => {
    //sync
    // generateProdLIst();
    console.log(`🚀 Server running at http://localhost:${PORT}`);
});

/**
 * One-shot pipeline runner.
 *
 * Usage:
 *   npx tsx scripts/run_pipeline.ts                        # full run from start
 *   npx tsx scripts/run_pipeline.ts <stageName>            # resume from a stage
 *
 * For background runs, wrap with nohup:
 *   nohup npx tsx scripts/run_pipeline.ts > /tmp/pipeline.log 2>&1 &
 *
 * Honors DB_NAME_OVERRIDE from .env to route to a test database.
 */
import dotenv from "dotenv";
dotenv.config();

import { runPipeline } from "../master_list/controller/orchestrator.js";

const startFromStage = process.argv[2];

runPipeline(startFromStage ? { startFromStage } : undefined)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

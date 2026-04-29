import { getDb } from "../../config/mongdodb.config";
import { ValidationResult } from "./validateProductList";
import { DiffResult } from "./diffProductList";

export interface StageMetric {
    name: string;
    durationSec: number;
    heapDeltaMb: number;
}

export interface PipelineRunRecord {
    startedAt: Date;
    completedAt: Date;
    durationSec: number;
    status: "success" | "failed" | "rolled_back";
    resumed: boolean;
    resumedFromStage: string | null;
    stages: StageMetric[];
    validation: ValidationResult | null;
    diff: DiffResult | null;
    error: string | null;
}

/**
 * Collects stage metrics during a pipeline run, then persists the full record.
 */
export class PipelineRunCollector {
    private startedAt: Date;
    private stages: StageMetric[] = [];
    private _resumed: boolean = false;
    private _resumedFromStage: string | null = null;

    constructor(options?: { resumed?: boolean; resumedFromStage?: string }) {
        this.startedAt = new Date();
        this._resumed = options?.resumed ?? false;
        this._resumedFromStage = options?.resumedFromStage ?? null;
    }

    addStage(metric: StageMetric) {
        this.stages.push(metric);
    }

    async persist(options: {
        status: PipelineRunRecord["status"];
        validation?: ValidationResult | null;
        diff?: DiffResult | null;
        error?: string | null;
    }): Promise<void> {
        const completedAt = new Date();
        const durationSec = (completedAt.getTime() - this.startedAt.getTime()) / 1000;

        const record: PipelineRunRecord = {
            startedAt: this.startedAt,
            completedAt,
            durationSec,
            status: options.status,
            resumed: this._resumed,
            resumedFromStage: this._resumedFromStage,
            stages: this.stages,
            validation: options.validation ?? null,
            diff: options.diff ?? null,
            error: options.error ?? null,
        };

        const db = await getDb("master_list");
        await db.collection("pipeline_runs").insertOne(record);

        console.log(`📋 Pipeline run logged: ${options.status} | ${durationSec.toFixed(1)}s | ${this.stages.length} stages`);
    }
}

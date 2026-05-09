/**
 * Structured logger for pipeline stages (EBP-21).
 *
 * Outputs JSON log lines that are parseable by log aggregation tools.
 * Each log entry includes: timestamp, level, stage, message, and optional data.
 *
 * Also writes human-readable output to console for local development.
 */

export type LogLevel = "info" | "warn" | "error" | "debug";

export interface StructuredLogEntry {
    timestamp: string;
    level: LogLevel;
    stage: string;
    message: string;
    data?: Record<string, any>;
}

const JSON_LOGGING = process.env.LOG_FORMAT === "json";

export function log(level: LogLevel, stage: string, message: string, data?: Record<string, any>): void {
    const entry: StructuredLogEntry = {
        timestamp: new Date().toISOString(),
        level,
        stage,
        message,
        ...(data ? { data } : {}),
    };

    if (JSON_LOGGING) {
        // Structured JSON output for production / log aggregation
        console.log(JSON.stringify(entry));
    } else {
        // Human-readable output for development
        const prefix = level === "error" ? "❌" : level === "warn" ? "⚠️" : level === "info" ? "ℹ️" : "🔍";
        const dataStr = data ? ` | ${JSON.stringify(data)}` : "";
        console.log(`${prefix} [${stage}] ${message}${dataStr}`);
    }
}

export function logStageStart(stage: string): void {
    log("info", stage, "Stage started", {
        heapMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    });
}

export function logStageComplete(stage: string, durationSec: number, heapDeltaMb: number, extra?: Record<string, any>): void {
    log("info", stage, "Stage completed", {
        durationSec,
        heapDeltaMb,
        ...extra,
    });
}

export function logStageError(stage: string, error: string): void {
    log("error", stage, error);
}

export function logStageSkipped(stage: string, reason: string): void {
    log("info", stage, `Stage skipped: ${reason}`);
}

export function logValidationResult(stage: string, checkName: string, passed: boolean, detail: string): void {
    log(passed ? "info" : "warn", stage, `Validation: ${checkName}`, { passed, detail });
}

export function logPipelineSummary(status: string, durationSec: number, stageCount: number, extra?: Record<string, any>): void {
    log("info", "pipeline", `Pipeline ${status}`, {
        durationSec,
        stageCount,
        ...extra,
    });
}

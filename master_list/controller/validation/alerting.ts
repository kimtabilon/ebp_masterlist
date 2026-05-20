import axios from "axios";
import { ValidationResult } from "./validateProductList";
import { DiffResult } from "./diffProductList";

/**
 * Send an alert when the pipeline succeeds, fails validation, or errors out.
 *
 * Supports Slack webhook (default) via ALERT_SLACK_WEBHOOK_URL env var.
 * Falls back to console logging if no webhook is configured.
 */
export async function sendPipelineAlert(options: {
    type: "pipeline_success" | "validation_failed" | "anomaly_detected" | "pipeline_error";
    validation?: ValidationResult | null;
    diff?: DiffResult | null;
    error?: string | null;
    durationSec?: number;
    productCount?: number;
}): Promise<void> {
    const webhookUrl = process.env.ALERT_SLACK_WEBHOOK_URL;
    const isSuccess = options.type === "pipeline_success";

    const message = formatAlertMessage(options);
    const icon = isSuccess ? "✅" : "🚨";
    const label = isSuccess ? "Pipeline Run" : "Pipeline Alert";

    if (isSuccess) {
        console.log(`${icon} ${label} [${options.type}]:\n${message}`);
    } else {
        console.error(`${icon} ${label} [${options.type}]:\n${message}`);
    }

    if (webhookUrl) {
        try {
            await axios.post(webhookUrl, {
                text: `${icon} *${label}: ${formatAlertType(options.type)}*\n${message}`,
            });
            console.log("✅ Alert sent to Slack");
        } catch (err: any) {
            console.error("❌ Failed to send Slack alert:", err?.message);
        }
    } else {
        console.warn("⚠️ No ALERT_SLACK_WEBHOOK_URL configured — alert logged to console only");
    }
}

function formatAlertType(type: string): string {
    switch (type) {
        case "pipeline_success": return "Success";
        case "validation_failed": return "Validation Failed";
        case "anomaly_detected": return "Anomaly Detected";
        case "pipeline_error": return "Pipeline Error";
        default: return type;
    }
}

function formatAlertMessage(options: {
    type: string;
    validation?: ValidationResult | null;
    diff?: DiffResult | null;
    error?: string | null;
    durationSec?: number;
    productCount?: number;
}): string {
    const lines: string[] = [];

    if (options.error) {
        lines.push(`Error: ${options.error}`);
    }

    if (options.durationSec !== undefined) {
        const mins = Math.floor(options.durationSec / 60);
        const secs = Math.round(options.durationSec % 60);
        lines.push(`Duration: ${mins}m ${secs}s`);
    }

    if (options.productCount !== undefined) {
        lines.push(`Products: ${options.productCount.toLocaleString()}`);
    }

    if (options.validation) {
        const failed = options.validation.checks.filter(c => !c.passed);
        if (failed.length > 0) {
            lines.push("Failed checks:");
            for (const check of failed) {
                lines.push(`  • ${check.name}: ${check.detail}`);
            }
        } else if (options.type === "pipeline_success") {
            lines.push(`Validation: all ${options.validation.checks.length} checks passed`);
        }
    }

    if (options.diff) {
        lines.push(`Diff: +${options.diff.added} added, -${options.diff.removed} removed, ${options.diff.priceChanges} price changes, ${options.diff.inventorySwings} inventory swings, ${options.diff.distributorChanges} distributor changes`);
    }

    return lines.join("\n");
}

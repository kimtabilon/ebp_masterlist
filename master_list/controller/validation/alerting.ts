import axios from "axios";
import { ValidationResult } from "./validateProductList";
import { DiffResult } from "./diffProductList";

/**
 * Send an alert when validation fails or anomalous data is detected.
 *
 * Supports Slack webhook (default) via ALERT_SLACK_WEBHOOK_URL env var.
 * Falls back to console logging if no webhook is configured.
 */
export async function sendPipelineAlert(options: {
    type: "validation_failed" | "anomaly_detected" | "pipeline_error";
    validation?: ValidationResult | null;
    diff?: DiffResult | null;
    error?: string | null;
}): Promise<void> {
    const webhookUrl = process.env.ALERT_SLACK_WEBHOOK_URL;

    const message = formatAlertMessage(options);

    // Always log to console
    console.error(`🚨 PIPELINE ALERT [${options.type}]:\n${message}`);

    // Send to Slack if configured
    if (webhookUrl) {
        try {
            await axios.post(webhookUrl, {
                text: `🚨 *Pipeline Alert: ${formatAlertType(options.type)}*\n${message}`,
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
}): string {
    const lines: string[] = [];

    if (options.error) {
        lines.push(`Error: ${options.error}`);
    }

    if (options.validation) {
        const failed = options.validation.checks.filter(c => !c.passed);
        if (failed.length > 0) {
            lines.push("Failed checks:");
            for (const check of failed) {
                lines.push(`  • ${check.name}: ${check.detail}`);
            }
        }
    }

    if (options.diff) {
        lines.push(`Diff: +${options.diff.added} added, -${options.diff.removed} removed, ${options.diff.priceChanges} price changes, ${options.diff.inventorySwings} inventory swings, ${options.diff.distributorChanges} distributor changes`);
    }

    return lines.join("\n");
}

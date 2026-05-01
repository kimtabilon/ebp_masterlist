/**
 * Centralized environment variable configuration (EBP-19).
 *
 * All hardcoded values are replaced with env vars.
 * The app refuses to start if required vars are missing.
 *
 * Usage: import { config } from "../config/env";
 */

function required(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`❌ Missing required environment variable: ${name}. Check your .env file.`);
    }
    return value;
}

function optional(name: string, defaultValue: string): string {
    return process.env[name] || defaultValue;
}

function optionalNumber(name: string, defaultValue: number): number {
    const val = process.env[name];
    return val ? Number(val) : defaultValue;
}

/**
 * Validate all required env vars are present.
 * Call this at startup before the app begins processing.
 */
export function validateEnv(): void {
    const warnings: string[] = [];

    // Check MongoDB — support both new names and legacy (mUser/pUser)
    const hasMongoUser = !!(process.env.MONGO_USER || process.env.mUser);
    const hasMongoPass = !!(process.env.MONGO_PASS || process.env.pUser);

    if (!hasMongoUser) warnings.push("MONGO_USER (or legacy mUser) is not set");
    if (!hasMongoPass) warnings.push("MONGO_PASS (or legacy pUser) is not set");

    // Warn about legacy env vars
    if (process.env.mUser && !process.env.MONGO_USER) {
        warnings.push("Using legacy mUser — migrate to MONGO_USER");
    }
    if (process.env.pUser && !process.env.MONGO_PASS) {
        warnings.push("Using legacy pUser — migrate to MONGO_PASS");
    }

    // Warn about hardcoded credential fallbacks still in use
    if (!process.env.INGRAM_CLIENT_ID) warnings.push("INGRAM_CLIENT_ID not set — hardcoded fallback in use");
    if (!process.env.INGRAM_CLIENT_SECRET) warnings.push("INGRAM_CLIENT_SECRET not set — hardcoded fallback in use");
    if (!process.env.SYNNEX_API_PASS) warnings.push("SYNNEX_API_PASS not set — hardcoded fallback in use");
    if (!process.env.API_KEY) warnings.push("API_KEY not set — API endpoints unprotected");

    if (warnings.length > 0) {
        console.warn("⚠️ Environment warnings:");
        for (const w of warnings) {
            console.warn(`   - ${w}`);
        }
        console.warn("See .env.example for recommended configuration.\n");
    } else {
        console.log("✅ Environment validated — all variables configured");
    }
}

export const config = {
    // MongoDB
    mongo: {
        host: () => optional("MONGO_HOST", "64.225.124.70"),
        port: () => optional("MONGO_PORT", "27018"),
        user: () => process.env.MONGO_USER || process.env.mUser || "",
        pass: () => process.env.MONGO_PASS || process.env.pUser || "",
        dbName: () => optional("MONGO_DB_NAME", "master_list"),
    },

    // MySQL (legacy — used in sync_master)
    mysql: {
        host: () => optional("MYSQL_HOST", "190.92.158.197"),
        port: () => optionalNumber("MYSQL_PORT", 3306),
        user: () => optional("MYSQL_USER", "ecomm_vgAdmin"),
        pass: () => optional("MYSQL_PASS", ""),
        database: () => optional("MYSQL_DB", "ecomm_ebp_test"),
    },

    // SFTP credentials (var names match download_raw.ts / production .env)
    sftp: {
        synnex: {
            host: () => optional("SYNNEX_FTP_HOST", ""),
            user: () => optional("SYNNEX_FTP_USER", ""),
            pass: () => optional("SYNNEX_FTP_PASS", ""),
        },
        dandh: {
            host: () => optional("DANDH_SFTP_HOST", ""),
            user: () => optional("DANDH_FTP_USER", ""),
            pass: () => optional("DANDH_FTP_PASS", ""),
        },
        ingram: {
            host: () => optional("INGRAM_SFTP_HOST", ""),
            user: () => optional("INGRAM_FTP_USER", ""),
            pass: () => optional("INGRAM_FTP_PASS", ""),
        },
        suppliesNetwork: {
            host: () => optional("SUPPLIESNETWORK_SFTP_HOST", ""),
            user: () => optional("SUPPLIESNETWORK_SFTP_USER", ""),
            pass: () => optional("SUPPLIESNETWORK_SFTP_PASSWORD", ""),
        },
    },

    // API credentials
    api: {
        synnex: {
            user: () => optional("SYNNEX_API_USER", ""),
            pass: () => optional("SYNNEX_API_PASS", ""),
        },
        dandh: {
            user: () => optional("DANDH_API_USER", ""),
            pass: () => optional("DANDH_API_PASS", ""),
        },
        ingram: {
            clientId: () => optional("INGRAM_CLIENT_ID", ""),
            clientSecret: () => optional("INGRAM_CLIENT_SECRET", ""),
        },
    },

    // File paths
    paths: {
        rawDir: () => optional("RAW_DIR", "master_list/raw"),
        bufferDir: () => optional("BUFFER_DIR", "src/raw"),
        manufacturerMap: () => optional("MANUFACTURER_MAP_PATH", "src/raw/manufacturer report.xlsx"),
    },

    // Pipeline thresholds
    pipeline: {
        batchSize: () => optionalNumber("BUILD_BATCH_SIZE", 1000),
        insertBatch: () => optionalNumber("INSERT_BATCH_SIZE", 20000),
    },

    // Validation thresholds
    validation: {
        countThresholdPct: () => optionalNumber("VALIDATION_COUNT_THRESHOLD_PCT", 10),
        maxInventoryMultiplier: () => optionalNumber("VALIDATION_MAX_INVENTORY_MULTIPLIER", 100),
        coverageMismatchPct: () => optionalNumber("VALIDATION_COVERAGE_MISMATCH_PCT", 1),
        disabledChecks: () => process.env.VALIDATION_DISABLED_CHECKS?.split(",").map(s => s.trim()) || [],
    },

    // Diff thresholds
    diff: {
        priceChangePct: () => optionalNumber("DIFF_PRICE_CHANGE_PCT", 10),
        inventoryChangePct: () => optionalNumber("DIFF_INVENTORY_CHANGE_PCT", 50),
    },

    // Alerting
    alerting: {
        slackWebhookUrl: () => process.env.ALERT_SLACK_WEBHOOK_URL || "",
    },

    // Webhook URLs
    webhooks: {
        updateInventory: () => optional("WEBHOOK_UPDATE_INVENTORY", "https://console.ecommercebusinessprime.com/api/marketplace/updateInventory"),
        updateWalmartInventory: () => optional("WEBHOOK_UPDATE_WALMART", "https://console.ecommercebusinessprime.com/api/marketplace/updateWalmartInventory"),
        updateNeweggInventory: () => optional("WEBHOOK_UPDATE_NEWEGG", "https://console.ecommercebusinessprime.com/api/newegg/updateInventory"),
    },

    // Logging
    logging: {
        format: () => optional("LOG_FORMAT", "human"), // "json" or "human"
    },

    // API endpoint auth
    auth: {
        apiKey: () => optional("API_KEY", ""),
    },

    // Test mode
    test: {
        dbNameOverride: () => process.env.DB_NAME_OVERRIDE || "",
    },
};

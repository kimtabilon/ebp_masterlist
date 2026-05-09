/**
 * API endpoint authentication middleware (EBP-28).
 *
 * Requires a valid API key in the x-api-key header.
 * API key is configured via API_KEY env var.
 *
 * If no API_KEY is set, requests pass through (graceful degradation
 * during transition — validateEnv warns about this at startup).
 */

import { Request, Response, NextFunction } from "express";
import { config } from "../config/env";

let warnedNoKey = false;

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
    const configuredKey = config.auth.apiKey();

    // No API key configured — allow through (transition mode)
    if (!configuredKey) {
        if (!warnedNoKey) {
            console.warn("⚠️ [AUTH] No API_KEY configured — all requests allowed. Set API_KEY to enable authentication.");
            warnedNoKey = true;
        }
        next();
        return;
    }

    const providedKey = req.headers["x-api-key"] as string;

    if (!providedKey) {
        res.status(401).json({ error: "Missing x-api-key header" });
        return;
    }

    if (providedKey !== configuredKey) {
        res.status(401).json({ error: "Invalid API key" });
        return;
    }

    next();
}

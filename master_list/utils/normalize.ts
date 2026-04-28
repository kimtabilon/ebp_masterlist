/**
 * Shared normalization functions for SKU and UPC.
 * Import from here instead of defining locally to ensure consistency.
 */

export function cleanString(val: any): string {
    if (val === null || val === undefined) return "";
    let s = val.toString();
    s = s.replace(/["']/g, "");
    s = s.replace(/\s+/g, " ").trim();
    return s;
}

/**
 * Normalize SKU: strip non-alphanumeric chars, uppercase.
 * Consistent across combineData, productPipeline, and sku_packed.
 */
export function normalizeSku(sku: any): string {
    const cleaned = cleanString(sku);
    return cleaned.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

/**
 * Normalize UPC: keep digits only, remove leading zeros.
 * Returns null when no valid digits remain.
 */
export function normalizeUpc(raw: any): string | null {
    if (raw === null || raw === undefined) return null;
    const cleaned = cleanString(raw);
    if (!cleaned) return null;

    let upc = cleaned.replace(/[^0-9]/g, "");
    upc = upc.replace(/^0+/, "");
    return upc.length > 0 ? upc : null;
}

/**
 * Normalize manufacturer name for mapping lookups.
 * Lowercase, remove punctuation, collapse spaces.
 */
export function normalizeManufacturer(str: string): string {
    const cleaned = cleanString(str);
    if (!cleaned) return "";
    return cleaned
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

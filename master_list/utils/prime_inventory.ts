import axios from "axios";
import { getStockingBySku } from "./get_stocking";


function cleanString(val: any): string {
    if (val === null || val === undefined) return "";

    return String(val ?? "").replace(/[,\-\/#.\s]/g, "");
}

export const primeInventory = async (skuCode: string) => {

    const sku = cleanString(skuCode);

    try {
        const summary = await getStockingBySku(sku);

        if (summary.total === 0) {
            return {
                success: false,
                message: "SKU not found in w2g_live_inventory",
                total_inventory: 0,
                data: null
            };
        }

        const row = summary.data[0];

        // Extract numeric inventories
        const pa_inventory = Number(row.pa_inventory) || 0;
        const tx_inventory = Number(row.tx_inventory) || 0;
        const ky_inventory = Number(row.ky_inventory) || 0;
        const il_inventory = Number(row.il_inventory) || 0;
        const mw_inventory = Number(summary.data[0].mw_inventory) || 0;
        // Total merged inventory
        const total_inventory =
            mw_inventory +
            pa_inventory +
            tx_inventory +
            ky_inventory +
            il_inventory;


        const merged = {
            id: row.id,
            sku: row.sku,
            sku_original: sku,
            upc: row.upc ?? null,
            w2g_sku: row.w2g_sku ?? null,
            success: true,
            mw_inventory: mw_inventory,
            pa_inventory,
            tx_inventory,
            ky_inventory,
            il_inventory,

            total_inventory
        };

        return merged

    } catch (err: any) {
        return {
            success: false,
            total_inventory: -1,
            message: "Error generating SKU summary",
            error: err.message
        };
    }
};
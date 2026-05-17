import path from "path";
import XLSX from "xlsx";
import { Request, Response } from "express";
import { getDb } from "../../config/mongdodb.config";
import { config } from "../../config/env";

/* ============================
   Helpers
============================ */

function clean(val: any): string {
    if (val === null || val === undefined) return "";
    return String(val).trim();
}

function toNumber(val: any): number {
    const n = Number(val);
    return Number.isFinite(n) ? n : 0;
}

/* ============================
   Controller
============================ */

export const importAlmoRaw = async () => {
    try {
        const almoPath = config.paths.almoFile();
        const filePath = path.isAbsolute(almoPath) ? almoPath : path.join(process.cwd(), almoPath);

        console.log("Reading file:", filePath);

        const workbook = XLSX.readFile(filePath);

        const sheetName = "ALL"; // confirmed from your log
        const sheet = workbook.Sheets[sheetName];

        if (!sheet) {
            return
        }

        /* ============================
           FIX BROKEN EXCEL RANGE
        ============================= */

        const originalRange = sheet["!ref"] || "A1:A1";
        const decoded = XLSX.utils.decode_range(originalRange);

        // expand to 10k rows (safe buffer)
        decoded.e.r = 10000;

        sheet["!ref"] = XLSX.utils.encode_range(decoded);

        console.log("Expanded range:", sheet["!ref"]);

        const rows: any[] = XLSX.utils.sheet_to_json(sheet, {
            defval: null,
            raw: false,
            blankrows: false,
        });

        console.log("Total rows detected:", rows.length);

        if (!rows.length) {
            return
        }

        /* ============================
           DB Setup
        ============================= */

        const db = await getDb("master_list");
        const collection = db.collection("dist_almo_raw");

        // 🔥 Optional: wipe existing data
        await collection.deleteMany({});

        const BATCH_SIZE = 2000;
        let buffer: any[] = [];
        let inserted = 0;

        /* ============================
           Mapping + Insert
        ============================= */

        for (const row of rows) {
            const doc = {
                manufacturer: clean(row["Brand"]),
                sku: clean(row["Item"]),
                price: toNumber(row["Reg_Prc"]),     // ✅ Correct column name
                name: clean(row["Description"]),
                msrp: toNumber(row["MSRP"]),
                upc: clean(row["UPC_Code"]),

                // Inventory fields (kept as-is)
                OH: toNumber(row["OH"]),
                PA: toNumber(row["PA"]),
                NV: toNumber(row["NV"]),
                GA: toNumber(row["GA"]),
                AZ: toNumber(row["AZ"]),
                TX: toNumber(row["TX"]),
                WI: toNumber(row["WI"]),
                "PA-Cabot": toNumber(row["PA-Cabot"]),

                createdAt: new Date(),
            };

            buffer.push(doc);

            if (buffer.length >= BATCH_SIZE) {
                await collection.insertMany(buffer);
                inserted += buffer.length;
                buffer = [];
            }
        }

        if (buffer.length > 0) {
            await collection.insertMany(buffer);
            inserted += buffer.length;
        }

        console.log("=================================================");
        console.log("✔ ALMO IMPORT DONE");
        console.log("=================================================");

        return

    } catch (error: any) {
        console.error("ALMO IMPORT ERROR:", error);
        return
    }
};
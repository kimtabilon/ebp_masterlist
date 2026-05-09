import ftp from "basic-ftp";
import fs from "fs";
import dotenv from "dotenv";
import path from "path";
import Client from "ssh2-sftp-client";
import { config } from "../config/env";
dotenv.config();
const localBaseDir = path.join(process.cwd(), config.paths.rawDir());
if (!fs.existsSync(localBaseDir)) fs.mkdirSync(localBaseDir, { recursive: true });


async function downloadRaw() {

    try {
        const synnex = await downloadSynnex()
        console.log(synnex)
        const suppliesNet = await downloadSuppliesRaw()
        console.log(suppliesNet)
        const ingram = await downloadIngram()
        console.log(ingram)
        const dandh = await downloadDandHRaw()
        console.log(dandh)
        console.log("Donwloading Raw Files Finished")
    } catch (e: any) {
        return e
    }
}

async function downloadSynnex() {
    const client = new Client();

    try {
        console.log("Starting Synnex SFTP Download...");

        const localZipPath = path.join(localBaseDir, "synnex-pa.zip");
        const localCategoryPath = path.join(localBaseDir, "category_list.txt");

        const host = config.sftp.synnex.host();
        const user = config.sftp.synnex.user();
        const pass = config.sftp.synnex.pass();

        if (!host || !user || !pass) {
            throw new Error("Missing Synnex SFTP credentials in .env");
        }

        await client.connect({
            host,
            username: user,
            password: pass,
            port: 22,
        });

        console.log("Connected to Synnex SFTP server");

        // ⭐ 1. Download main ZIP file
        const remoteZip = "/617490.zip";  // adjust path if needed
        console.log(`➡️ Downloading ${remoteZip}`);
        await client.fastGet(remoteZip, localZipPath);

        // ⭐ 2. Download category file inside /stock folder
        const remoteCategoryFile = "/stock/category_list.txt";
        console.log(`➡️ Downloading ${remoteCategoryFile}`);
        await client.fastGet(remoteCategoryFile, localCategoryPath);

        await client.end();
        console.log("Synnex SFTP Download Complete");

        return "Download Finished for Synnex (SFTP)";
    } catch (error) {
        console.error(error);
        return "Error downloading Synnex raw file (SFTP): " + error;
    }
}



async function downloadSuppliesRaw() {
    try {
        const client = new Client();

        console.log("Starting Supplies Network SFTP Download");

        const remoteDir = "/EcommerceBusinessPrime/FromDM";
        const remoteFile = "4015068_PriceExport.CSV";
        const localCsvPath = path.join(localBaseDir, "4015068_PriceExport.CSV");

        const host = config.sftp.suppliesNetwork.host();
        const user = config.sftp.suppliesNetwork.user();
        const pass = config.sftp.suppliesNetwork.pass();

        if (!host || !user || !pass) {
            throw new Error("Missing Supplies Network SFTP credentials in .env");
        }

        await client.connect({
            host: host.trim(),
            port: 22,
            username: user.trim(),
            password: pass.trim(),
            tryKeyboard: true,
            readyTimeout: 30000,
        });
        await client.fastGet(
            `${remoteDir}/${remoteFile}`,
            localCsvPath
        );

        await client.end();

        return "Supplies Network raw file downloaded via SFTP";
    } catch (e) {
        return "Error Downloading Supplies Network raw file: " + e;
    }
}
async function downloadIngram() {
    try {
        console.log("Starting Download Fro Ingram RawFile")
        const client = new Client();
        const localFile = path.join(localBaseDir, "ingram-pa.zip");

        if (!fs.existsSync(localBaseDir)) fs.mkdirSync(localBaseDir, { recursive: true });

        const host = config.sftp.ingram.host();
        const user = config.sftp.ingram.user();
        const pass = config.sftp.ingram.pass();

        if (!host || !user || !pass) {
            throw new Error("Missing Ingram SFTP credentials in .env");
        }

        await client.connect({
            host,
            username: user,
            password: pass,
            port: 22,
        });

        console.log("📂 Connected to Ingram FTP server");

        const remoteFile = "PRICE.ZIP";
        console.log(`⬇️ Downloading ${remoteFile} to ${localFile} ...`);

        await client.fastGet(remoteFile, localFile); // ✔ correct

        console.log("✅ [Ingram] Download complete!");
        await client.end();

        return "✅ [Ingram] Download complete!";
    } catch (e) {
        return "Ingram Download Rawfile Error" + e
    }
}

async function downloadDandHRaw() {
    try {
        console.log("Start Downloading Dandh raw File")
        const localItemFile = path.join(localBaseDir, "dandh-pa");
        const localCatFile = path.join(localBaseDir, "CATLIST");
        const host = config.sftp.dandh.host();
        const user = config.sftp.dandh.user();
        const pass = config.sftp.dandh.pass();

        if (!host || !user || !pass) {
            throw new Error("Missing D&H SFTP credentials in .env");
        }

        const client = new Client();

        await client.connect({
            host,
            username: user,
            password: pass,
            port: 22,
        });

        console.log("📂 Connected to D&H FTP server");
        console.log("⬇️ Downloading ITEMLIST...");
        await client.fastGet("ITEMLIST", localItemFile);

        // Download CATLIST
        console.log("⬇️ Downloading CATLIST...");
        await client.fastGet("CATLIST", localCatFile);

        console.log("✅ [D&H] Both files downloaded successfully!");

        await client.end(); // 👈 explicitly close after successful downloads
        return "Download DandH Finished"
    } catch (e: any) {
        return "Failed To download Raw File Dandh " + e
    }
}

export default downloadRaw
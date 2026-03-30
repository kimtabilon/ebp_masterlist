import ftp from "basic-ftp";
import fs from "fs";
import dotenv from "dotenv";
import path from "path";
import Client from "ssh2-sftp-client";
dotenv.config();
const localBaseDir = path.join(process.cwd(), "master_list", "raw");
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

        if (
            !process.env.SYNNEX_FTP_USER ||
            !process.env.SYNNEX_FTP_PASS ||
            !process.env.SYNNEX_FTP_HOST
        ) {
            throw new Error("Missing Synnex SFTP credentials in .env");
        }

        // 🔐 CONNECT TO SFTP
        await client.connect({
            host: process.env.SYNNEX_FTP_HOST,
            username: process.env.SYNNEX_FTP_USER,
            password: process.env.SYNNEX_FTP_PASS,
            port: 22, // SFTP default port
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

        if (
            !process.env.SUPPLIESNETWORK_SFTP_HOST ||
            !process.env.SUPPLIESNETWORK_SFTP_USER ||
            !process.env.SUPPLIESNETWORK_SFTP_PASSWORD
        ) {
            throw new Error("Missing Supplies Network SFTP credentials in .env");
        }
        console.log(process.env.SUPPLIESNETWORK_SFTP_HOST,
            process.env.SUPPLIESNETWORK_SFTP_USER,
            process.env.SUPPLIESNETWORK_SFTP_PASSWORD)
        await client.connect({
            host: process.env.SUPPLIESNETWORK_SFTP_HOST!.trim(),
            port: 22,
            username: process.env.SUPPLIESNETWORK_SFTP_USER!.trim(),
            password: "o@z6#aAWX8vLc+g_--",

            tryKeyboard: true,

            // // 🔥 THIS IS THE IMPORTANT PART
            // onKeyboardInteractive: (name, instructions, instructionsLang, prompts, finish) => {
            //     finish([process.env.SUPPLIESNETWORK_SFTP_PASSWORD!.trim()]);
            // },

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

        const { INGRAM_SFTP_HOST, INGRAM_FTP_USER, INGRAM_FTP_PASS } = process.env;
        if (!INGRAM_SFTP_HOST || !INGRAM_FTP_USER || !INGRAM_FTP_PASS) {
            throw new Error("❌ Missing Ingram FTP credentials in .env");
        }
        await client.connect({
            host: INGRAM_SFTP_HOST,
            username: INGRAM_FTP_USER,
            password: INGRAM_FTP_PASS,
            port: 22,       // 🔁 Change to 22 if your server uses SFTP/FTPS on 22
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
        const { DANDH_SFTP_HOST, DANDH_FTP_USER, DANDH_FTP_PASS } = process.env;
        // Validate credentials
        if (!DANDH_SFTP_HOST || !DANDH_FTP_USER || !DANDH_FTP_PASS) {
            throw new Error("❌ Missing D&H FTP credentials in .env");
        }
        const client = new Client();

        await client.connect({
            host: DANDH_SFTP_HOST,
            username: DANDH_FTP_USER,
            password: DANDH_FTP_PASS,
            port: 22,       // Change to 22 if D&H uses SFTP/FTPS

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
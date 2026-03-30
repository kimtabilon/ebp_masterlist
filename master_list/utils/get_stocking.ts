import axios from "axios";

export async function getStockingBySku(sku: string) {
    const encodedSku = encodeURIComponent(sku); // 👈 important

    // const url = `https://ebpconsole.ecommercebusinessprime.com/stocking/${encodedSku}`;
    const url = `https://console.ecommercebusinessprime.com/api/w2g/stocking/${encodedSku}`;

    const res = await axios.get(url);
    return res.data;
}

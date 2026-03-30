import axios from "axios";

export async function getDistData(sku: string) {
    const encodedSku = encodeURIComponent(sku); // 👈 important

    const url = `https://ebpconsole.ecommercebusinessprime.com/api/v2/netsuite`;

    const res = await axios.get(url);
    return res.data;
}

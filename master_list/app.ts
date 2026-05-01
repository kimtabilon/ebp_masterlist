import express, { Application, Request, Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import MasterListRoute from "./routes/master_list.route";
import { requireApiKey } from "./middleware/auth";
const app: Application = express();
const allowedOrigins = [
    "https://envdev.ecommercebusinessprime.com",
    "https://console.ecommercebusinessprime.com",
    "http://localhost:5173",
    "http://localhost:1222",
];
const corsOptions = {
    origin: function (origin: any, callback: any) {
        // console.log(":fire: CORS Request from:", origin || "NO ORIGIN");
        // Allow no-origin requests automatically
        if (!origin)
            return callback(null, true);
        // Allow in development OR whitelisted domains
        if (process.env.PROD === "false" || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        // Otherwise block (IMPORTANT: must return!)
        return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
};
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions)); // <-- Handle preflight

app.use(cookieParser(process.env.COOKIE_TEXT));
// REQUIRED
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api/v3", requireApiKey, MasterListRoute);

export default app;

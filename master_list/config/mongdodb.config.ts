import mongoose, { Connection } from "mongoose";
import { config } from "./env";

let baseConnection: Connection | null = null;

export async function connectMongoBase(): Promise<Connection> {
  if (baseConnection) return baseConnection;

  const user = encodeURIComponent(config.mongo.user());
  const pass = encodeURIComponent(config.mongo.pass());
  const host = config.mongo.host();
  const port = config.mongo.port();
  const uri = `mongodb://${user}:${pass}@${host}:${port}/?authSource=admin`;

  const m = await mongoose.connect(uri);
  baseConnection = m.connection;
  return baseConnection;
}

export async function getDb(dbName: string) {
  const resolvedName = (dbName === "master_list" && config.test.dbNameOverride())
    ? config.test.dbNameOverride()
    : dbName;

  const baseConn = await connectMongoBase();
  const conn = baseConn.useDb(resolvedName, { useCache: true });

  if (!conn.db) throw new Error("Mongo DB not ready");
  return conn.db;
}

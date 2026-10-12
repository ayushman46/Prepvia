import "server-only";
import { MongoClient, type Db } from "mongodb";
import { config } from "./config";
import { ApiError } from "./http";
import { logger } from "./logger";

/**
 * Serverless-friendly MongoDB access.
 *
 * The client is cached on globalThis so warm Vercel instances (and Next.js dev
 * hot reloads) reuse one connection pool instead of opening a new one per request.
 */

type MongoCache = {
  client?: MongoClient;
  clientPromise?: Promise<MongoClient>;
  indexesPromise?: Promise<void>;
  uri?: string;
};

const globalForMongo = globalThis as typeof globalThis & { __interviewMongo?: MongoCache };
const cache: MongoCache = (globalForMongo.__interviewMongo ??= {});

async function connect(uri: string): Promise<MongoClient> {
  const client = new MongoClient(uri, {
    maxPoolSize: 10,
    minPoolSize: 0,
    maxIdleTimeMS: 60_000,
    serverSelectionTimeoutMS: 8_000,
    connectTimeoutMS: 10_000,
    appName: "interviewai",
  });
  await client.connect();
  return client;
}

export async function getDb(): Promise<Db> {
  const uri = config.mongo.uri;
  if (!uri) {
    throw new ApiError(503, "database_not_configured", "The database is not configured. Set MONGODB_URI.");
  }

  if (!cache.clientPromise || cache.uri !== uri) {
    cache.uri = uri;
    cache.indexesPromise = undefined;
    cache.clientPromise = connect(uri)
      .then((client) => {
        cache.client = client;
        return client;
      })
      .catch((error) => {
        // Allow the next request to retry instead of caching a failed connection forever.
        cache.clientPromise = undefined;
        logger.error("MongoDB connection failed", error);
        throw new ApiError(503, "database_unavailable", "The database is temporarily unavailable. Please try again.");
      });
  }

  const client = await cache.clientPromise;
  const db = client.db(config.mongo.dbName);

  if (!cache.indexesPromise) {
    cache.indexesPromise = ensureIndexes(db).catch((error) => {
      cache.indexesPromise = undefined;
      logger.warn("MongoDB index creation failed", error);
    });
  }
  await cache.indexesPromise;
  return db;
}

async function ensureIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection("transcripts").createIndex({ session_id: 1, timestamp: 1 }),
    // TTL clean-up keeps the free M0 cluster small and limits retention of candidate data.
    db.collection("sessions").createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
    db.collection("transcripts").createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
    db.collection("evaluations").createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
    db.collection("rate_limits").createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
  ]);
  try {
    await db.collection("evaluations").createIndex({ session_id: 1 }, { unique: true });
  } catch (error) {
    // Older deployments may contain duplicate evaluations; fall back to a plain index.
    logger.warn("Unique evaluations index unavailable; using non-unique index", error);
    await db.collection("evaluations").createIndex({ session_id: 1 });
  }
}

/** Lightweight connectivity probe for the health endpoint. */
export async function pingDb(): Promise<boolean> {
  const db = await getDb();
  await db.command({ ping: 1 });
  return true;
}

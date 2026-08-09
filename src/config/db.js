import mongoose from "mongoose";
import { env } from "./env.js";

let connectionPromise = null;

// Lazy + cached: opens the connection only the first time a route actually
// needs it, and reuses the same promise afterward instead of reconnecting
// per-request.
export function connectDB() {
  if (connectionPromise) return connectionPromise;

  if (mongoose.connection.readyState === 1) {
    connectionPromise = Promise.resolve(mongoose);
    return connectionPromise;
  }

  connectionPromise = mongoose.connect(env.mongodbUri, { dbName: env.mongodbDb });
  return connectionPromise;
}

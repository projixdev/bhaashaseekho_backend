// Spins up a fresh in-memory MongoDB per test file (each Jest test file gets
// its own module registry, so this and every model file get a fresh
// `mongoose` singleton too — no state leaks between files). Connecting here,
// before any route is hit, means config/db.js's connectDB() sees
// readyState === 1 immediately and never needs a real MONGODB_URI.
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

let mongod;

export async function connectTestDB() {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: "bhaashaseekho_test" });
}

export async function clearTestDB() {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
}

export async function disconnectTestDB() {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
}

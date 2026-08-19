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

  // Mongoose builds indexes (including unique ones — email, phone, the
  // Enrollment/Conversation compound keys) in the background by default.
  // Under Jest's parallel workers, several mongodb-memory-server instances
  // spinning up at once can leave that background build still in flight
  // when the file's very first write happens, so a uniqueness check that
  // should 409 silently succeeds instead (reproduced: profile.test.js's
  // duplicate-email test flaked exactly this way in a full-suite run, but
  // passed every time in isolation). Waiting for every model's indexes
  // here, once per file, makes that race impossible instead of hoping
  // individual tests run slowly enough to dodge it.
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
}

export async function clearTestDB() {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
}

export async function disconnectTestDB() {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
}

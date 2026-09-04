// Run once when the timezone feature ships. Every User created before the
// `timezone` field existed has no value stored — mongoose fills the schema
// default ("Asia/Kolkata") on hydrated docs, but the notification services
// read recipients with .lean() (services/notificationScope.js), which does
// NOT apply defaults, so an un-backfilled user reads back `undefined`. The
// formatters in utils/timezone.js already fall back to Asia/Kolkata for
// that, so this migration is belt-and-suspenders + makes the data explicit
// and queryable. Prints a count, writes nothing that isn't missing.
//
// Usage:
//   node scripts/backfillUserTimezone.js
import mongoose from "mongoose";
import { connectDB } from "../src/config/db.js";
import User from "../src/models/User.js";
import { DEFAULT_TIMEZONE } from "../src/utils/timezone.js";

async function main() {
  await connectDB();

  const missing = await User.countDocuments({ timezone: { $in: [null, ""] } });
  const result = await User.updateMany(
    { timezone: { $in: [null, ""] } },
    { $set: { timezone: DEFAULT_TIMEZONE } }
  );

  console.log(
    `Users missing a timezone: ${missing}. Set to "${DEFAULT_TIMEZONE}" for ${result.modifiedCount}.`
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exitCode = 1;
});

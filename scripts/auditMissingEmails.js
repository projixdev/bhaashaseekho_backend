// Admin-only tool — read-only audit, no writes. Lists every User who has no
// email on file, since OTP delivery is now email-only (ROADMAP.md Phase 16):
// anyone in this list cannot receive a login code until an admin re-runs
// scripts/createUser.js --phone <theirs> --email <address> for them.
//
// There's no automated backfill because we don't have real email addresses
// for pre-existing accounts to fill in — this script only reports who needs
// one, it doesn't invent one.
//
// Usage:
//   node scripts/auditMissingEmails.js
import mongoose from "mongoose";
import { connectDB } from "../src/config/db.js";
import User from "../src/models/User.js";

async function main() {
  await connectDB();

  const missing = await User.find({ email: { $exists: false } })
    .sort({ role: 1, createdAt: 1 })
    .lean();

  const total = await User.countDocuments({});

  if (missing.length === 0) {
    console.log(`All ${total} user(s) have an email on file. Nothing to backfill.`);
    await mongoose.disconnect();
    return;
  }

  console.log(`${missing.length} of ${total} user(s) have no email on file and cannot receive OTPs:\n`);

  const byRole = missing.reduce((acc, u) => {
    (acc[u.role] ??= []).push(u);
    return acc;
  }, {});

  for (const role of Object.keys(byRole).sort()) {
    console.log(`${role} (${byRole[role].length}):`);
    for (const u of byRole[role]) {
      console.log(`  ${u.name || "(no name)"} — ${u.phone} — id ${u._id}`);
    }
    console.log("");
  }

  console.log("Backfill each with:");
  console.log('  node scripts/createUser.js --phone <phone> --name "<name>" --role <role> --email <address>');

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exitCode = 1;
});

// Admin-only tool — flips isAdmin on a teacher's User doc (ROADMAP.md Phase
// 15: "the founder is a teacher account with isAdmin: true, not a separate
// role"). No account is marked this way by default; this is the only way
// one gets created, since it's a real privilege escalation and shouldn't be
// guessable or automatic.
//
// Usage:
//   node scripts/setAdmin.js --phone 9876543210
//   node scripts/setAdmin.js --phone 9876543210 --revoke
import mongoose from "mongoose";
import { connectDB } from "../src/config/db.js";
import User from "../src/models/User.js";
import { normalizePhone, PHONE_DIGITS_RE } from "../src/utils/validation.js";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.phone) {
    console.error("Usage: node scripts/setAdmin.js --phone <digits> [--revoke]");
    process.exitCode = 1;
    return;
  }

  const phone = normalizePhone(args.phone);
  if (!PHONE_DIGITS_RE.test(phone)) {
    console.error(`Invalid phone number: ${args.phone}`);
    process.exitCode = 1;
    return;
  }

  await connectDB();

  const user = await User.findOne({ phone });
  if (!user) {
    console.error(`No user found with phone ${args.phone}. Create the account first (scripts/createUser.js).`);
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }
  if (user.role !== "teacher") {
    console.error(`${user.name || user.phone} is a ${user.role}, not a teacher — the founder model requires a teacher account.`);
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }

  user.isAdmin = !args.revoke;
  await user.save();

  console.log(`${user.name || "(no name)"} (${user.phone}) isAdmin is now ${user.isAdmin}.`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exitCode = 1;
});

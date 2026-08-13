// Admin-only tool — sets (or changes) the password used by POST
// /api/admin/login for the website dashboard (ROADMAP.md Phase 17). Kept
// separate from isAdmin (scripts/setAdmin.js) on purpose — the login route
// rejects on isAdmin regardless of password, so this script requires the
// target to already be an admin rather than silently granting it.
//
// Usage:
//   node scripts/setAdminPassword.js --phone 9876543210 --password "correct horse battery staple"
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { connectDB } from "../src/config/db.js";
import User from "../src/models/User.js";
import { normalizePhone, PHONE_DIGITS_RE } from "../src/utils/validation.js";

const BCRYPT_COST = 12;
const MIN_PASSWORD_LENGTH = 8;

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

  if (!args.phone || !args.password) {
    console.error('Usage: node scripts/setAdminPassword.js --phone <digits> --password "<new password>"');
    process.exitCode = 1;
    return;
  }

  const password = String(args.password);
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
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
  if (!user.isAdmin) {
    console.error(
      `${user.name || user.phone} is not an admin — run scripts/setAdmin.js --phone ${args.phone} first.`
    );
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }
  if (!user.email) {
    console.error(
      `${user.name || user.phone} has no email on file — POST /api/admin/login looks up by email, so this password would be unusable. Add one first (scripts/createUser.js --phone ${args.phone} --email <address>).`
    );
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }

  user.password = await bcrypt.hash(password, BCRYPT_COST);
  await user.save();

  console.log(`Password set for ${user.name || user.phone} <${user.email}>. Log in at /admin/login with that email.`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exitCode = 1;
});

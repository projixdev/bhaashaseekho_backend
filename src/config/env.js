import dotenv from "dotenv";

// quiet: true suppresses dotenv's own console output (as of v17 it logs a
// promotional "tip" line on every load) — unrelated to our own logging.
dotenv.config({ quiet: true });

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// Read lazily via getters where a var is only needed by a specific feature
// (Brevo, WhatsApp) so the process can boot even if that feature's env vars
// aren't set yet — the failure surfaces when the feature is actually used,
// same behavior as the Next.js lib/mongodb.js and lib/brevo.js originals.
export const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT) || 4000,
  // Trailing slash trimmed: the CORS middleware echoes this string verbatim
  // as the Access-Control-Allow-Origin response header, which browsers only
  // accept if it matches the request's Origin header exactly — and Origin
  // headers never have a trailing slash.
  corsOrigin: (process.env.CORS_ORIGIN || "*").trim().replace(/\/+$/, ""),

  get mongodbUri() {
    return required("MONGODB_URI");
  },
  mongodbDb: process.env.MONGODB_DB,

  // Signs both the mobile app's session JWT and the OTP HMAC (see
  // utils/otp.js) — only needed once auth routes are actually hit.
  get jwtSecret() {
    return required("JWT_SECRET");
  },

  clientNotificationEmail: process.env.CLIENT_NOTIFICATION_EMAIL,

  brevoApiKey: process.env.BREVO_API_KEY,
  brevoSenderEmail: process.env.BREVO_SENDER_EMAIL,

  whatsappNumber: process.env.WHATSAPP_NUMBER,

  // App store reviewer / demo-account test-login bypass (see
  // authController.js's isReviewerPhone/sendOtp/verifyOtp). Optional -- both
  // must be set together for the bypass to ever activate; the app works
  // fine with neither configured. Getters (not plain assignments) so tests
  // can set process.env.REVIEWER_TEST_PHONE/OTP per-describe-block and have
  // it take effect immediately, same as they'd behave in a real deploy.
  //
  // REVIEWER_TEST_PHONE holds one or more phone numbers, comma-separated
  // (e.g. "8147777707,9876512340") -- every listed number shares the one
  // REVIEWER_TEST_OTP. This is how a Play Store reviewer's student demo
  // account and an Apple reviewer's teacher demo account can both sign in
  // with the same fixed code without needing a second OTP var per account.
  // isReviewerPhone doesn't care which role a given phone's real User
  // document is -- verifyOtp's bypass branch already reads role off that
  // document rather than assuming "student", so adding a teacher number
  // here needs no other code change, only the User document to exist.
  get reviewerTestPhone() {
    // Singular, first-listed number -- unchanged shape for
    // scripts/seedReviewerAccount.js and anything else expecting exactly
    // one primary reviewer phone rather than the full list.
    return this.reviewerTestPhones[0] || "";
  },
  get reviewerTestPhones() {
    return (process.env.REVIEWER_TEST_PHONE || "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
  },
  get reviewerTestOtp() {
    return process.env.REVIEWER_TEST_OTP || "";
  },

  // Homework/assessment file uploads — only needed once the assignments
  // submit route is actually hit.
  get cloudinaryCloudName() {
    return required("CLOUDINARY_CLOUD_NAME");
  },
  get cloudinaryApiKey() {
    return required("CLOUDINARY_API_KEY");
  },
  get cloudinaryApiSecret() {
    return required("CLOUDINARY_API_SECRET");
  },

  // Google Calendar (Phase 19 — Meet link generation), service-account auth,
  // only needed once a class is actually scheduled. Private keys copied from
  // a downloaded service-account JSON file have real "\n" escape sequences
  // once they pass through a .env value (env vars can't hold literal
  // newlines) — swapped back to real newlines here, the standard fix for
  // this exact googleapis/JWT gotcha.
  get googleServiceAccountEmail() {
    return required("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  },
  get googleServiceAccountPrivateKey() {
    return required("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY").replace(/\\n/g, "\n");
  },
  get googleCalendarId() {
    return required("GOOGLE_CALENDAR_ID");
  },
  // The real Google Workspace user the service account impersonates via
  // domain-wide delegation — required specifically for Meet conference
  // creation (calendar.events.insert/patch/delete work fine as the bare
  // service account identity; Google rejects hangoutsMeet conferenceData
  // from an unimpersonated service account with "Invalid conference type
  // value" regardless of calendar-sharing permissions). Must be a real user
  // in the same Workspace as the delegation grant, not just any address.
  get googleWorkspaceUserEmail() {
    return required("GOOGLE_WORKSPACE_USER_EMAIL");
  },
};

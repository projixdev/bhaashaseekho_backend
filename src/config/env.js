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
};

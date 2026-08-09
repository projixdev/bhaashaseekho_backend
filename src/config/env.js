import dotenv from "dotenv";

dotenv.config();

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
  corsOrigin: process.env.CORS_ORIGIN || "*",

  get mongodbUri() {
    return required("MONGODB_URI");
  },
  mongodbDb: process.env.MONGODB_DB,

  clientNotificationEmail: process.env.CLIENT_NOTIFICATION_EMAIL,

  brevoApiKey: process.env.BREVO_API_KEY,
  brevoSenderEmail: process.env.BREVO_SENDER_EMAIL,

  whatsappNumber: process.env.WHATSAPP_NUMBER,
};

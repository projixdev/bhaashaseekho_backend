// Runs before every test file imports anything. Fixed dummy values, not
// read from the real .env — guarantees tests never depend on (or can leak
// into) real Brevo/Cloudinary/Mongo credentials, and behave identically in
// CI where no .env exists. MONGODB_URI/MONGODB_DB are placeholders: the real
// connection is made directly to mongodb-memory-server in tests/helpers/db.js,
// and config/db.js's connectDB() short-circuits once that connection exists
// (readyState === 1) without ever reading these.
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-only-jwt-secret-do-not-use-in-production";
process.env.MONGODB_URI = "mongodb://127.0.0.1:0/unused";
process.env.MONGODB_DB = "bhaashaseekho_test";
process.env.CORS_ORIGIN = "*";
process.env.PORT = "0";
process.env.BREVO_API_KEY = "test-disabled";
process.env.BREVO_SENDER_EMAIL = "test@example.com";
process.env.CLIENT_NOTIFICATION_EMAIL = "owner@example.com";
process.env.CLOUDINARY_CLOUD_NAME = "test-disabled";
process.env.CLOUDINARY_API_KEY = "test-disabled";
process.env.CLOUDINARY_API_SECRET = "test-disabled";

import { v2 as cloudinary } from "cloudinary";
import { env } from "./env.js";

let configured = false;

// Lazy-configured, same pattern as connectDB — only touches env vars (and
// therefore only throws if they're missing) once a route actually needs it.
export function getCloudinary() {
  if (!configured) {
    cloudinary.config({
      cloud_name: env.cloudinaryCloudName,
      api_key: env.cloudinaryApiKey,
      api_secret: env.cloudinaryApiSecret,
      secure: true,
    });
    configured = true;
  }
  return cloudinary;
}

// Uploads a buffer (from multer's memory storage) via Cloudinary's stream
// API — avoids writing the file to disk first. resource_type: "auto" lets
// Cloudinary handle both images (homework photos) and raw files (PDFs).
export function uploadBuffer(buffer, { folder }) {
  const cloudinaryClient = getCloudinary();
  return new Promise((resolve, reject) => {
    const stream = cloudinaryClient.uploader.upload_stream(
      { folder, resource_type: "auto" },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    stream.end(buffer);
  });
}

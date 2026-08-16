import mongoose from "mongoose";
import { connectDB } from "../src/config/db.js";
import User from "../src/models/User.js";
await connectDB();
const u = await User.findOne({ email: "kalyan3081@gmail.com" }).select("+password").lean();
console.log("password field present:", "password" in u);
console.log("value looks like a bcrypt hash:", typeof u.password === "string" && u.password.startsWith("$2"));
await mongoose.disconnect();

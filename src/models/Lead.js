import mongoose from "mongoose";

const LeadSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String, required: true, trim: true, maxlength: 20 },
    // Optional: phone is the primary follow-up channel for leads.
    email: { type: String, trim: true, lowercase: true, maxlength: 160, default: "" },
    // interest is a plain string, not a schema enum: the option list lives in
    // the website's content.js and can change without a schema migration.
    // Validity is checked at the API layer (utils/validation.js) instead.
    interest: { type: String, required: true, trim: true },
    utmSource: { type: String, trim: true, default: "" },
    utmMedium: { type: String, trim: true, default: "" },
    utmCampaign: { type: String, trim: true, default: "" },
    // Set only by the app's "Request this course" flow (an enrolled student
    // asking for an additional course) — stored loosely, same reasoning as
    // Enrollment.courseSlug: course content lives in the website repo, not
    // this database, so no foreign-key/enum here either.
    courseSlug: { type: String, trim: true, lowercase: true, default: "" },
    // Only set when the submission came in authenticated (the app, not the
    // public website form) — lets admin jump straight to the existing
    // account instead of matching on phone/email by hand.
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

// Guards against OverwriteModelError if this module is re-evaluated (e.g.
// under --watch) without the process restarting.
export default mongoose.models.Lead || mongoose.model("Lead", LeadSchema);

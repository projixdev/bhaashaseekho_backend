const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function requiredString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateLeadInput(body) {
  const errors = {};

  if (!requiredString(body.name)) errors.name = "Name is required.";
  if (!requiredString(body.phone)) errors.phone = "Phone number is required.";
  // Email is optional on the lead form (phone is the primary follow-up
  // channel) — only validate format when the visitor actually provided one.
  if (requiredString(body.email) && !EMAIL_RE.test(body.email.trim())) {
    errors.email = "Please enter a valid email address.";
  }
  if (!requiredString(body.interest)) errors.interest = "Please select what you're interested in.";

  return { valid: Object.keys(errors).length === 0, errors };
}

// /contact is a lightweight support form — only name + email are required;
// the message is explicitly optional (WhatsApp is the primary contact path).
export function validateContactInput(body) {
  const errors = {};

  if (!requiredString(body.name)) errors.name = "Name is required.";
  if (!requiredString(body.email) || !EMAIL_RE.test(body.email.trim())) {
    errors.email = "A valid email address is required.";
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

// Minimal HTML-escaping for values interpolated into notification emails —
// prevents a malicious form submission from injecting markup into the email
// Brevo sends to the client's inbox.
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

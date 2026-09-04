import { DateTime, IANAZone } from "luxon";

// The historical single-timezone assumption, and still the right guess for a
// user who hasn't sent their device zone yet (existing accounts, an old app
// build). Every formatter below falls back to this for a null/invalid zone,
// so a missing User.timezone can never throw or render "Invalid DateTime".
export const DEFAULT_TIMEZONE = "Asia/Kolkata";

// Returns the string only if it's a real IANA zone ("America/New_York",
// "Asia/Calcutta", …), else null. Used to sanitize whatever the app sends
// up from Intl.DateTimeFormat().resolvedOptions().timeZone before it's
// stored — the app derives it from the device, so a bad value means a
// client bug, not user input, and is dropped rather than rejected.
export function normalizeTimezone(value) {
  return typeof value === "string" && IANAZone.isValidZone(value) ? value : null;
}

function inZone(date, timezone) {
  return DateTime.fromJSDate(new Date(date))
    .setZone(normalizeTimezone(timezone) ?? DEFAULT_TIMEZONE)
    .setLocale("en-IN");
}

// "15 Aug 2026, 6:00 pm" in the given zone — matches the format the class
// notifications used before this was per-recipient (Intl "en-IN" medium
// date + short time), so IST users' notification copy is byte-identical.
export function formatDateTimeInZone(date, timezone) {
  return inZone(date, timezone).toLocaleString(DateTime.DATETIME_MED);
}

// "15/8/2026" in the given zone — matches the old assignment due-date text.
export function formatDateInZone(date, timezone) {
  return inZone(date, timezone).toLocaleString(DateTime.DATE_SHORT);
}

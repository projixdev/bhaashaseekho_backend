// Mirrors bhaashaseekho_website/data/enrollmentCourses.js's taxonomy (3
// languages x 4 sub-courses = 12 courseSlug values) and the app's own
// src/lib/courseTaxonomy.ts — kept in sync by hand across all three repos,
// same reasoning as Enrollment.courseSlug's own comment already documents
// (course content lives in the website repo, not this database).
const LANGUAGES = ["kannada", "hindi", "telugu"];
const SUB_COURSE_KEYS = ["speaking", "reading-writing", "academics", "competitive-exams"];

export const COURSE_SLUGS = LANGUAGES.flatMap((lang) => SUB_COURSE_KEYS.map((key) => `${lang}-${key}`));

export function isValidCourseSlug(slug) {
  return COURSE_SLUGS.includes(slug);
}

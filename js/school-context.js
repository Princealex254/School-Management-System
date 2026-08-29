/**
 * ============================================================
 * ShuleSmart — School Context
 * ============================================================
 * Exposes the authenticated School Admin's school for DISPLAY and
 * convenience only (header branding, forms, filters).
 *
 * SECURITY: The backend independently determines the admin's
 * school_id from the Firebase UID. Values here are never sent to
 * the API as authorization or tenant selection.
 * ============================================================
 */

export function getCurrentSchool() {
  return window.currentSchool || null;
}

export function getCurrentAdmin() {
  return window.currentAdmin || null;
}

export function getSchoolDisplay() {
  const school = getCurrentSchool();
  if (!school) return { name: "ShuleSmart", code: "", logo_key: "" };
  return school;
}
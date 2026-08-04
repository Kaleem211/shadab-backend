/* =========================================================
   CAMPUS EMAIL VALIDATION
   Only accounts with a genuine RGUKT Ongole college email
   (anything@rguktong.ac.in, case-insensitive) may sign up.

   - Other RGUKT campuses (RK Valley, Nuzvid, Srikakulam, and
     the shared rgukt.ac.in domain) are recognised explicitly so
     we can tell that user their campus isn't served here, rather
     than lumping them in with "not a college email".
   - Everything else (gmail.com, yahoo.com, other colleges, etc.)
     is treated as a personal / unrecognised email.
   ========================================================= */

const ALLOWED_DOMAIN = "rguktong.ac.in";

// Sibling RGUKT campuses this site does not serve.
const OTHER_CAMPUS_DOMAINS = [
  "rguktrkv.ac.in",   // RK Valley
  "rguktn.ac.in",     // Nuzvid
  "rguktsklm.ac.in",  // Srikakulam
  "rgukt.ac.in",      // shared/base domain
];

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validates an email against the college-only policy.
 * Returns { ok: true } if acceptable, or
 * { ok: false, code, error } describing why not.
 */
function validateCampusEmail(rawEmail) {
  const email = String(rawEmail || "").trim().toLowerCase();

  if (!EMAIL_SHAPE.test(email)) {
    return { ok: false, code: "invalid_format", error: "Enter a valid email address." };
  }

  const domain = email.split("@")[1] || "";

  if (domain === ALLOWED_DOMAIN) {
    return { ok: true, email };
  }

  if (OTHER_CAMPUS_DOMAINS.includes(domain)) {
    return {
      ok: false,
      code: "wrong_campus",
      error:
        "Delivery isn't available at your campus yet — this service currently runs only for RGUKT Ongole. Thanks for exploring us!",
    };
  }

  return {
    ok: false,
    code: "personal_email",
    error: "Personal emails aren't valid here. Please enter your college email ID (yourid@rguktong.ac.in).",
  };
}

module.exports = { validateCampusEmail, ALLOWED_DOMAIN, OTHER_CAMPUS_DOMAINS };

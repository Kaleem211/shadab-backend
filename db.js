const admin = require("firebase-admin");
const fs = require("fs");

/* =========================================================
   FIREBASE ADMIN INIT
   Needs one of two things to be configured on the host (Render):

   OPTION A — Secret File (Render → Environment → Secret Files):
     Filename: firebase-service-account.json
     Contents: your full Firebase service account JSON

   OPTION B — Environment Variable (Render → Environment → Env Vars):
     Key:   FIREBASE_SERVICE_ACCOUNT_JSON
     Value: the full service account JSON, pasted as a single line

   Option B is usually simpler to set up than a secret file, so it's
   tried first. If neither is present, the server used to hard-crash
   on boot with a raw ENOENT stack trace and no explanation — now it
   logs a clear, actionable error instead.
   ========================================================= */

const SECRET_FILE_PATH = "/etc/secrets/firebase-service-account.json";

function loadServiceAccount() {
  const inlineJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (inlineJson) {
    try {
      return JSON.parse(inlineJson);
    } catch (e) {
      throw new Error(
        "FIREBASE_SERVICE_ACCOUNT_JSON is set but isn't valid JSON. " +
        "Make sure you pasted the ENTIRE service account file contents as one line."
      );
    }
  }

  if (fs.existsSync(SECRET_FILE_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(SECRET_FILE_PATH, "utf8"));
    } catch (e) {
      throw new Error(
        `Found ${SECRET_FILE_PATH} but couldn't parse it as JSON: ${e.message}`
      );
    }
  }

  throw new Error(
    "No Firebase credentials found. Set one of:\n" +
    "  1) Render -> Environment -> Secret Files -> add 'firebase-service-account.json'\n" +
    "     with your Firebase service account JSON as its contents, OR\n" +
    "  2) Render -> Environment -> Environment Variables -> add\n" +
    "     FIREBASE_SERVICE_ACCOUNT_JSON with the same JSON as its value.\n" +
    "Without this, the server cannot start because every route needs Firestore."
  );
}

let db;
try {
  const serviceAccount = loadServiceAccount();
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }
  db = admin.firestore();
  console.log("[db] Firebase Admin initialized successfully.");
} catch (err) {
  console.error("========================================================");
  console.error("[db] FATAL: Firebase Admin failed to initialize.");
  console.error(err.message);
  console.error("========================================================");
  // Re-throw so this still fails fast and loudly (Render will show this
  // exact message in the Logs tab, instead of a bare ENOENT trace), but
  // now the fix is spelled out instead of left for you to guess.
  throw err;
}

module.exports = db;

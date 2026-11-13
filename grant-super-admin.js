/**
 * One-time provisioning of the FIRST Super Admin. Run on your own computer
 * with a service-account key that never leaves it (never commit or upload it):
 *
 *   npm install firebase-admin
 *   set GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\serviceAccountKey.json   (Windows)
 *   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccountKey.json  (Mac/Linux)
 *   node grant-super-admin.js you@example.com
 *
 * The account must already exist (sign up in the normal app first).
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "trade-buddy-25dee" });

(async () => {
  const email = (process.argv[2] || "").trim().toLowerCase();
  if (!email) { console.error("Usage: node grant-super-admin.js <email>"); process.exit(1); }
  const u = await admin.auth().getUserByEmail(email);
  await admin.auth().setCustomUserClaims(u.uid, Object.assign({}, u.customClaims || {}, { role: "super_admin" }));
  await admin.auth().revokeRefreshTokens(u.uid);
  await admin.firestore().collection("admin_roles").doc(u.uid).set({ email, role: "super_admin", by: "provisioning-script", at: admin.firestore.FieldValue.serverTimestamp() });
  console.log("Done. " + email + " is now a Super Admin. Sign out and sign in again at /admin/login.html.");
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });

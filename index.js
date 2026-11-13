"use strict";
/**
 * Trade Buddy admin backend (Firebase Cloud Functions v2, callable).
 * Roles live in Firebase Auth CUSTOM CLAIMS (token.role), assigned only here
 * or by scripts/grant-super-admin.js using the Admin SDK. Clients cannot
 * write claims, and no Firestore document a user controls grants access.
 */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
admin.initializeApp();
const db = admin.firestore();
const { FieldValue } = admin.firestore;

const ROLES = ["super_admin", "admin", "support"];
const ALL = ROLES, ADM = ["super_admin", "admin"], SA = ["super_admin"];
const OPTS = { cors: true, maxInstances: 10 };

function need(req, allowed) {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const r = req.auth.token.role;
  if (!allowed.includes(r)) throw new HttpsError("permission-denied", "You don't have permission for this action.");
  return r;
}
async function audit(req, action, target, details, status) {
  await db.collection("admin_audit_logs").add({
    ts: FieldValue.serverTimestamp(), adminUid: req.auth.uid, adminEmail: req.auth.token.email || "",
    role: req.auth.token.role || "", action, target: target || "", details: details || {}, status
  });
}
/** Runs fn after the role check and always writes an audit entry (success or failure). */
async function guarded(req, allowed, action, target, fn) {
  need(req, allowed);
  try {
    const out = await fn();
    await audit(req, action, target, out.audit, "success");
    return out.result;
  } catch (e) {
    await audit(req, action, target, { error: String(e.message || e).slice(0, 200) }, "failure").catch(() => {});
    throw e;
  }
}
function slim(u, role) {
  return {
    uid: u.uid, email: u.email || "", name: u.displayName || "", disabled: !!u.disabled, verified: !!u.emailVerified,
    created: Date.parse(u.metadata.creationTime) || 0, lastSignIn: Date.parse(u.metadata.lastSignInTime) || 0,
    role: (u.customClaims && u.customClaims.role) || role || ""
  };
}

/* ---------- login / logout audit (any admin role) ---------- */
exports.logAdminEvent = onCall(OPTS, async (req) => {
  need(req, ALL);
  const a = req.data && req.data.action;
  if (!["admin_login", "admin_logout"].includes(a)) throw new HttpsError("invalid-argument", "Unknown event.");
  await audit(req, a, "", {}, "success");
  return { ok: true };
});

/* ---------- user statistics straight from Firebase Auth (cached 5 min) ---------- */
exports.getAuthStats = onCall(OPTS, async (req) => {
  need(req, ALL);
  const ref = db.collection("admin_stats").doc("summary");
  const cached = await ref.get();
  if (cached.exists && Date.now() - cached.data().at < 300000) return cached.data().data;
  const now = Date.now(), DAY = 864e5, startOfDay = new Date(new Date().toISOString().slice(0, 10)).getTime();
  const s = { total: 0, today: 0, week: 0, month: 0, active1: 0, active7: 0, active30: 0, disabled: 0, returning: 0, signups: {} };
  let token;
  do {
    const page = await admin.auth().listUsers(1000, token);
    for (const u of page.users) {
      const c = Date.parse(u.metadata.creationTime) || 0, l = Date.parse(u.metadata.lastSignInTime) || 0;
      s.total++; if (u.disabled) s.disabled++;
      if (c >= startOfDay) s.today++; if (c >= now - 7 * DAY) s.week++; if (c >= now - 30 * DAY) s.month++;
      if (l >= now - DAY) s.active1++; if (l >= now - 7 * DAY) s.active7++; if (l >= now - 30 * DAY) s.active30++;
      if (l - c > DAY) s.returning++;
      if (c >= now - 90 * DAY) { const k = new Date(c).toISOString().slice(0, 10); s.signups[k] = (s.signups[k] || 0) + 1; }
    }
    token = page.pageToken;
  } while (token);
  await ref.set({ at: now, data: s });
  return s;
});

/* ---------- user list (50 at a time, or exact-email lookup) ---------- */
exports.listAuthUsers = onCall(OPTS, async (req) => {
  need(req, ALL);
  const d = req.data || {};
  if (d.email) {
    try { return { users: [slim(await admin.auth().getUserByEmail(String(d.email).trim()))], next: null }; }
    catch (e) { return { users: [], next: null }; }
  }
  const max = Math.min(Math.max(parseInt(d.max, 10) || 50, 1), 100);
  const page = await admin.auth().listUsers(max, d.pageToken || undefined);
  return { users: page.users.map((u) => slim(u)), next: page.pageToken || null };
});

/* ---------- suspend / reactivate ---------- */
exports.setUserSuspended = onCall(OPTS, async (req) => {
  const uid = String((req.data && req.data.uid) || ""), susp = !!(req.data && req.data.suspended);
  if (!uid) throw new HttpsError("invalid-argument", "Missing user.");
  return guarded(req, ADM, susp ? "user_suspended" : "user_reactivated", uid, async () => {
    if (uid === req.auth.uid) throw new HttpsError("failed-precondition", "You can't suspend yourself.");
    const target = await admin.auth().getUser(uid);
    const trole = target.customClaims && target.customClaims.role;
    if (trole && req.auth.token.role !== "super_admin") throw new HttpsError("permission-denied", "Only a Super Admin can suspend administrators.");
    await admin.auth().updateUser(uid, { disabled: susp });
    if (susp) await admin.auth().revokeRefreshTokens(uid);
    await db.collection("user_status").doc(uid).set({ suspended: susp, by: req.auth.uid, at: FieldValue.serverTimestamp() });
    await db.collection("admin_stats").doc("summary").delete().catch(() => {});
    return { result: { ok: true }, audit: { email: target.email || "" } };
  });
});

/* ---------- admin roles (Super Admin only) ---------- */
exports.setAdminRole = onCall(OPTS, async (req) => {
  const email = String((req.data && req.data.email) || "").trim().toLowerCase(), role = req.data ? req.data.role : null;
  if (!email) throw new HttpsError("invalid-argument", "Enter an email.");
  if (role !== null && !ROLES.includes(role)) throw new HttpsError("invalid-argument", "Unknown role.");
  return guarded(req, SA, role ? "role_granted" : "role_removed", email, async () => {
    let u; try { u = await admin.auth().getUserByEmail(email); } catch (e) { throw new HttpsError("not-found", "No account exists with that email."); }
    if (u.uid === req.auth.uid) throw new HttpsError("failed-precondition", "You can't change your own role.");
    const claims = Object.assign({}, u.customClaims || {});
    if (role) claims.role = role; else delete claims.role;
    await admin.auth().setCustomUserClaims(u.uid, claims);
    await admin.auth().revokeRefreshTokens(u.uid);
    if (role) await db.collection("admin_roles").doc(u.uid).set({ email, role, by: req.auth.uid, at: FieldValue.serverTimestamp() });
    else await db.collection("admin_roles").doc(u.uid).delete();
    return { result: { ok: true, uid: u.uid }, audit: { role: role || "none" } };
  });
});

/* ---------- platform settings (Super Admin only) ---------- */
exports.setPlatformSettings = onCall(OPTS, async (req) => {
  const d = req.data || {}, KEYS = ["journal", "setups", "analytics", "calculators", "connections", "premium"];
  const features = {}; KEYS.forEach((k) => { features[k] = !(d.features && d.features[k] === false); });
  const next = { maintenance: !!d.maintenance, registration: d.registration !== false, features };
  return guarded(req, SA, "platform_settings_changed", "platform_settings/main", async () => {
    const ref = db.collection("platform_settings").doc("main"), prev = (await ref.get()).data() || {};
    await ref.set(Object.assign({}, next, { updatedAt: FieldValue.serverTimestamp(), updatedBy: req.auth.uid }));
    if (!!prev.maintenance !== next.maintenance) await audit(req, next.maintenance ? "maintenance_enabled" : "maintenance_disabled", "platform_settings/main", {}, "success");
    return { result: { ok: true }, audit: { maintenance: next.maintenance, features } };
  });
});

/* ---------- announcements / FAQ / help content (+ optional broadcast) ---------- */
exports.saveContent = onCall(Object.assign({}, OPTS, { timeoutSeconds: 300, memory: "512MiB" }), async (req) => {
  const d = req.data || {};
  const type = ["announcement", "faq", "help"].includes(d.type) ? d.type : null, status = ["draft", "published", "unpublished"].includes(d.status) ? d.status : null;
  const title = String(d.title || "").trim().slice(0, 120), body = String(d.body || "").trim().slice(0, 2000);
  if (!type || !status || !title || !body) throw new HttpsError("invalid-argument", "Check the type, status, title and body.");
  return guarded(req, ADM, d.id ? "content_updated" : "content_created", title, async () => {
    const col = db.collection("platform_content"), ref = d.id ? col.doc(String(d.id)) : col.doc();
    const prev = d.id ? (await ref.get()).data() : null;
    const data = { type, status, title, body, updatedAt: FieldValue.serverTimestamp(), updatedBy: req.auth.uid };
    if (!prev) data.createdAt = FieldValue.serverTimestamp();
    if (status === "published" && (!prev || prev.status !== "published")) data.publishedAt = FieldValue.serverTimestamp();
    let recipients = 0;
    if (d.broadcast && type === "announcement" && status === "published" && !(prev && prev.broadcastAt)) {
      let last = null;
      for (;;) {
        let q = db.collection("users").orderBy(admin.firestore.FieldPath.documentId()).limit(400);
        if (last) q = q.startAfter(last);
        const snap = await q.get(); if (snap.empty) break;
        const b = db.batch();
        snap.docs.forEach((u) => b.set(u.ref.collection("notifications").doc(), { t: title, m: body, read: false, createdAt: FieldValue.serverTimestamp() }));
        await b.commit(); recipients += snap.size; last = snap.docs[snap.docs.length - 1];
        if (snap.size < 400) break;
      }
      data.broadcastAt = FieldValue.serverTimestamp();
      await db.collection("admin_broadcasts").add({ ts: FieldValue.serverTimestamp(), title, adminEmail: req.auth.token.email || "", recipients });
      await audit(req, "announcement_broadcast", title, { recipients }, "success");
    }
    await ref.set(data, { merge: true });
    return { result: { ok: true, id: ref.id }, audit: { type, status, recipients } };
  });
});

/* ---------- broker / prop firm directory ---------- */
exports.upsertDirectoryEntry = onCall(OPTS, async (req) => {
  const d = req.data || {}, name = String(d.name || "").trim().slice(0, 80);
  const list = (v) => (Array.isArray(v) ? v : []).map((s) => String(s).trim().slice(0, 40)).filter(Boolean).slice(0, 20);
  if (!name || !["broker", "prop"].includes(d.type)) throw new HttpsError("invalid-argument", "Enter a name and type.");
  const url = String(d.url || "").trim();
  if (url && !/^https:\/\//i.test(url)) throw new HttpsError("invalid-argument", "Links must start with https://");
  return guarded(req, ADM, d.id ? "directory_updated" : "directory_created", name, async () => {
    const col = db.collection("directory_entries"), ref = d.id ? col.doc(String(d.id)) : col.doc();
    await ref.set({ name, type: d.type, description: String(d.description || "").slice(0, 300), platforms: list(d.platforms), countries: list(d.countries), url, affiliate: !!d.affiliate, enabled: !!d.enabled, updatedAt: FieldValue.serverTimestamp(), updatedBy: req.auth.uid }, { merge: true });
    return { result: { ok: true, id: ref.id }, audit: { affiliate: !!d.affiliate, enabled: !!d.enabled } };
  });
});

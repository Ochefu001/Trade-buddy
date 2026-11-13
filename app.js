import { app, auth, db } from "../firebase.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-functions.js";
import { collection, collectionGroup, query, orderBy, limit, startAfter, getDocs, getDoc, doc, where, getCountFromServer } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";

/* ------------------------------------------------------------------
   CONFIG. The MetaApi connection records were not part of the files I
   could inspect, so the page below stays in an explicit "not configured"
   state until you fill this in with your real collection and field names.
   CONNECTIONS_GROUP is a Firestore collection-group name (e.g. the name
   of the subcollection under users/{uid}).
------------------------------------------------------------------- */
const CONFIG = {
  FUNCTIONS_REGION: "us-central1",
  CONNECTIONS_GROUP: "",
  CONN_FIELDS: { user: "uid", broker: "broker", platform: "platform", account: "login", status: "status", lastSync: "lastSync", error: "lastError" },
  CONN_OK: ["connected", "deployed", "active", "synchronized"],
  CONN_FAIL: ["failed", "error", "disconnected"]
};

const $ = function (i) { return document.getElementById(i); };
const fns = getFunctions(app, CONFIG.FUNCTIONS_REGION);
function call(name, data) { return httpsCallable(fns, name)(data || {}).then(function (r) { return r.data; }); }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]; }); }
function n0(x) { return Number(x || 0).toLocaleString("en-US"); }
function money(x, cur) { return (cur || "$") + Number(x || 0).toLocaleString("en-US", {minimumFractionDigits: 2, maximumFractionDigits: 2}); }
function dt(ms) { return ms ? new Date(ms).toLocaleDateString("en-US", {month: "short", day: "numeric", year: "numeric"}) : "-"; }
function dtt(ms) { return ms ? new Date(ms).toLocaleString("en-US", {month: "short", day: "numeric", hour: "numeric", minute: "2-digit"}) : "-"; }
function tsMs(t) { return t && t.toMillis ? t.toMillis() : (typeof t === "number" ? t : (t ? Date.parse(t) : 0)); }
function emsg(e) { return (e && (e.message || e.code)) ? String(e.message || e.code).replace(/^.*?:\s*/, "") : "Something went wrong."; }

/* ---------- roles & permissions ---------- */
const SA = "super_admin", AD = "admin", SU = "support";
const ALL = [SA, AD, SU], ADM = [SA, AD];
const ROLE_LABEL = {super_admin: "Super Admin", admin: "Admin", support: "Support Admin"};
let ME = null, ROLE = "";
function can(roles) { return roles.indexOf(ROLE) > -1; }

/* ---------- tiny UI helpers ---------- */
function toast(t, bad) { var e = $("toast"); e.textContent = t; e.className = "toast on" + (bad ? " bad" : ""); clearTimeout(toast.t); toast.t = setTimeout(function () { e.className = "toast"; }, 3200); }
function openModal(html) { $("mbody").innerHTML = html; $("modal").classList.add("on"); }
function closeModal() { $("modal").classList.remove("on"); }
$("modal").addEventListener("click", function (e) { if (e.target === $("modal")) closeModal(); });
document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeModal(); });
function confirmBox(title, msg, okLabel, danger) {
  return new Promise(function (res) {
    openModal("<h2>" + esc(title) + "</h2><p class=\"note\" style=\"font-size:14px;color:#d4d4d8\">" + msg + "</p><div class=\"mact\"><button class=\"btn o\" id=\"cx\">Cancel</button><button class=\"btn" + (danger ? " d" : "") + "\" id=\"ck\">" + esc(okLabel || "Confirm") + "</button></div>");
    $("cx").onclick = function () { closeModal(); res(false); };
    $("ck").onclick = function () { closeModal(); res(true); };
  });
}
function stat(label, val, note, cls) {
  var na = val == null;
  return '<div class="card stat"><small>' + esc(label) + '</small><b class="' + (na ? "na " : "") + (cls || "") + '">' + (na ? "Not yet available" : esc(val)) + '</b>' + (note ? "<p>" + esc(note) + "</p>" : "") + "</div>";
}
function head(title, sub, tools) { return '<div class="head"><div><div class="eyebrow">Trade Buddy administration</div><h1>' + esc(title) + "</h1>" + (sub ? "<p>" + esc(sub) + "</p>" : "") + '</div><div class="tools">' + (tools || "") + "</div></div>"; }
function tableHtml(heads, rows, empty) {
  if (!rows.length) return '<div class="card empty">' + (empty || "Nothing here yet.") + "</div>";
  return '<div class="tw"><table><thead><tr>' + heads.map(function (h) { return "<th>" + h + "</th>"; }).join("") + "</tr></thead><tbody>" + rows.join("") + "</tbody></table></div>";
}
function bars(labels, vals, color) {
  var W = 620, H = 170, pl = 28, pb = 22, max = Math.max.apply(null, vals.concat([1])), bw = (W - pl) / Math.max(vals.length, 1);
  var s = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Chart">';
  [0, 0.5, 1].forEach(function (f) { var y = (H - pb) - f * (H - pb - 8); s += '<line x1="' + pl + '" x2="' + W + '" y1="' + y + '" y2="' + y + '" stroke="rgba(255,255,255,.07)"/><text x="0" y="' + (y + 3) + '">' + Math.round(max * f) + "</text>"; });
  vals.forEach(function (v, i) { var h = v / max * (H - pb - 8), x = pl + i * bw + bw * 0.15; s += '<rect x="' + x + '" y="' + (H - pb - h) + '" width="' + bw * 0.7 + '" height="' + Math.max(h, v ? 1 : 0) + '" rx="2" fill="' + (color || "#FFC928") + '"><title>' + esc(labels[i]) + ": " + v + "</title></rect>"; });
  var step = Math.ceil(vals.length / 6);
  labels.forEach(function (l, i) { if (i % step === 0) s += '<text x="' + (pl + i * bw) + '" y="' + (H - 6) + '">' + esc(l) + "</text>"; });
  return s + "</svg>";
}
function csv(name, headers, rows) {
  var q = function (v) { return '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"'; };
  var blob = new Blob([[headers].concat(rows).map(function (r) { return r.map(q).join(","); }).join("\n")], {type: "text/csv"});
  var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
}
function noAccess() { return '<div class="card empty">Your role does not have access to this section.</div>'; }

/* ---------- cached stats from the trusted function ---------- */
let STATS = null;
async function getStats(force) {
  if (STATS && !force && Date.now() - STATS.at < 120000) return STATS.d;
  var d = await call("getAuthStats"); STATS = {at: Date.now(), d: d}; return d;
}
async function countOf(q) { try { return (await getCountFromServer(q)).data().count; } catch (e) { return null; } }
function dayLabels(n) { var out = []; for (var i = n - 1; i >= 0; i--) out.push(new Date(Date.now() - i * 864e5).toISOString().slice(0, 10)); return out; }

/* ================= VIEWS ================= */
const IC = {
  overview: '<path d="M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10"/>',
  users: '<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6M17 4a4 4 0 010 8M22 21c0-3-2-5-4-5.5"/>',
  analytics: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
  revenue: '<circle cx="12" cy="12" r="9"/><path d="M14.5 9a2.5 2 0 00-2.5-1.5c-1.4 0-2.5.7-2.5 1.8s1 1.5 2.5 1.7 2.5.6 2.5 1.8-1.1 1.7-2.5 1.7A2.5 2 0 019.5 15M12 6v2M12 16v2"/>',
  connections: '<path d="M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1"/><path d="M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1"/>',
  directory: '<path d="M3 21h18M5 21V10l7-5 7 5v11M9 21v-6h6v6"/>',
  content: '<path d="M4 4h12a4 4 0 014 4v12H8a4 4 0 01-4-4z"/><path d="M8 9h8M8 13h5"/>',
  controls: '<path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  security: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  logs: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 00-.1-1.2l2-1.5-2-3.5-2.3 1a7 7 0 00-2-1.2L14.2 3h-4l-.4 2.6a7 7 0 00-2 1.2l-2.3-1-2 3.5 2 1.5A7 7 0 005 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.5 2.3-1a7 7 0 002 1.2l.4 2.6h4l.4-2.6a7 7 0 002-1.2l2.3 1 2-3.5-2-1.5c.1-.4.1-.8.1-1.2z"/>'
};
const ROUTES = {
  overview: {t: "Overview", r: ALL, f: vOverview},
  users: {t: "Users", r: ALL, f: vUsers},
  analytics: {t: "Business Analytics", r: ADM, f: vAnalytics},
  revenue: {t: "Revenue", r: ADM, f: vRevenue},
  connections: {t: "MT4/MT5 Connections", r: ALL, f: vConnections},
  directory: {t: "Brokers & Prop Firms", r: ADM, f: vDirectory},
  content: {t: "Content & Announcements", r: ADM, f: vContent},
  controls: {t: "Platform Controls", r: ADM, f: vControls},
  security: {t: "Security", r: ADM, f: vSecurity},
  logs: {t: "Audit Logs", r: ADM, f: vLogs},
  settings: {t: "Admin Settings", r: ALL, f: vSettings}
};

/* ---------- Overview ---------- */
async function vOverview(el) {
  var name = (ME.displayName || ME.email || "Administrator").split(" ")[0];
  el.innerHTML = '<div class="head"><div><div class="eyebrow">Trade Buddy administration</div><h1>Welcome back, ' + esc(name) + '</h1><p>Here\'s what\'s happening across your platform.</p></div><div class="tools"><span class="tag y">' + esc(ROLE_LABEL[ROLE]) + '</span><span class="note" style="margin:0">' + new Date().toLocaleDateString("en-US", {weekday: "long", month: "long", day: "numeric", year: "numeric"}) + '</span></div></div><div class="loading">Loading...</div>';
  var s = null, serr = "";
  try { s = await getStats(); } catch (e) { serr = emsg(e); }
  var trades = null, setups = null, t0 = Date.now(), fsOk = false, fsMs = 0;
  if (can(ADM)) { trades = await countOf(collectionGroup(db, "journal")); setups = await countOf(collectionGroup(db, "setups")); }
  try { await getDoc(doc(db, "platform_settings", "main")); fsOk = true; fsMs = Date.now() - t0; } catch (e) {}
  var h = el.firstElementChild.outerHTML;
  if (serr) h += '<div class="warn">User statistics could not be loaded: ' + esc(serr) + ' (Is the <b>getAuthStats</b> Cloud Function deployed?)</div>';
  h += '<div class="grid g4">' + stat("Total registered users", s ? n0(s.total) : null) + stat("New today", s ? n0(s.today) : null, "UTC day") + stat("New this week", s ? n0(s.week) : null, "Last 7 days") + stat("New this month", s ? n0(s.month) : null, "Last 30 days") + "</div>";
  h += '<div class="grid g4">' + stat("Signed in, last 30 days", s ? n0(s.active30) : null, "Based on last sign-in time") + stat("Signed in, last 7 days", s ? n0(s.active7) : null) + stat("Signed in, last 24h", s ? n0(s.active1) : null) + stat("Suspended users", s ? n0(s.disabled) : null, "", s && s.disabled ? "dn" : "") + "</div>";
  if (can(ADM)) {
    h += '<div class="grid g4">' + stat("Recorded trades", trades == null ? null : n0(trades), "Journal entries, all users") + stat("Trading setups", setups == null ? null : n0(setups), "All users") + stat("Connected MT4/MT5 accounts", null, CONFIG.CONNECTIONS_GROUP ? "See Connections" : "Connection collection not configured") + stat("Paying users / revenue", null, "No payment data is collected yet") + "</div>";
  }
  h += '<div class="grid g2"><div class="card chart"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h2 style="margin:0">User registrations</h2><select id="rng"><option value="7">7 days</option><option value="30" selected>30 days</option><option value="90">90 days</option></select></div><div id="rch"></div></div>';
  h += '<div class="card"><h2>System health</h2>' +
    hl(fsOk, "Firebase Authentication", "Your session is valid") +
    hl(fsOk, "Cloud Firestore", fsOk ? "Read OK in " + fsMs + " ms" : "Read failed") +
    hl(!!s, "Cloud Functions", s ? "Responded to getAuthStats" : "No response") +
    '<div class="hl"><span class="dot"></span><div><b>MetaApi integration</b><small>Not checked from the admin panel</small></div></div></div></div>';
  h += '<div class="card"><h2>Recent administrative activity</h2><div id="ra"><div class="loading">Loading...</div></div></div>';
  el.innerHTML = h;
  function draw() { var n = +$("rng").value, ls = dayLabels(n); $("rch").innerHTML = s ? bars(ls.map(function (x) { return x.slice(5); }), ls.map(function (x) { return (s.signups || {})[x] || 0; })) : '<div class="empty">Not yet available</div>'; }
  $("rng").onchange = draw; draw();
  try {
    var snap = await getDocs(can([SA]) ? query(collection(db, "admin_audit_logs"), orderBy("ts", "desc"), limit(8)) : query(collection(db, "admin_audit_logs"), where("adminUid", "==", ME.uid), orderBy("ts", "desc"), limit(8)));
    $("ra").innerHTML = snap.empty ? '<div class="empty">No activity recorded yet.</div>' : snap.docs.map(function (d) { var x = d.data(); return '<div class="hl"><span class="dot ' + (x.status === "success" ? "ok" : "bad") + '"></span><div><b>' + esc(x.action) + '</b><small>' + esc(x.adminEmail) + (x.target ? " &middot; " + esc(x.target) : "") + " &middot; " + dtt(tsMs(x.ts)) + "</small></div></div>"; }).join("");
  } catch (e) { $("ra").innerHTML = '<div class="empty">Activity is not available for your role or the index is still building.</div>'; }
}
function hl(ok, t, s) { return '<div class="hl"><span class="dot ' + (ok ? "ok" : "bad") + '"></span><div><b>' + esc(t) + "</b><small>" + esc(s) + "</small></div></div>"; }

/* ---------- Users ---------- */
async function vUsers(el) {
  var rows = [], next = null, filt = "all", sort = "new", q = "";
  el.innerHTML = head("Users", "Registered Trade Buddy users", "") + '<div class="tools" style="margin-bottom:12px"><input id="uq" type="search" placeholder="Find by exact email" style="min-width:230px"><button class="btn o sm" id="ugo">Search</button><select id="uf"><option value="all">All users</option><option value="active">Active</option><option value="susp">Suspended</option></select><select id="us"><option value="new">Newest registered</option><option value="old">Oldest registered</option><option value="seen">Recently signed in</option></select></div><div id="ut"><div class="loading">Loading...</div></div><div style="margin-top:12px;text-align:center" id="um"></div><p class="note">Filter and sort apply to the users loaded so far. Users load 50 at a time directly from Firebase Authentication.</p>';
  async function load(reset) {
    if (reset) { rows = []; next = null; }
    try {
      var r = await call("listAuthUsers", {pageToken: next || undefined, max: 50, email: q || undefined});
      rows = rows.concat(r.users); next = r.next || null;
    } catch (e) { $("ut").innerHTML = '<div class="warn">' + esc(emsg(e)) + "</div>"; return; }
    draw();
  }
  function draw() {
    var v = rows.filter(function (u) { return filt === "all" || (filt === "susp" ? u.disabled : !u.disabled); });
    v.sort(function (a, b) { return sort === "old" ? a.created - b.created : sort === "seen" ? (b.lastSignIn || 0) - (a.lastSignIn || 0) : b.created - a.created; });
    $("ut").innerHTML = tableHtml(["User", "Registered", "Last sign-in", "Status", "Role"], v.map(function (u) {
      return '<tr class="cl" data-uid="' + esc(u.uid) + '"><td><b>' + esc(u.name || "(no name)") + "</b><small>" + esc(u.email) + '</small></td><td>' + dt(u.created) + "</td><td>" + (u.lastSignIn ? dtt(u.lastSignIn) : "Never") + '</td><td><span class="tag ' + (u.disabled ? "bad" : "ok") + '">' + (u.disabled ? "Suspended" : "Active") + "</span></td><td>" + (u.role ? '<span class="tag y">' + esc(ROLE_LABEL[u.role] || u.role) + "</span>" : '<span class="tag">User</span>') + "</td></tr>";
    }), "No users match.");
    $("um").innerHTML = next ? '<button class="btn o" id="more">Load more</button>' : "";
    if ($("more")) $("more").onclick = function () { load(false); };
  }
  $("uf").onchange = function () { filt = this.value; draw(); };
  $("us").onchange = function () { sort = this.value; draw(); };
  $("ugo").onclick = function () { q = $("uq").value.trim(); load(true); };
  $("uq").onkeydown = function (e) { if (e.key === "Enter") $("ugo").click(); };
  $("ut").onclick = function (e) { var tr = e.target.closest("[data-uid]"); if (tr) profile(rows.filter(function (u) { return u.uid === tr.getAttribute("data-uid"); })[0], draw); };
  load(true);
}
async function profile(u, redraw) {
  if (!u) return;
  openModal("<h2>" + esc(u.name || u.email) + '</h2><div class="loading">Loading...</div>');
  var jn = "Restricted", sn = "Restricted", fname = "";
  var jc = await countOf(collection(db, "users", u.uid, "journal")); if (jc != null) jn = n0(jc);
  var sc = await countOf(collection(db, "users", u.uid, "setups")); if (sc != null) sn = n0(sc);
  try { var d = await getDoc(doc(db, "users", u.uid)); if (d.exists()) fname = d.data().name || ""; } catch (e) {}
  var canSusp = can(ADM) && u.uid !== ME.uid && !(u.role && ROLE !== SA);
  function kv(k, v) { return '<div class="kv"><span>' + k + "</span><p>" + v + "</p></div>"; }
  openModal("<h2>" + esc(u.name || u.email) + '</h2><span class="tag ' + (u.disabled ? "bad" : "ok") + '">' + (u.disabled ? "Suspended" : "Active") + "</span>" +
    kv("Email", esc(u.email) + (u.verified ? ' <span class="tag ok">verified</span>' : ' <span class="tag">unverified</span>')) + kv("Profile name", esc(fname || "-")) + kv("Registered", dtt(u.created)) + kv("Last sign-in", u.lastSignIn ? dtt(u.lastSignIn) : "Never") +
    kv("Trades recorded", jn) + kv("Setups created", sn) + kv("Subscription", "Not yet available (no subscription data)") + kv("Connected accounts", CONFIG.CONNECTIONS_GROUP ? "See MT4/MT5 Connections" : "Not yet available") + kv("User ID", esc(u.uid)) +
    '<p class="note">Passwords and trading credentials are never shown here.</p><div class="mact"><button class="btn o" id="pc">Close</button>' + (canSusp ? '<button class="btn ' + (u.disabled ? "" : "d") + '" id="ps">' + (u.disabled ? "Reactivate user" : "Suspend user") + "</button>" : "") + "</div>");
  $("pc").onclick = closeModal;
  if ($("ps")) $("ps").onclick = async function () {
    var susp = !u.disabled;
    if (!await confirmBox(susp ? "Suspend this user?" : "Reactivate this user?", susp ? "<b>" + esc(u.email) + "</b> will be signed out and unable to log in until reactivated. This action is recorded in the audit log." : "<b>" + esc(u.email) + "</b> will be able to log in again.", susp ? "Suspend" : "Reactivate", susp)) return;
    try { await call("setUserSuspended", {uid: u.uid, suspended: susp}); u.disabled = susp; STATS = null; toast(susp ? "User suspended" : "User reactivated"); redraw(); } catch (e) { toast(emsg(e), true); }
  };
}

/* ---------- Business analytics ---------- */
async function vAnalytics(el) {
  el.innerHTML = head("Business Analytics", "How Trade Buddy is performing", '<select id="ar"><option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option><option value="90">Last 90 days</option></select>') + '<div class="loading">Loading...</div>';
  var s; try { s = await getStats(); } catch (e) { el.innerHTML = head("Business Analytics") + '<div class="warn">' + esc(emsg(e)) + "</div>"; return; }
  var body = '<div class="grid g4">' + stat("Total registered users", n0(s.total)) + stat("Daily active", n0(s.active1), "Signed in in the last 24h") + stat("Weekly active", n0(s.active7), "Signed in in the last 7 days") + stat("Monthly active", n0(s.active30), "Signed in in the last 30 days") + "</div>" +
    '<div class="grid g2"><div class="card chart"><h2>New registrations</h2><div id="ach"></div><p class="note" id="asum"></p></div><div class="card"><h2>Returning users</h2><p style="font-size:26px;font-weight:700">' + (s.total ? Math.round(s.returning / s.total * 100) : 0) + '%</p><p class="note">' + n0(s.returning) + " of " + n0(s.total) + " users have signed in more than a day after registering (approximation from Authentication timestamps).</p></div></div>" +
    '<div class="card"><h2>Metrics waiting for a data source</h2>' +
    ["User retention by cohort|Needs a per-day activity record (e.g. a daily 'lastActive' write by the trader app). Authentication only stores the most recent sign-in.", "Daily/monthly active history|Same: today's figures are accurate, but historical trends can't be rebuilt without recorded activity.", "Subscription conversion rate|No subscription or payment records exist yet.", "Affiliate conversion rate|Affiliate link clicks and confirmed conversions are not tracked yet."].map(function (x) { var p = x.split("|"); return '<div class="hl"><span class="dot"></span><div><b>' + p[0] + "</b><small>" + p[1] + "</small></div></div>"; }).join("") + "</div>";
  el.innerHTML = head("Business Analytics", "How Trade Buddy is performing", '<select id="ar"><option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option><option value="90">Last 90 days</option></select>') + body;
  function draw() { var n = +$("ar").value, ls = dayLabels(n), v = ls.map(function (x) { return (s.signups || {})[x] || 0; }); $("ach").innerHTML = bars(ls.map(function (x) { return x.slice(5); }), v); $("asum").textContent = v.reduce(function (a, b) { return a + b; }, 0) + " new users in this period."; }
  $("ar").onchange = draw; draw();
}

/* ---------- Revenue ---------- */
async function vRevenue(el) {
  el.innerHTML = head("Revenue", "Business income from recorded transactions") + '<div class="loading">Loading...</div>';
  var tx = [];
  try { var snap = await getDocs(query(collection(db, "revenue_transactions"), orderBy("ts", "desc"), limit(200))); tx = snap.docs.map(function (d) { var x = d.data(); x.id = d.id; return x; }); }
  catch (e) { el.innerHTML = head("Revenue") + '<div class="warn">Could not read revenue records: ' + esc(emsg(e)) + "</div>"; return; }
  var SRC = {subscription: "Premium subscription", broker_affiliate: "Broker affiliate", prop_affiliate: "Prop firm affiliate", other: "Other"};
  if (!tx.length) {
    el.innerHTML = head("Revenue", "Business income from recorded transactions") + '<div class="card empty"><b style="color:#fff">No revenue has been recorded yet.</b><br>Trade Buddy has no payment or affiliate integration writing to <code>revenue_transactions</code>, so there is nothing to report. Nothing is estimated or invented here.<br><br>When a payment provider or affiliate postback (via a Cloud Function) starts writing records, they will appear here with totals, charts and CSV export.</div>';
    return;
  }
  var src = "all", from = "", to = "";
  el.innerHTML = head("Revenue", "Business income from recorded transactions", '<button class="btn o sm" id="rx">Export CSV</button>') + '<div id="rs"></div><div class="tools" style="margin:12px 0"><select id="rf"><option value="all">All sources</option>' + Object.keys(SRC).map(function (k) { return '<option value="' + k + '">' + SRC[k] + "</option>"; }).join("") + '</select><input type="date" id="rfr" aria-label="From"><input type="date" id="rto" aria-label="To"></div><div class="card chart"><h2>Revenue by day</h2><div id="rc"></div></div><div style="margin-top:14px" id="rt"></div><p class="note">Showing up to the latest 200 transactions. Only completed transactions count toward totals.</p>';
  function view() { return tx.filter(function (x) { var d = new Date(tsMs(x.ts)).toISOString().slice(0, 10); return (src === "all" || x.source === src) && (!from || d >= from) && (!to || d <= to); }); }
  function draw() {
    var v = view(), done = v.filter(function (x) { return x.status === "completed"; }), now = Date.now();
    var sum = function (a) { return a.reduce(function (s, x) { return s + (+x.amount || 0); }, 0); };
    var month = done.filter(function (x) { return tsMs(x.ts) > now - 30 * 864e5; }), week = done.filter(function (x) { return tsMs(x.ts) > now - 7 * 864e5; });
    var by = {}; done.forEach(function (x) { by[x.source || "other"] = (by[x.source || "other"] || 0) + (+x.amount || 0); });
    var pend = v.filter(function (x) { return x.status === "pending"; });
    $("rs").innerHTML = '<div class="grid g4">' + stat("Total revenue", money(sum(done))) + stat("Last 30 days", money(sum(month))) + stat("Last 7 days", money(sum(week))) + stat("Pending", pend.length ? money(sum(pend)) : "$0.00", pend.length + " pending") + "</div><div class=\"card\"><h2>By source</h2>" + (Object.keys(by).map(function (k) { return '<div class="hl"><div><b>' + esc(SRC[k] || k) + '</b></div><b>' + money(by[k]) + "</b></div>"; }).join("") || '<div class="empty">No completed transactions.</div>') + "</div>";
    var ls = dayLabels(30), m = {}; done.forEach(function (x) { var k = new Date(tsMs(x.ts)).toISOString().slice(0, 10); m[k] = (m[k] || 0) + (+x.amount || 0); });
    $("rc").innerHTML = bars(ls.map(function (x) { return x.slice(5); }), ls.map(function (x) { return Math.round(m[x] || 0); }));
    $("rt").innerHTML = tableHtml(["Date", "Source", "Reference", "Status", "Amount"], v.map(function (x) { return "<tr><td>" + dt(tsMs(x.ts)) + "</td><td>" + esc(SRC[x.source] || x.source || "-") + "</td><td>" + esc(x.ref || "-") + '</td><td><span class="tag ' + (x.status === "completed" ? "ok" : x.status === "pending" ? "y" : "bad") + '">' + esc(x.status || "-") + "</span></td><td><b>" + money(x.amount, x.currency === "USD" || !x.currency ? "$" : x.currency + " ") + "</b></td></tr>"; }), "No transactions match.");
  }
  $("rf").onchange = function () { src = this.value; draw(); }; $("rfr").onchange = function () { from = this.value; draw(); }; $("rto").onchange = function () { to = this.value; draw(); };
  $("rx").onclick = function () { csv("trade-buddy-revenue.csv", ["Date", "Source", "Reference", "Status", "Amount", "Currency"], view().map(function (x) { return [new Date(tsMs(x.ts)).toISOString(), x.source, x.ref, x.status, x.amount, x.currency || "USD"]; })); };
  draw();
}

/* ---------- MT4/MT5 connections (read-only) ---------- */
async function vConnections(el) {
  el.innerHTML = head("MT4/MT5 Connections", "Read-only monitoring of linked trading accounts") + '<div class="loading">Loading...</div>';
  if (!CONFIG.CONNECTIONS_GROUP) {
    el.innerHTML = head("MT4/MT5 Connections", "Read-only monitoring of linked trading accounts") + '<div class="card empty"><b style="color:#fff">Connection records are not configured.</b><br>The MetaApi connection data wasn\'t part of the files this panel was built from, so I haven\'t guessed at its structure. Open <code>admin/app.js</code>, set <code>CONFIG.CONNECTIONS_GROUP</code> (and the field names under <code>CONN_FIELDS</code>) to match your records, add a Firestore rule allowing staff to read that collection group, and this page will list real connections, statuses and sync errors.<br><br>No credentials, tokens or investor passwords are ever displayed, and this panel has no trading functions.</div>';
    return;
  }
  var F = CONFIG.CONN_FIELDS, rs = [];
  try { var snap = await getDocs(query(collectionGroup(db, CONFIG.CONNECTIONS_GROUP), limit(100))); rs = snap.docs.map(function (d) { var x = d.data(); x.__id = d.id; return x; }); }
  catch (e) { el.innerHTML = head("MT4/MT5 Connections") + '<div class="warn">Could not read connections: ' + esc(emsg(e)) + "</div>"; return; }
  var ok = rs.filter(function (x) { return CONFIG.CONN_OK.indexOf(String(x[F.status]).toLowerCase()) > -1; }), bad = rs.filter(function (x) { return CONFIG.CONN_FAIL.indexOf(String(x[F.status]).toLowerCase()) > -1; });
  var last = rs.reduce(function (m, x) { return Math.max(m, tsMs(x[F.lastSync])); }, 0);
  function mask(v) { v = String(v == null ? "" : v); return v ? "****" + v.slice(-4) : "-"; }
  el.innerHTML = head("MT4/MT5 Connections", "Read-only monitoring of linked trading accounts") + '<div class="grid g4">' + stat("Connected accounts", n0(rs.length), "First 100 records") + stat("Active", n0(ok.length)) + stat("Failed / disconnected", n0(bad.length), "", bad.length ? "dn" : "") + stat("Last sync", last ? dtt(last) : "-") + "</div>" +
    tableHtml(["User", "Broker", "Platform", "Account", "Status", "Last sync", "Last error"], rs.map(function (x) { var st = String(x[F.status] || "unknown"); return "<tr><td>" + esc(String(x[F.user] || "-").slice(0, 10)) + "</td><td>" + esc(x[F.broker] || "-") + "</td><td>" + esc(x[F.platform] || "-") + "</td><td>" + mask(x[F.account]) + '</td><td><span class="tag ' + (CONFIG.CONN_OK.indexOf(st.toLowerCase()) > -1 ? "ok" : CONFIG.CONN_FAIL.indexOf(st.toLowerCase()) > -1 ? "bad" : "") + '">' + esc(st) + "</span></td><td>" + (tsMs(x[F.lastSync]) ? dtt(tsMs(x[F.lastSync])) : "-") + "</td><td>" + esc(String(x[F.error] || "").slice(0, 80)) + "</td></tr>"; }), "No connections found.");
}

/* ---------- Broker & prop firm directory ---------- */
async function vDirectory(el) {
  var rows = [];
  async function load() {
    try { var s = await getDocs(query(collection(db, "directory_entries"), orderBy("name"), limit(200))); rows = s.docs.map(function (d) { var x = d.data(); x.id = d.id; return x; }); } catch (e) { el.innerHTML = head("Brokers & Prop Firms") + '<div class="warn">' + esc(emsg(e)) + "</div>"; return false; }
    return true;
  }
  async function draw() {
    el.innerHTML = head("Brokers & Prop Firms", "Directory entries and affiliate disclosures", '<button class="btn" id="da">+ Add entry</button>') +
      '<div class="warn">The trader dashboard currently shows a built-in list and does not read this collection yet. Entries saved here are stored safely, but won\'t appear to traders until the dashboard is pointed at <code>directory_entries</code>.</div>' +
      tableHtml(["Name", "Type", "Affiliate", "Link", "Status", ""], rows.map(function (x) { return "<tr><td><b>" + esc(x.name) + "</b><small>" + esc((x.platforms || []).join(", ")) + "</small></td><td>" + (x.type === "prop" ? "Prop firm" : "Broker") + '</td><td>' + (x.affiliate ? '<span class="tag y">Affiliate</span>' : '<span class="tag">Independent</span>') + "</td><td>" + (x.url ? '<a href="' + esc(x.url) + '" target="_blank" rel="noopener noreferrer" style="color:var(--y)">Open</a>' : "-") + '</td><td><span class="tag ' + (x.enabled ? "ok" : "") + '">' + (x.enabled ? "Visible" : "Hidden") + '</span></td><td><button class="btn o sm" data-e="' + esc(x.id) + '">Edit</button></td></tr>'; }), "No directory entries yet. Add one to get started.");
    $("da").onclick = function () { form(null); };
    el.querySelectorAll("[data-e]").forEach(function (b) { b.onclick = function () { form(rows.filter(function (x) { return x.id === b.getAttribute("data-e"); })[0]); }; });
  }
  function form(x) {
    x = x || {type: "broker", enabled: true, affiliate: false, platforms: [], countries: []};
    openModal("<h2>" + (x.id ? "Edit entry" : "Add entry") + '</h2><div class="f"><label>Name</label><input id="dn" value="' + esc(x.name || "") + '"><label>Type</label><select id="dt"><option value="broker"' + (x.type === "broker" ? " selected" : "") + '>Broker</option><option value="prop"' + (x.type === "prop" ? " selected" : "") + '>Prop firm</option></select><label>Description</label><input id="dd" value="' + esc(x.description || "") + '"><label>Platforms (comma separated)</label><input id="dp" value="' + esc((x.platforms || []).join(", ")) + '"><label>Supported countries (comma separated, optional)</label><input id="dc" value="' + esc((x.countries || []).join(", ")) + '"><label>Link (https://)</label><input id="du" value="' + esc(x.url || "") + '"><label style="display:flex;gap:8px;align-items:center;text-transform:none;letter-spacing:0;font-size:14px;color:#fff"><input type="checkbox" id="da2" style="width:auto"' + (x.affiliate ? " checked" : "") + '> This link is an affiliate/referral link (earns a commission)</label><label style="display:flex;gap:8px;align-items:center;text-transform:none;letter-spacing:0;font-size:14px;color:#fff"><input type="checkbox" id="de2" style="width:auto"' + (x.enabled ? " checked" : "") + '> Visible to users</label></div><div class="err" id="de3"></div><div class="mact"><button class="btn o" id="dx">Cancel</button><button class="btn" id="ds">Save</button></div>');
    $("dx").onclick = closeModal;
    $("ds").onclick = async function () {
      var list = function (v) { return v.split(",").map(function (s) { return s.trim(); }).filter(Boolean); };
      var p = {id: x.id || undefined, name: $("dn").value.trim(), type: $("dt").value, description: $("dd").value.trim(), platforms: list($("dp").value), countries: list($("dc").value), url: $("du").value.trim(), affiliate: $("da2").checked, enabled: $("de2").checked};
      if (!p.name) { $("de3").textContent = "Enter a name."; return; }
      if (p.url && !/^https:\/\//i.test(p.url)) { $("de3").textContent = "Links must start with https://"; return; }
      $("ds").disabled = true;
      try { await call("upsertDirectoryEntry", p); closeModal(); toast("Saved"); if (await load()) draw(); } catch (e) { $("de3").textContent = emsg(e); $("ds").disabled = false; }
    };
  }
  if (await load()) draw();
}

/* ---------- Content & announcements ---------- */
async function vContent(el) {
  var rows = [], TYPES = {announcement: "Announcement", faq: "FAQ", help: "Help / education"};
  async function load() {
    try { var s = await getDocs(query(collection(db, "platform_content"), orderBy("updatedAt", "desc"), limit(100))); rows = s.docs.map(function (d) { var x = d.data(); x.id = d.id; return x; }); return true; } catch (e) { el.innerHTML = head("Content & Announcements") + '<div class="warn">' + esc(emsg(e)) + "</div>"; return false; }
  }
  async function draw() {
    var hist = [];
    try { var h = await getDocs(query(collection(db, "admin_broadcasts"), orderBy("ts", "desc"), limit(10))); hist = h.docs.map(function (d) { return d.data(); }); } catch (e) {}
    el.innerHTML = head("Content & Announcements", "Information shown to Trade Buddy users", '<button class="btn" id="ca">+ New content</button>') +
      '<div class="warn">Announcements you broadcast arrive in each user\'s existing Notifications inbox. FAQ and help content is stored and published here, but the trader app does not display it yet.</div>' +
      tableHtml(["Title", "Type", "Status", "Updated", ""], rows.map(function (x) { return "<tr><td><b>" + esc(x.title) + "</b><small>" + esc(String(x.body || "").slice(0, 70)) + '</small></td><td>' + esc(TYPES[x.type] || x.type) + '</td><td><span class="tag ' + (x.status === "published" ? "ok" : x.status === "unpublished" ? "bad" : "") + '">' + esc(x.status) + "</span>" + (x.broadcastAt ? '<small>Sent to all users</small>' : "") + "</td><td>" + dt(tsMs(x.updatedAt)) + '</td><td><button class="btn o sm" data-e="' + esc(x.id) + '">Edit</button></td></tr>'; }), "Nothing created yet.") +
      '<div class="card" style="margin-top:14px"><h2>Notification history</h2>' + (hist.length ? hist.map(function (x) { return '<div class="hl"><div><b>' + esc(x.title) + "</b><small>" + esc(x.adminEmail) + " &middot; " + n0(x.recipients) + " users &middot; " + dtt(tsMs(x.ts)) + "</small></div></div>"; }).join("") : '<div class="empty">No broadcasts sent yet.</div>') + "</div>";
    $("ca").onclick = function () { form(null); };
    el.querySelectorAll("[data-e]").forEach(function (b) { b.onclick = function () { form(rows.filter(function (x) { return x.id === b.getAttribute("data-e"); })[0]); }; });
  }
  function form(x) {
    x = x || {type: "announcement", status: "draft"};
    openModal("<h2>" + (x.id ? "Edit content" : "New content") + '</h2><div class="f"><label>Type</label><select id="ct"><option value="announcement">Announcement</option><option value="faq">FAQ</option><option value="help">Help / education</option></select><label>Title</label><input id="cti" maxlength="120" value="' + esc(x.title || "") + '"><label>Body</label><textarea id="cb" maxlength="2000">' + esc(x.body || "") + '</textarea><label>Status</label><select id="cs"><option value="draft">Draft</option><option value="published">Published</option><option value="unpublished">Unpublished</option></select><label id="cbl" style="display:flex;gap:8px;align-items:center;text-transform:none;letter-spacing:0;font-size:14px;color:#fff"><input type="checkbox" id="cbc" style="width:auto"' + (x.broadcastAt ? " disabled" : "") + '> Also send as a notification to all users' + (x.broadcastAt ? " (already sent)" : "") + '</label><p class="note">Scheduling is not supported yet.</p></div><div class="err" id="ce"></div><div class="mact"><button class="btn o" id="cx">Cancel</button><button class="btn" id="cv">Save</button></div>');
    $("ct").value = x.type; $("cs").value = x.status;
    var sync = function () { $("cbl").style.display = $("ct").value === "announcement" && $("cs").value === "published" ? "flex" : "none"; }; $("ct").onchange = sync; $("cs").onchange = sync; sync();
    $("cx").onclick = closeModal;
    $("cv").onclick = async function () {
      var p = {id: x.id || undefined, type: $("ct").value, title: $("cti").value.trim(), body: $("cb").value.trim(), status: $("cs").value, broadcast: $("cbc").checked && !$("cbc").disabled && $("cbl").style.display !== "none"};
      if (!p.title || !p.body) { $("ce").textContent = "Enter a title and body."; return; }
      if (p.broadcast && !await confirmBox("Send to ALL users?", "This will put the notification <b>\"" + esc(p.title) + "\"</b> in every registered user's inbox. It can't be recalled.", "Send to everyone", true)) return;
      $("cv").disabled = true;
      try { await call("saveContent", p); closeModal(); toast(p.broadcast ? "Saved and sent" : "Saved"); if (await load()) draw(); } catch (e) { $("ce").textContent = emsg(e); $("cv").disabled = false; }
    };
  }
  if (await load()) draw();
}

/* ---------- Platform controls ---------- */
async function vControls(el) {
  var S = {maintenance: false, registration: true, features: {}}, exists = false;
  try { var d = await getDoc(doc(db, "platform_settings", "main")); if (d.exists()) { S = d.data(); exists = true; } } catch (e) { el.innerHTML = head("Platform Controls") + '<div class="warn">' + esc(emsg(e)) + "</div>"; return; }
  S.features = S.features || {};
  var F = [["journal", "Trading journal", "rules"], ["setups", "Trading setups", "rules"], ["analytics", "Analytics", "app"], ["calculators", "Calculators", "app"], ["connections", "MT4/MT5 connections", "app"], ["premium", "Premium features", "app"]];
  var edit = can([SA]);
  el.innerHTML = head("Platform Controls", "Settings that affect every user", edit ? '<button class="btn" id="cs">Save changes</button>' : "") +
    (edit ? "" : '<div class="warn">Only Super Admins can change platform settings. You can view the current state.</div>') +
    (exists ? "" : '<div class="note" style="margin-bottom:10px">No settings document exists yet. Everything below is the default (all on). Saving will create it.</div>') +
    '<div class="card"><h2>Access</h2>' + sw("maintenance", "Maintenance mode", "Stored flag. The trader app does not yet show a maintenance screen; with the supplied rules, journal and setup writes are blocked while it is on.", !!S.maintenance, edit) + sw("registration", "New registrations open", "Stored only. Firebase Authentication sign-up isn't gated by this flag yet.", S.registration !== false, edit) + "</div>" +
    '<div class="card"><h2>Features</h2>' + F.map(function (f) { return sw("f_" + f[0], f[1], f[2] === "rules" ? "Enforced by Firestore rules (writes are blocked when off)." : "Stored only. The trader app doesn't read this flag yet.", S.features[f[0]] !== false, edit); }).join("") + "</div>" +
    '<p class="note">A switch here is a stored value. It only becomes a real control where the backend enforces it, as labelled on each row.</p>';
  function sw(id, t, s, on, ed) { return '<div class="sw"><div><b>' + esc(t) + "</b><small>" + esc(s) + '</small></div><label class="tg"><input type="checkbox" id="' + id + '"' + (on ? " checked" : "") + (ed ? "" : " disabled") + '><i></i></label></div>'; }
  if (edit) $("cs").onclick = async function () {
    var next = {maintenance: $("maintenance").checked, registration: $("registration").checked, features: {}};
    F.forEach(function (f) { next.features[f[0]] = $("f_" + f[0]).checked; });
    var warn = []; if (next.maintenance !== !!S.maintenance) warn.push("Maintenance mode will be turned <b>" + (next.maintenance ? "ON" : "OFF") + "</b>.");
    F.forEach(function (f) { if ((next.features[f[0]]) !== (S.features[f[0]] !== false)) warn.push(esc(f[1]) + " will be turned <b>" + (next.features[f[0]] ? "ON" : "OFF") + "</b> for everyone."); });
    if (next.registration !== (S.registration !== false)) warn.push("Registration flag will be <b>" + (next.registration ? "ON" : "OFF") + "</b>.");
    if (!warn.length) { toast("No changes to save"); return; }
    if (!await confirmBox("Apply to all users?", warn.join("<br>"), "Apply", true)) return;
    try { await call("setPlatformSettings", next); S = next; exists = true; toast("Settings saved"); } catch (e) { toast(emsg(e), true); }
  };
}

/* ---------- Security ---------- */
async function vSecurity(el) {
  var roles = [], canManage = can([SA]);
  try { if (canManage) { var s = await getDocs(query(collection(db, "admin_roles"), limit(100))); roles = s.docs.map(function (d) { var x = d.data(); x.uid = d.id; return x; }); } } catch (e) {}
  var PERM = [["View overview", "Yes", "Yes", "Limited"], ["View users", "Yes", "Yes", "Yes"], ["Suspend / reactivate users", "Yes", "Yes", "No"], ["View revenue", "Yes", "Yes", "No"], ["Manage integrations", "Yes", "Yes", "View only"], ["Publish announcements", "Yes", "Yes", "No"], ["Change platform settings", "Yes", "View only", "No"], ["Manage administrators & roles", "Yes", "No", "No"], ["View audit logs", "Yes", "Own actions", "No"]];
  el.innerHTML = head("Security", "Administrator access and permissions") +
    '<div class="card"><h2>Role permissions</h2><div class="tw" style="border:0"><table class="perm"><thead><tr><th>Function</th><th>Super Admin</th><th>Admin</th><th>Support Admin</th></tr></thead><tbody>' + PERM.map(function (r) { return "<tr>" + r.map(function (c, i) { return i ? '<td><span class="tag ' + (c === "Yes" ? "ok" : c === "No" ? "" : "y") + '">' + c + "</span></td>" : "<td>" + c + "</td>"; }).join("") + "</tr>"; }).join("") + "</tbody></table></div><p class=\"note\">These permissions are enforced by Cloud Functions and Firestore rules reading a server-assigned role claim, not by this interface.</p></div>" +
    (canManage ? '<div class="card"><h2>Administrators</h2><div id="al"></div><div class="tools f" style="margin-top:12px"><input id="ae" type="email" placeholder="User email (must already have an account)" style="flex:1;min-width:200px"><select id="ar"><option value="admin">Admin</option><option value="support">Support Admin</option><option value="super_admin">Super Admin</option></select><button class="btn" id="ag">Grant role</button></div><div class="err" id="aerr"></div><p class="note">The user must sign out and back in before the new role takes effect.</p></div>' : "") +
    '<div class="card"><h2>Protection status</h2>' + [["Role-based access control", true, "Server-managed custom claims"], ["Sensitive actions require confirmation", true, "Suspend, broadcast and platform changes"], ["Administrative activity recorded", true, "Written by Cloud Functions only"], ["Multi-factor authentication", false, "Not enabled. Requires upgrading Firebase Authentication to Identity Platform."], ["Failed-login monitoring", false, "Not available. Firebase does not expose failed sign-in events to the app."]].map(function (r) { return hl(r[1], r[0], r[2]); }).join("") + "</div>";
  if (!canManage) return;
  function drawRoles() {
    $("al").innerHTML = tableHtml(["Administrator", "Role", ""], roles.map(function (r) { return "<tr><td><b>" + esc(r.email) + "</b></td><td>" + esc(ROLE_LABEL[r.role] || r.role) + "</td><td>" + (r.uid === ME.uid ? '<span class="tag">You</span>' : '<button class="btn d sm" data-rm="' + esc(r.email) + '">Remove</button>') + "</td></tr>"; }), "No administrators recorded.");
    $("al").querySelectorAll("[data-rm]").forEach(function (b) { b.onclick = async function () { if (!await confirmBox("Remove administrator?", esc(b.getAttribute("data-rm")) + " will lose all admin access and be signed out.", "Remove", true)) return; try { await call("setAdminRole", {email: b.getAttribute("data-rm"), role: null}); roles = roles.filter(function (r) { return r.email !== b.getAttribute("data-rm"); }); drawRoles(); toast("Removed"); } catch (e) { toast(emsg(e), true); } }; });
  }
  drawRoles();
  $("ag").onclick = async function () {
    var em = $("ae").value.trim().toLowerCase(), role = $("ar").value; $("aerr").textContent = "";
    if (!em) { $("aerr").textContent = "Enter an email."; return; }
    if (!await confirmBox("Grant " + ROLE_LABEL[role] + "?", "<b>" + esc(em) + "</b> will get " + esc(ROLE_LABEL[role]) + " access to the admin panel.", "Grant access", role === SA)) return;
    try { var r = await call("setAdminRole", {email: em, role: role}); roles = roles.filter(function (x) { return x.uid !== r.uid; }).concat([{uid: r.uid, email: em, role: role}]); drawRoles(); $("ae").value = ""; toast("Role granted"); } catch (e) { $("aerr").textContent = emsg(e); }
  };
}

/* ---------- Audit logs ---------- */
async function vLogs(el) {
  var rows = [], last = null, done = false, f = "";
  el.innerHTML = head("Audit Logs", can([SA]) ? "All administrative activity" : "Your administrative activity") + '<div class="tools" style="margin-bottom:12px"><input id="lf" placeholder="Filter by action or email" style="min-width:230px"></div><div id="lt"></div><div style="text-align:center;margin-top:12px" id="lm"></div><p class="note">Logs are written by Cloud Functions and can\'t be edited or deleted from this interface.</p>';
  async function load() {
    try {
      var c = [orderBy("ts", "desc")]; if (!can([SA])) c.unshift(where("adminUid", "==", ME.uid)); if (last) c.push(startAfter(last)); c.push(limit(25));
      var s = await getDocs(query.apply(null, [collection(db, "admin_audit_logs")].concat(c)));
      rows = rows.concat(s.docs.map(function (d) { return d.data(); })); last = s.docs[s.docs.length - 1] || last; done = s.size < 25;
    } catch (e) { $("lt").innerHTML = '<div class="warn">' + esc(emsg(e)) + "</div>"; return; }
    draw();
  }
  function draw() {
    var v = rows.filter(function (x) { return !f || (x.action + " " + x.adminEmail + " " + x.target).toLowerCase().indexOf(f) > -1; });
    $("lt").innerHTML = tableHtml(["Time", "Administrator", "Action", "Target", "Details", "Result"], v.map(function (x) { return "<tr><td>" + dtt(tsMs(x.ts)) + "</td><td>" + esc(x.adminEmail) + "<small>" + esc(x.role) + "</small></td><td><b>" + esc(x.action) + "</b></td><td>" + esc(x.target || "-") + "</td><td><small>" + esc(JSON.stringify(x.details || {}).slice(0, 90)) + '</small></td><td><span class="tag ' + (x.status === "success" ? "ok" : "bad") + '">' + esc(x.status) + "</span></td></tr>"; }), "No log entries yet.");
    $("lm").innerHTML = done ? "" : '<button class="btn o" id="more">Load more</button>'; if ($("more")) $("more").onclick = load;
  }
  $("lf").oninput = function () { f = this.value.trim().toLowerCase(); draw(); };
  load();
}

/* ---------- Admin settings ---------- */
async function vSettings(el) {
  var P = {super_admin: "Everything, including roles and platform settings.", admin: "Users, analytics, revenue, announcements, directory, integrations. Platform settings are view-only.", support: "View users and integrations for support. Cannot suspend users or change settings."};
  el.innerHTML = head("Admin Settings", "Your administrator account") + '<div class="card"><h2>Account</h2><div class="kv"><span>Name</span><p>' + esc(ME.displayName || "-") + '</p></div><div class="kv"><span>Email</span><p>' + esc(ME.email) + '</p></div><div class="kv"><span>Role</span><p>' + esc(ROLE_LABEL[ROLE]) + '</p></div><div class="kv"><span>Access</span><p>' + esc(P[ROLE]) + '</p></div><div class="kv"><span>Session</span><p>Verified on every page load and re-checked every 5 minutes. Sign-in is required again if your access is revoked.</p></div><div class="mact" style="justify-content:flex-start"><button class="btn d" id="lo">Sign out</button></div></div>';
  $("lo").onclick = logout;
}

/* ================= shell ================= */
function render() {
  var id = location.hash.slice(1) || "overview", r = ROUTES[id];
  if (!r || !can(r.r)) { if (r) { $("main").innerHTML = noAccess(); } else { location.hash = "overview"; return; } }
  document.querySelectorAll("#nav a").forEach(function (a) { a.classList.toggle("on", a.getAttribute("data-r") === id); });
  $("mt").textContent = r.t; document.title = r.t + " | Trade Buddy Admin"; document.body.classList.remove("mo"); window.scrollTo(0, 0);
  if (can(r.r)) { $("main").innerHTML = '<div class="loading">Loading...</div>'; r.f($("main")).catch(function (e) { $("main").innerHTML = '<div class="warn">' + esc(emsg(e)) + "</div>"; }); }
}
async function logout() {
  try { await call("logAdminEvent", {action: "admin_logout"}); } catch (e) {}
  await signOut(auth); location.replace("login.html");
}
function boot(u, role) {
  ME = u; ROLE = role;
  $("mn").textContent = u.displayName || u.email; $("mr").textContent = ROLE_LABEL[role]; $("av").textContent = $("av2").textContent = (u.displayName || u.email || "A").charAt(0).toUpperCase();
  $("nav").innerHTML = Object.keys(ROUTES).filter(function (k) { return can(ROUTES[k].r); }).map(function (k) { return '<a href="#' + k + '" data-r="' + k + '"><svg viewBox="0 0 24 24">' + IC[k] + "</svg>" + ROUTES[k].t + "</a>"; }).join("") + '<a href="#" id="lg"><svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>Sign out</a>';
  $("lg").onclick = function (e) { e.preventDefault(); logout(); };
  $("mb").onclick = function () { document.body.classList.toggle("mo"); }; $("scrim").onclick = function () { document.body.classList.remove("mo"); };
  window.addEventListener("hashchange", render); render();
}
var started = false;
onAuthStateChanged(auth, async function (u) {
  if (!u) { location.replace("login.html"); return; }
  try {
    var t = await u.getIdTokenResult();
    if (ALL.indexOf(t.claims.role) < 0) { await signOut(auth); location.replace("login.html?reason=denied"); return; }
    if (!started) { started = true; boot(u, t.claims.role);
      setInterval(async function () {      // expired session / revoked role
        try { var r = await u.getIdTokenResult(true); if (ALL.indexOf(r.claims.role) < 0) throw new Error("revoked"); ROLE = r.claims.role; }
        catch (e) { await signOut(auth); location.replace("login.html?reason=expired"); }
      }, 300000);
    }
  } catch (e) { location.replace("login.html?reason=expired"); }
});

/* A2Z Marketing Solutionz — CRM
   Single-page app: login -> agent view or admin view. Supabase backend. */
"use strict";

const sb = supabase.createClient(CONFIG.url, CONFIG.key);
let session = null, profile = null;
let currentLead = null, currentTab = "dm";
let callStart = null, timerInt = null, pollInt = null;
let pendingOutcome = null, pendingCallbackLead = null;
let parsedUpload = null;

const $ = (id) => document.getElementById(id);
const NOW = () => new Date().toISOString();

/* ---------- helpers ---------- */
function slug(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}
function emailFor(name) {
  return slug(name) + CONFIG.emailDomain;
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtDuration(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880; g.gain.value = 0.12;
    o.start(); o.stop(ctx.currentTime + 0.5);
    setTimeout(() => { o.frequency.value = 660; const o2 = ctx.createOscillator(); o2.frequency.value = 660; o2.connect(g); o2.start(); o2.stop(ctx.currentTime + 0.5); }, 300);
  } catch (e) { /* audio blocked until user gesture — fine */ }
}
function showView(name) {
  ["view-login", "view-agent", "view-admin"].forEach((v) => $(v).classList.toggle("hidden", v !== name));
}
function toast(el, msg) { $(el).textContent = msg; setTimeout(() => { $(el).textContent = ""; }, 6000); }

/* Pakistan/Karachi + lead-local time helpers */
function timeIn(tz) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz || "Asia/Karachi", hour: "2-digit", minute: "2-digit", hour12: true }).format(new Date());
}
function localHour(tz) {
  return +new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(new Date()) % 24;
}
/* today at 5 AM Pakistan time == 00:00 UTC */
function pktDayStartISO() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}
function goodToCall(tz) {
  const h = localHour(tz);
  return h >= CONFIG.callWindowStart && h < CONFIG.callWindowEnd;
}

/* ---------- time zones ---------- */
const TOLLFREE = ["800", "833", "844", "855", "866", "877", "888"];
const AREA_TZ = {
  // Texas — Central
  "210": "America/Chicago", "214": "America/Chicago", "254": "America/Chicago",
  "281": "America/Chicago", "325": "America/Chicago", "346": "America/Chicago",
  "361": "America/Chicago", "409": "America/Chicago", "430": "America/Chicago",
  "432": "America/Chicago", "469": "America/Chicago", "512": "America/Chicago",
  "682": "America/Chicago", "713": "America/Chicago", "737": "America/Chicago",
  "806": "America/Chicago", "817": "America/Chicago", "830": "America/Chicago",
  "903": "America/Chicago", "915x": "", "936": "America/Chicago",
  "940": "America/Chicago", "945": "America/Chicago", "956": "America/Chicago",
  "972": "America/Chicago", "979": "America/Chicago",
  // El Paso — Mountain
  "915": "America/Denver",
  // Other states seen in leads
  "615": "America/Chicago", "501": "America/Chicago",
  "818": "America/Los_Angeles", "831": "America/Los_Angeles",
  // common extras
  "480": "America/Phoenix", "602": "America/Phoenix", "623": "America/Phoenix",
  "719": "America/Denver", "720": "America/Denver", "970": "America/Denver",
  "505": "America/Denver", "575": "America/Denver",
  "702": "America/Los_Angeles", "310": "America/Los_Angeles", "323": "America/Los_Angeles",
  "213": "America/Los_Angeles", "424": "America/Los_Angeles", "626": "America/Los_Angeles",
  "619": "America/Los_Angeles", "858": "America/Los_Angeles", "949": "America/Los_Angeles",
  "415": "America/Los_Angeles", "925": "America/Los_Angeles", "209": "America/Los_Angeles",
  "916": "America/Los_Angeles", "530": "America/Los_Angeles", "707": "America/Los_Angeles",
  "206": "America/Los_Angeles", "425": "America/Los_Angeles", "253": "America/Los_Angeles",
  "360": "America/Los_Angeles", "503": "America/Los_Angeles", "541": "America/Los_Angeles",
  "212": "America/New_York", "718": "America/New_York", "917": "America/New_York",
  "347": "America/New_York", "646": "America/New_York", "516": "America/New_York",
  "914": "America/New_York", "631": "America/New_York", "845": "America/New_York",
  "203": "America/New_York", "860": "America/New_York", "617": "America/New_York",
  "301": "America/New_York", "215": "America/New_York", "404": "America/New_York",
  "305": "America/New_York", "786": "America/New_York", "407": "America/New_York",
  "813": "America/New_York", "704": "America/New_York", "919": "America/New_York",
  "312": "America/Chicago", "773": "America/Chicago", "630": "America/Chicago",
  "847": "America/Chicago", "224": "America/Chicago", "331": "America/Chicago",
  "708": "America/Chicago", "815": "America/Chicago", "779": "America/Chicago",
  "847x": "", "262": "America/Chicago", "414": "America/Chicago",
  "608": "America/Chicago", "920": "America/Chicago", "414x": "",
  "405": "America/Chicago", "918": "America/Chicago", "316": "America/Chicago",
  "913": "America/Chicago", "636": "America/Chicago", "314": "America/Chicago",
  "660": "America/Chicago", "417": "America/Chicago", "573": "America/Chicago",
  "812": "America/Chicago", "317": "America/Chicago", "765": "America/Chicago",
  "616": "America/Detroit", "248": "America/Detroit", "313": "America/Detroit",
  "734": "America/Detroit", "586": "America/Detroit", "810": "America/Detroit",
  "614": "America/New_York", "513": "America/New_York", "216": "America/New_York",
  "330": "America/New_York", "440": "America/New_York", "234": "America/New_York",
  "615x": "", "731": "America/Chicago", "901": "America/Chicago",
  "256": "America/Chicago", "334": "America/Chicago", "205": "America/Chicago",
  "251": "America/Chicago", "706": "America/New_York", "770": "America/New_York",
  "678": "America/New_York", "404x": "", "850": "America/Chicago",
  "502": "America/Kentucky/Louisville", "859": "America/New_York", "606": "America/New_York",
};
delete AREA_TZ["915x"]; delete AREA_TZ["847x"]; delete AREA_TZ["414x"]; delete AREA_TZ["615x"]; delete AREA_TZ["404x"];
const CITY_TZ = {
  "el paso": "America/Denver", "nuevo laredo": "America/Mexico_City",
  laredo: "America/Chicago", mckinney: "America/Chicago", dallas: "America/Chicago",
  houston: "America/Chicago", austin: "America/Chicago", "san antonio": "America/Chicago",
  "fort worth": "America/Chicago", arlington: "America/Chicago", plano: "America/Chicago",
  frisco: "America/Chicago", addison: "America/Chicago", allen: "America/Chicago",
  garland: "America/Chicago", mesquite: "America/Chicago", irving: "America/Chicago",
  richardson: "America/Chicago", carrollton: "America/Chicago", lewisville: "America/Chicago",
  "flower mound": "America/Chicago", prosper: "America/Chicago", celina: "America/Chicago",
  wylie: "America/Chicago", murphy: "America/Chicago", sachse: "America/Chicago",
  rowlett: "America/Chicago", rockwall: "America/Chicago", "round rock": "America/Chicago",
  georgetown: "America/Chicago", cedar: "America/Chicago", katy: "America/Chicago",
  cypress: "America/Chicago", spring: "America/Chicago", humble: "America/Chicago",
  tomball: "America/Chicago", conroe: "America/Chicago", bryan: "America/Chicago",
  "college station": "America/Chicago", waco: "America/Chicago", temple: "America/Chicago",
  killeen: "America/Chicago", lubbock: "America/Chicago", amarillo: "America/Chicago",
  midland: "America/Chicago", odessa: "America/Chicago", abilene: "America/Chicago",
  "wichita falls": "America/Chicago", "san angelo": "America/Chicago", longview: "America/Chicago",
  tyler: "America/Chicago", beaumont: "America/Chicago", "port arthur": "America/Chicago",
  brownsville: "America/Chicago", harlingen: "America/Chicago", mcallen: "America/Chicago",
  edinburg: "America/Chicago", pharr: "America/Chicago", mission: "America/Chicago",
  "corpus christi": "America/Chicago", "san marcos": "America/Chicago", "new braunfels": "America/Chicago",
  seguin: "America/Chicago", schertz: "America/Chicago", victoria: "America/Chicago",
};
function tzFor(phone, city) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 11 && digits[0] === "1") {
    const code = digits.slice(1, 4);
    if (AREA_TZ[code]) return AREA_TZ[code];
    if (!TOLLFREE.includes(code)) return CITY_TZ[(city || "").toLowerCase().trim()] || "America/Chicago";
  }
  return CITY_TZ[(city || "").toLowerCase().trim()] || "America/Chicago";
}

/* ---------- auth ---------- */
async function doLogin() {
  const name = $("login-name").value.trim(), pass = $("login-pass").value;
  $("login-error").textContent = "";
  if (!name || !pass) { $("login-error").textContent = "Enter name and password."; return; }
  let res;
  try { res = await sb.auth.signInWithPassword({ email: emailFor(name), password: pass }); }
  catch (e) { $("login-error").textContent = "Cannot reach the server. Check internet / project status."; return; }
  const { data, error } = res;
  if (error) { $("login-error").textContent = error.message === "Invalid login credentials" ? "Wrong name or password." : error.message; return; }
  session = data.session;
  await boot();
}
async function doSignup() {
  const name = $("login-name").value.trim(), pass = $("signup-pass").value;
  const code = $("signup-code").value.trim();
  $("login-error").textContent = "";
  if (!name) { $("login-error").textContent = "Enter a name first."; return; }
  if (pass.length < 6) { $("login-error").textContent = "Password must be at least 6 characters."; return; }
  let res;
  try {
    res = await sb.auth.signUp({ email: emailFor(name), password: pass, options: { data: { name, signup_code: code } } });
  } catch (e) {
    $("login-error").textContent = "Cannot reach the server (" + (e.message || e) + "). Check internet / project status — see troubleshooting.";
    return;
  }
  const { data, error } = res;
  if (error) {
    const m = error.message || "";
    $("login-error").textContent = /Database error|signup code/i.test(m) ? "Wrong or missing signup code (or signups are closed)."
      : /Failed to fetch|NetworkError/i.test(m) ? "Cannot reach the server. Check internet / project status."
      : m;
    return;
  }
  if (!data.session) { $("login-error").textContent = "Account created but sign-in blocked. Ask admin to disable 'Confirm email' in Supabase Auth settings."; return; }
  session = data.session;
  await boot();
}
async function doLogout() {
  clearInterval(pollInt); clearInterval(timerInt);
  await sb.auth.signOut();
  location.reload();
}

/* ---------- boot ---------- */
async function boot() {
  const { data: sess } = await sb.auth.getSession();
  session = sess.session;
  if (!session) { showView("view-login"); return; }
  const { data: prof, error } = await sb.from("profiles").select("*").eq("id", session.user.id).single();
  if (error || !prof) {
    $("login-error").textContent = "No profile found for this account. Ask the admin to check it.";
    await sb.auth.signOut();
    showView("view-login");
    return;
  }
  profile = prof;
  if (!prof.active) {
    $("login-error").textContent = "This account is deactivated.";
    await sb.auth.signOut();
    showView("view-login");
    return;
  }
  if (prof.is_admin) initAdmin(); else initAgent();
}

/* ================= AGENT ================= */
const OUTCOMES = [
  { key: "voicemail", label: "Voicemail" },
  { key: "callback", label: "Callback" },
  { key: "interested", label: "Interested" },
  { key: "meeting", label: "Meeting booked" },
  { key: "not_interested", label: "Not interested" },
  { key: "dnc", label: "Do not call" },
  { key: "wrong_number", label: "Wrong number" },
];

function initAgent() {
  $("agent-name").textContent = profile.name;
  showView("view-agent");
  const tabs = [];
  if (profile.can_website) tabs.push(["website", "Website Leads"]);
  if (profile.can_dm) tabs.push(["dm", "Digital Marketing Leads"]);
  currentTab = profile.can_dm ? "dm" : "website";
  $("agent-tabs").innerHTML = tabs.map(([v, l]) =>
    `<button data-tab="${v}" class="${v === currentTab ? "active" : ""}">${l}</button>`).join("");
  $("agent-tabs").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    currentTab = b.dataset.tab;
    $("agent-tabs").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
    loadNextLead();
  }));
  setInterval(() => { $("clock-pk").textContent = timeIn("Asia/Karachi"); }, 1000);
  $("clock-pk").textContent = timeIn("Asia/Karachi");
  $("btn-logout").addEventListener("click", doLogout);
  $("btn-call").addEventListener("click", startCall);
  $("btn-copy").addEventListener("click", () => {
    if (currentLead) navigator.clipboard.writeText(currentLead.phone).then(() => toast("btn-copy", "ok"));
  });
  $("btn-hangup").addEventListener("click", showOutcomePanel);
  $("btn-save-outcome").addEventListener("click", saveOutcome);
  $("btn-refresh-queue").addEventListener("click", loadNextLead);
  $("btn-show-anyway").addEventListener("click", () => loadNextLead(true));
  $("outcome-btns").innerHTML = OUTCOMES.map((o) => `<button class="btn sm" data-outcome="${o.key}">${o.label}</button>`).join("");
  $("outcome-btns").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    pendingOutcome = b.dataset.outcome;
    $("outcome-btns").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
    $("callback-when").classList.toggle("hidden", pendingOutcome !== "callback");
    $("outcome-error").textContent = "";
  }));
  loadNextLead();
  loadAgentToday();
  pollInt = setInterval(checkCallbacks, 30000);
}

function renderLead(lead, isCallback) {
  currentLead = lead;
  pendingCallbackLead = isCallback ? lead : null;
  $("lead-empty").classList.add("hidden");
  $("lead-card").classList.remove("hidden");
  $("outcome-panel").classList.add("hidden");
  $("timer-row").classList.add("hidden");
  clearInterval(timerInt); callStart = null;
  $("ld-name").textContent = lead.business_name;
  $("ld-city").textContent = lead.city || "—";
  $("ld-niche").textContent = lead.niche || "—";
  $("ld-rating").textContent = lead.rating ? `★ ${lead.rating} (${lead.reviews || 0})` : "no rating";
  $("ld-meta").textContent = lead.tab === "dm" ? `Meta ads: ${lead.meta_ads || "?"}` : (lead.tab === "website" ? "Website lead" : "");
  $("ld-phone").textContent = lead.phone;
  $("ld-phone").href = "tel:" + lead.phone.replace(/[^+\d]/g, "");
  const web = $("ld-website-wrap"), em = $("ld-email-wrap");
  if (lead.website) { web.classList.remove("hidden"); $("ld-website").textContent = lead.website; $("ld-website").href = lead.website.startsWith("http") ? lead.website : "https://" + lead.website; }
  else web.classList.add("hidden");
  if (lead.email) { em.classList.remove("hidden"); $("ld-email").textContent = lead.email; } else em.classList.add("hidden");
  $("ld-attempts").textContent = `Attempts: ${lead.attempts || 0}/${CONFIG.maxVoicemailAttempts} · Status: ${lead.status}`;
  $("ld-notes").textContent = lead.notes ? "Scraper note: " + lead.notes : "";
  const ok = goodToCall(lead.timezone);
  const badge = $("goodtime-badge");
  badge.textContent = ok ? `Good time to call (${timeIn(lead.timezone)})` : `Too early/late there (${timeIn(lead.timezone)})`;
  badge.className = "badge " + (ok ? "good" : "bad");
  $("clock-local-label").textContent = (lead.city || "Lead") + " local";
  $("clock-local").textContent = timeIn(lead.timezone);
  loadLeadHistory(lead.id);
  $("callback-banner").classList.add("hidden");
}

async function loadLeadHistory(leadId) {
  const { data } = await sb.from("calls").select("outcome,note,duration,created_at").eq("lead_id", leadId)
    .order("created_at", { ascending: false }).limit(10);
  $("ld-history").innerHTML = (data && data.length)
    ? "<b>Recent calls on this lead:</b>" + data.map((c) =>
      `<div>${new Date(c.created_at).toLocaleString()} — ${c.outcome}${c.duration ? ` (${fmtDuration(c.duration)})` : ""}${c.note ? ` — ${esc(c.note)}` : ""}</div>`).join("")
    : "";
}

async function loadNextLead(forceAny) {
  if (!profile) return;
  // 1) due callbacks first
  const { data: cb } = await sb.from("leads").select("*")
    .eq("assigned_to", session.user.id).eq("status", "callback")
    .eq("tab", currentTab).lte("callback_at", NOW())
    .order("callback_at", { ascending: true }).limit(1);
  if (cb && cb.length) { renderLead(cb[0], true); return; }
  // 2) pool: new + voicemail, callable now, in-window first
  const { data: pool } = await sb.from("leads").select("*")
    .eq("assigned_to", session.user.id).eq("tab", currentTab)
    .in("status", ["new", "voicemail"]).lte("next_call_at", NOW())
    .order("city", { ascending: true }).limit(500);
  const inWindow = (pool || []).filter((l) => goodToCall(l.timezone));
  const pick = inWindow[0] || (forceAny ? (pool || [])[0] : null);
  if (pick) { renderLead(pick, false); return; }
  // nothing
  currentLead = null;
  $("lead-card").classList.add("hidden");
  $("lead-empty").classList.remove("hidden");
  if (pool && pool.length) {
    // leads exist but all outside the calling window
    const hrs = pool.map((l) => localHour(l.timezone));
    const opensAt = Math.min(...hrs) < CONFIG.callWindowStart
      ? `${CONFIG.callWindowStart}:00 local (soonest city's morning)`
      : `${CONFIG.callWindowStart}:00 local tomorrow`;
    $("empty-title").textContent = "Outside calling hours";
    $("empty-msg").textContent = `You have ${pool.length} lead(s) left, all outside ${CONFIG.callWindowStart} AM–${CONFIG.callWindowEnd} PM their local time. Queue reopens about ${opensAt}.`;
    $("btn-show-anyway").classList.remove("hidden");
  } else {
    const { count } = await sb.from("leads").select("id", { count: "exact", head: true })
      .eq("assigned_to", session.user.id).eq("tab", currentTab).in("status", ["new", "voicemail"]);
    $("empty-title").textContent = count ? "Nothing due right now" : "No leads assigned";
    $("empty-msg").textContent = count
      ? "Voicemail retries return after 24 hours. Check again later."
      : "Ask the admin to upload leads and include you in the split.";
    $("btn-show-anyway").classList.add("hidden");
  }
}

function startCall() {
  if (!currentLead) return;
  callStart = Date.now();
  $("timer-row").classList.remove("hidden");
  timerInt = setInterval(() => {
    $("call-timer").textContent = fmtDuration(Math.floor((Date.now() - callStart) / 1000));
  }, 1000);
  $("call-timer").textContent = "00:00";
  window.open("tel:" + currentLead.phone.replace(/[^+\d]/g, ""), "_self");
}

function showOutcomePanel() {
  clearInterval(timerInt);
  $("outcome-panel").classList.remove("hidden");
}

async function saveOutcome() {
  if (!currentLead || !pendingOutcome) { $("outcome-error").textContent = "Pick an outcome first."; return; }
  const lead = currentLead;
  const now = new Date();
  const patch = { last_called_at: NOW() };
  let noteExtra = "";
  switch (pendingOutcome) {
    case "voicemail": {
      const att = (lead.attempts || 0) + 1;
      patch.attempts = att;
      if (att >= CONFIG.maxVoicemailAttempts) { patch.status = "no_answer"; noteExtra = " (max attempts reached)"; }
      else { patch.status = "voicemail"; patch.next_call_at = new Date(now.getTime() + CONFIG.voicemailRetryHours * 3600e3).toISOString(); }
      break;
    }
    case "callback": {
      const v = $("cb-datetime").value;
      if (!v) { $("outcome-error").textContent = "Choose the callback date and time."; return; }
      // agent enters the lead's LOCAL time; store exact instant via that zone
      patch.status = "callback";
      patch.callback_at = localToISO(v, lead.timezone);
      break;
    }
    default:
      patch.status = pendingOutcome;
      if (["not_interested", "dnc", "wrong_number", "meeting", "interested"].includes(pendingOutcome)) {
        patch.next_call_at = new Date(now.getTime() + 3650 * 24 * 3600e3).toISOString();
      }
  }
  const duration = callStart ? Math.floor((Date.now() - callStart) / 1000) : 0;
  const note = ($("call-note").value.trim() + noteExtra).trim();
  const { error: cErr } = await sb.from("calls").insert({
    lead_id: lead.id, agent_id: session.user.id,
    outcome: pendingOutcome, duration, note: note || null,
  });
  if (cErr) { $("outcome-error").textContent = cErr.message; return; }
  const { error: lErr } = await sb.from("leads").update(patch).eq("id", lead.id);
  if (lErr) { $("outcome-error").textContent = lErr.message; return; }
  pendingOutcome = null;
  $("call-note").value = ""; $("cb-datetime").value = "";
  $("outcome-btns").querySelectorAll("button").forEach((x) => x.classList.remove("active"));
  loadNextLead();
  loadAgentToday();
}

/* datetime-local (interpreted in the lead's tz) -> ISO instant */
function localToISO(localStr, tz) {
  const naive = new Date(localStr); // parsed as browser-local; we only use its wall clock
  const wall = localStr.replace("T", " ");
  const utcGuess = new Date(wall + " UTC");
  if (isNaN(utcGuess)) return naive.toISOString();
  const asTz = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(utcGuess);
  const m = asTz.match(/(\d+)\/(\d+)\/(\d+),?\s*(\d+):(\d+):(\d+)/);
  const mapped = new Date(Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4] % 24, +m[5], +m[6]));
  return new Date(utcGuess.getTime() + (utcGuess.getTime() - mapped.getTime())).toISOString();
}

async function checkCallbacks() {
  if (!profile || profile.is_admin) return;
  const { count } = await sb.from("leads").select("id", { count: "exact", head: true })
    .eq("assigned_to", session.user.id).eq("status", "callback")
    .eq("tab", currentTab).lte("callback_at", NOW());
  const due = count || 0;
  const onCallback = currentLead && currentLead.status === "callback";
  if (due > 0 && !onCallback) {
    $("callback-banner-name").textContent = due > 1 ? `${due} callbacks` : "1 callback";
    $("callback-banner").classList.remove("hidden");
    beep();
    $("callback-banner-take").onclick = () => loadNextLead();
  } else {
    $("callback-banner").classList.add("hidden");
  }
}

async function loadAgentToday() {
  const { data } = await sb.from("calls").select("outcome").eq("agent_id", session.user.id)
    .gte("created_at", pktDayStartISO());
  const counts = {};
  (data || []).forEach((c) => { counts[c.outcome] = (counts[c.outcome] || 0) + 1; });
  const rows = Object.entries(counts).map(([k, v]) => `<tr><td>${k.replace(/_/g, " ")}</td><td>${v}</td></tr>`);
  $("agent-today-stats").innerHTML = rows.length
    ? `<table>${rows.join("")}</table><p class="hint">${(data || []).length} calls total</p>`
    : '<p class="muted">No calls yet today.</p>';
}

/* ================= ADMIN ================= */
const STATUS_LABELS = {
  new: "New", voicemail: "Voicemail", callback: "Callback", interested: "Interested",
  meeting: "Meeting booked", not_interested: "Not interested", dnc: "Do not call",
  wrong_number: "Wrong number", no_answer: "No answer",
};

async function initAdmin() {
  $("admin-name").textContent = "Admin: " + profile.name;
  showView("view-admin");
  $("btn-logout2").addEventListener("click", doLogout);
  $("admin-tabs").querySelectorAll(".atab").forEach((b) => b.addEventListener("click", () => {
    $("admin-tabs").querySelectorAll(".atab").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".apane").forEach((p) => p.classList.add("hidden"));
    $("apane-" + b.dataset.atab).classList.remove("hidden");
    ({ upload: () => {}, agents: loadAgents, today: loadTodayStats, leads: () => { loadLeadFilters(); loadLeads(); }, callbacks: loadCallbacks, meetings: loadMeetings, backup: () => {} })[b.dataset.atab]?.();
  }));
  $("f-status").innerHTML = '<option value="">All statuses</option>' +
    Object.entries(STATUS_LABELS).map(([k, l]) => `<option value="${k}">${l}</option>`).join("");
  $("up-file").addEventListener("change", parseUploadFile);
  $("btn-upload").addEventListener("click", commitUpload);
  $("btn-filter").addEventListener("click", loadLeads);
  $("btn-del-filtered").addEventListener("click", deleteFiltered);
  $("btn-export-leads").addEventListener("click", () => exportCsv("leads"));
  $("btn-export-calls").addEventListener("click", () => exportCsv("calls"));
  $("btn-save-code").addEventListener("click", () => saveSignupCode($("signup-code-admin").value.trim()));
  $("btn-close-signups").addEventListener("click", () => { $("signup-code-admin").value = ""; saveSignupCode(""); });
  loadAgents();
  loadTodayStats();
}
async function saveSignupCode(code) {
  const { error } = await sb.from("app_settings").upsert({ key: "signup_code", value: code });
  toast("agents-msg", error ? error.message : (code ? "Signup code saved." : "Signups are now closed."));
}
async function loadSignupCode() {
  const { data } = await sb.from("app_settings").select("value").eq("key", "signup_code").maybeSingle();
  $("signup-code-admin").value = data?.value || "";
}

/* ---- agents ---- */
let agentsCache = [];
async function loadAgents() {
  loadSignupCode();
  const { data } = await sb.from("profiles").select("*").order("name");
  agentsCache = data || [];
  const tb = $("agents-tbl").querySelector("tbody");
  tb.innerHTML = agentsCache.map((a) => `<tr data-id="${a.id}">
    <td><b>${esc(a.name)}</b></td>
    ${["is_admin", "is_present", "can_website", "can_dm", "active"].map((f) =>
      `<td><input type="checkbox" data-field="${f}" ${a[f] ? "checked" : ""}></td>`).join("")}
    <td><button class="btn sm" data-redistrib="${a.id}">Redistribute open leads</button></td>
  </tr>`).join("");
  tb.querySelectorAll("input[type=checkbox]").forEach((c) => c.addEventListener("change", async () => {
    const id = c.closest("tr").dataset.id;
    const { error } = await sb.from("profiles").update({ [c.dataset.field]: c.checked }).eq("id", id);
    if (error) { c.checked = !c.checked; toast("agents-msg", error.message); }
    else toast("agents-msg", "Saved.");
  }));
  tb.querySelectorAll("[data-redistrib]").forEach((b) => b.addEventListener("click", () => redistribute(b.dataset.redistrib)));
}
async function presentAgentsFor(tab) {
  const { data } = await sb.from("profiles").select("*")
    .eq("is_present", true).eq("active", true).eq(tab === "website" ? "can_website" : "can_dm", true);
  return data || [];
}
async function redistribute(fromId) {
  const from = agentsCache.find((a) => a.id === fromId);
  if (!from) return;
  const { data: leads } = await sb.from("leads").select("*")
    .eq("assigned_to", fromId).in("status", ["new", "voicemail"]);
  if (!leads || !leads.length) { toast("agents-msg", `${from.name} has no open leads.`); return; }
  const targets = [];
  for (const l of leads) {
    const pool = await presentAgentsFor(l.tab);
    const others = pool.filter((p) => p.id !== fromId);
    const use = others.length ? others : pool;
    if (!use.length) { toast("agents-msg", "No present agents available for some tabs."); continue; }
    targets.push({ lead: l, agent: use[targets.length % use.length] });
  }
  let moved = 0;
  for (const t of targets) {
    const { error } = await sb.from("leads").update({ assigned_to: t.agent.id }).eq("id", t.lead.id);
    if (!error) moved++;
  }
  toast("agents-msg", `Moved ${moved} of ${leads.length} open lead(s) from ${from.name}. Callbacks stay with ${from.name} — move them in the Callbacks tab if needed.`);
}

/* ---- upload ---- */
function cleanPhone(p) {
  const digits = String(p || "").replace(/\D/g, "");
  if (digits.length === 11 && digits[0] === "1") return "+1 " + digits.slice(1, 4) + "-" + digits.slice(4, 7) + "-" + digits.slice(7);
  if (digits.length === 10) return "+1 " + digits.slice(0, 3) + "-" + digits.slice(3, 6) + "-" + digits.slice(6);
  return null;
}
function normNiche(n) {
  n = String(n || "").trim();
  if (/^roofers?$/i.test(n)) return "Roofing";
  return n;
}
async function parseUploadFile() {
  const f = $("up-file").files[0];
  $("up-preview").classList.add("hidden"); $("up-done").textContent = ""; $("up-error").textContent = "";
  if (!f) return;
  let wb;
  try { wb = XLSX.read(await f.arrayBuffer(), { type: "array" }); }
  catch (e) { $("up-error").textContent = "Could not read that file. Use the .xlsx export from your scraper."; return; }
  // find the sheet for the selected tab; ignore "Running Google Ads"
  const wanted = $("up-tab").value === "website" ? "website" : "digital";
  let sheetName = wb.SheetNames.find((n) => n.toLowerCase().includes(wanted)) ||
    wb.SheetNames.find((n) => !n.toLowerCase().includes("running google"));
  if (!sheetName) { $("up-error").textContent = "No usable sheet found in the file."; return; }
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "" });
  const seen = new Set(), valid = [];
  let noPhone = 0, dupFile = 0;
  for (const r of rows) {
    const phone = cleanPhone(r["Phone"]);
    if (!phone) { noPhone++; continue; }
    if (seen.has(phone)) { dupFile++; continue; }
    seen.add(phone);
    valid.push({
      tab: $("up-tab").value,
      business_name: String(r["Business Name"] || "").trim() || "Unknown",
      phone,
      city: String(r["City"] || "").trim(),
      rating: r["Rating"] !== "" ? +r["Rating"] : null,
      reviews: r["Reviews"] !== "" ? +r["Reviews"] : null,
      niche: normNiche(r["Niche"]),
      website: r["Domain"] ? String(r["Domain"]).trim() : null,
      email: r["Email"] ? String(r["Email"]).trim() : null,
      meta_ads: r["Meta Ads"] ? String(r["Meta Ads"]).trim() : null,
      notes: r["Notes"] ? String(r["Notes"]).trim().slice(0, 500) : null,
      timezone: tzFor(phone, r["City"]),
    });
  }
  // duplicates against DB
  const { data: existing } = await sb.from("leads").select("phone");
  const have = new Set((existing || []).map((x) => x.phone));
  const fresh = valid.filter((l) => !have.has(l.phone));
  const dupDb = valid.length - fresh.length;
  const agents = await presentAgentsFor($("up-tab").value);
  parsedUpload = { rows: fresh, filename: f.name, sheet: sheetName };
  $("up-preview").classList.remove("hidden");
  $("up-stats").innerHTML = [
    [`Sheet used`, `"${sheetName}"`],
    [`Rows in sheet`, rows.length],
    [`Skipped — no usable phone`, noPhone],
    [`Skipped — duplicate in file`, dupFile],
    [`Skipped — already in CRM`, dupDb],
    [`<b>Ready to upload</b>`, `<b>${fresh.length}</b>`],
  ].map(([k, v]) => `<li><span>${k}</span><span>${v}</span></li>`).join("");
  $("up-agents").textContent = agents.length
    ? agents.map((a) => a.name).join(", ")
    : "NOBODY — no present agents with access to this tab. Fix that in the Agents tab first.";
  $("btn-upload").disabled = !agents.length || !fresh.length;
}
async function commitUpload() {
  if (!parsedUpload) return;
  $("btn-upload").disabled = true;
  const agents = await presentAgentsFor(parsedUpload.rows[0].tab);
  if (!agents.length) { $("up-error").textContent = "No present agents for this tab."; return; }
  let added = 0, failed = 0;
  for (let i = 0; i < parsedUpload.rows.length; i += 500) {
    const chunk = parsedUpload.rows.slice(i, i + 500).map((l, j) => ({
      ...l, assigned_to: agents[Math.floor((i + j) * agents.length / parsedUpload.rows.length)].id,
    }));
    const { error } = await sb.from("leads").upsert(chunk, { onConflict: "phone", ignoreDuplicates: true });
    if (error) failed += chunk.length; else added += chunk.length;
  }
  await sb.from("uploads").insert({
    filename: parsedUpload.filename, tab: parsedUpload.rows[0].tab,
    added, skipped: parsedUpload.rows.length - added, created_by: session.user.id,
  });
  $("up-done").textContent = `Done: ${added} leads assigned (spread evenly across ${agents.length} agent(s)).${failed ? ` ${failed} failed.` : ""}`;
  parsedUpload = null;
}

/* ---- today stats ---- */
async function loadTodayStats() {
  const [{ data: calls }, { data: profs }] = await Promise.all([
    sb.from("calls").select("outcome, agent_id, leads(tab, business_name)").gte("created_at", pktDayStartISO()),
    sb.from("profiles").select("id, name"),
  ]);
  const nameOf = Object.fromEntries((profs || []).map((p) => [p.id, p.name]));
  const perAgent = {};
  (calls || []).forEach((c) => {
    const n = nameOf[c.agent_id] || "?";
    perAgent[n] = perAgent[n] || { total: 0 };
    perAgent[n][c.outcome] = (perAgent[n][c.outcome] || 0) + 1;
    perAgent[n].total++;
  });
  const meetings = (calls || []).filter((c) => c.outcome === "meeting");
  const totalCalls = (calls || []).length;
  const totalsHtml = `<div class="totals">
    <div class="box"><b>${totalCalls}</b>calls today</div>
    <div class="box"><b>${meetings.length}</b>meetings booked</div>
    <div class="box"><b>${Object.keys(perAgent).length}</b>agents on calls</div>
  </div>`;
  const rows = Object.entries(perAgent).sort((a, b) => b[1].total - a[1].total).map(([name, s]) => `<tr>
    <td><b>${esc(name)}</b></td><td>${s.total}</td>
    ${["voicemail", "callback", "interested", "meeting", "not_interested", "dnc", "wrong_number"].map((k) => `<td>${s[k] || 0}</td>`).join("")}
  </tr>`).join("");
  $("today-stats").innerHTML = totalsHtml + (rows ? `<table class="tbl"><thead>
    <tr><th>Agent</th><th>Calls</th><th>Voicemail</th><th>Callback</th><th>Interested</th><th>Meeting</th><th>Not int.</th><th>DNC</th><th>Wrong #</th></tr>
  </thead><tbody>${rows}</tbody></table>` : '<p class="muted">No calls yet today (since 5 AM PKT).</p>');
}

/* ---- leads browser ---- */
async function loadLeadFilters() {
  const { data } = await sb.from("profiles").select("id, name").order("name");
  $("f-agent").innerHTML = '<option value="">All agents</option>' +
    (data || []).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
}
async function loadLeads() {
  let q = sb.from("leads").select("id,business_name,phone,city,tab,status,assigned_to,attempts,profiles(name)")
    .order("id", { ascending: false }).limit(500);
  if ($("f-tab").value) q = q.eq("tab", $("f-tab").value);
  if ($("f-status").value) q = q.eq("status", $("f-status").value);
  if ($("f-agent").value) q = q.eq("assigned_to", $("f-agent").value);
  if ($("f-city").value.trim()) q = q.ilike("city", "%" + $("f-city").value.trim() + "%");
  const { data, error } = await q;
  if (error) { $("leads-msg").textContent = error.message; return; }
  const agentOpts = '<option value="">— agent —</option>' + agentsCache.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join("");
  $("leads-tbl").querySelector("tbody").innerHTML = (data || []).map((l) => `<tr data-id="${l.id}">
    <td>${esc(l.business_name)}</td><td>${esc(l.phone)}</td><td>${esc(l.city || "")}</td>
    <td>${l.tab === "website" ? "Website" : "DM"}</td>
    <td><span class="status-pill st-${l.status}">${STATUS_LABELS[l.status] || l.status}</span></td>
    <td>${esc(l.profiles?.name || "—")}</td><td>${l.attempts || 0}</td>
    <td class="nowrap">
      <select data-reassign>${agentOpts}</select>
      <button class="btn sm" data-reopen>Reopen</button>
      <button class="btn danger sm" data-del>Delete</button>
    </td>
  </tr>`).join("");
  $("leads-msg").textContent = `${(data || []).length} shown (max 500, newest first).`;
  const tb = $("leads-tbl").querySelector("tbody");
  tb.querySelectorAll("[data-reopen]").forEach((b) => b.addEventListener("click", async () => {
    const id = b.closest("tr").dataset.id;
    const { error } = await sb.from("leads").update({ status: "new", attempts: 0, next_call_at: NOW(), callback_at: null }).eq("id", id);
    toast("leads-msg", error ? error.message : "Lead reopened.");
    if (!error) loadLeads();
  }));
  tb.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this lead permanently?")) return;
    const { error } = await sb.from("leads").delete().eq("id", b.closest("tr").dataset.id);
    toast("leads-msg", error ? error.message : "Deleted.");
    if (!error) loadLeads();
  }));
  tb.querySelectorAll("[data-reassign]").forEach((s) => s.addEventListener("change", async () => {
    if (!s.value) return;
    const { error } = await sb.from("leads").update({ assigned_to: s.value, status: "new", next_call_at: NOW(), callback_at: null })
      .eq("id", s.closest("tr").dataset.id);
    toast("leads-msg", error ? error.message : "Reassigned and reopened.");
    if (!error) loadLeads();
  }));
}
async function deleteFiltered() {
  if (!confirm("Delete ALL filtered leads with status Do not call or Wrong number? This cannot be undone.")) return;
  let q = sb.from("leads").delete().in("status", ["dnc", "wrong_number"]);
  if ($("f-tab").value) q = q.eq("tab", $("f-tab").value);
  if ($("f-agent").value) q = q.eq("assigned_to", $("f-agent").value);
  if ($("f-city").value.trim()) q = q.ilike("city", "%" + $("f-city").value.trim() + "%");
  const { error } = await q;
  toast("leads-msg", error ? error.message : "Filtered DNC / wrong-number leads deleted.");
  if (!error) loadLeads();
}

/* ---- callbacks ---- */
async function loadCallbacks() {
  const { data } = await sb.from("leads").select("id,business_name,phone,city,timezone,callback_at,profiles(name)")
    .eq("status", "callback").order("callback_at", { ascending: true }).limit(500);
  const agentOpts = '<option value="">— move —</option>' + agentsCache.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join("");
  $("callbacks-tbl").querySelector("tbody").innerHTML = (data || []).map((l) => `<tr data-id="${l.id}">
    <td>${new Date(l.callback_at).toLocaleString("en-US", { timeZone: l.timezone })} <span class="muted">(${esc(l.timezone.split("/")[1] || "")})</span></td>
    <td>${esc(l.business_name)}</td><td>${esc(l.phone)}</td><td>${esc(l.profiles?.name || "—")}</td>
    <td><select data-move>${agentOpts}</select></td>
  </tr>`).join("");
  $("callbacks-msg").textContent = `${(data || []).length} callback(s). Times shown in each lead's local time.`;
  $("callbacks-tbl").querySelectorAll("[data-move]").forEach((s) => s.addEventListener("change", async () => {
    if (!s.value) return;
    const { error } = await sb.from("leads").update({ assigned_to: s.value }).eq("id", s.closest("tr").dataset.id);
    toast("callbacks-msg", error ? error.message : "Callback moved.");
    if (!error) loadCallbacks();
  }));
}

/* ---- meetings ---- */
async function loadMeetings() {
  const { data } = await sb.from("leads").select("id,business_name,phone,city,last_called_at,profiles(name)")
    .eq("status", "meeting").order("last_called_at", { ascending: false }).limit(500);
  $("meetings-tbl").querySelector("tbody").innerHTML = (data || []).map((l) => `<tr>
    <td>${l.last_called_at ? new Date(l.last_called_at).toLocaleString() : ""}</td>
    <td><b>${esc(l.business_name)}</b></td><td>${esc(l.phone)}</td><td>${esc(l.city || "")}</td>
    <td>${esc(l.profiles?.name || "—")}</td>
  </tr>`).join("");
  $("meetings-msg").textContent = `${(data || []).length} meeting(s) booked. Hand these to the ads manager.`;
}

/* ---- backup ---- */
async function exportCsv(table) {
  const { data, error } = await sb.from(table).select("*").limit(100000);
  if (error) { toast("backup-msg", error.message); return; }
  const rows = data || [];
  if (!rows.length) { toast("backup-msg", "Nothing to export yet."); return; }
  const cols = Object.keys(rows[0]);
  const csv = [cols.join(",")].concat(rows.map((r) =>
    cols.map((c) => `"${String(r[c] ?? "").replace(/"/g, '""')}"`).join(","))).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `${table}-backup-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  toast("backup-msg", `Exported ${rows.length} rows.`);
}

/* ---------- init ---------- */
$("btn-login").addEventListener("click", doLogin);
$("login-pass").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
$("btn-show-signup").addEventListener("click", () => $("signup-box").classList.toggle("hidden"));
$("btn-signup").addEventListener("click", doSignup);
$("up-tab").addEventListener("change", parseUploadFile);
boot();

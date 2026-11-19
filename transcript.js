/* A2Z CRM — live call transcript (agent + customer) and end-of-call summary.
   Speech-to-text runs in the agent's browser (free). One speech worker PER speaker, so the agent's
   and the customer's voice are transcribed in parallel. The summary is made by a Supabase Edge Function. */
"use strict";

const TX = {
  on: false, recording: false, workers: {}, ready: {}, loadPct: {}, device: "",
  mic: null, disp: null, taps: [], bag: {}, pend: {}, seq: 0, leadId: null, runId: 0,
};

/* ---- speech worker (runs inside a Web Worker; written as a function so it is easy to read) ---- */
function txWorkerBody() {
  let asr = null, model = "", onGpu = false, lib = null, chain = Promise.resolve();
  const load = async (device) => {
    lib = lib || await import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2");
    lib.env.allowLocalModels = false;
    return lib.pipeline("automatic-speech-recognition", model, {
      device,
      progress_callback: (p) => { if (p.status === "progress") self.postMessage({ type: "progress", pct: Math.round(p.progress || 0) }); },
    });
  };
  const init = async (m) => {
    model = m.model;
    const order = (m.device !== "wasm" && self.navigator && navigator.gpu) ? ["webgpu", "wasm"] : ["wasm"];
    let err = null;
    for (const d of order) {
      try { asr = await load(d); onGpu = d === "webgpu"; self.postMessage({ type: "ready", device: d }); return; }
      catch (e) { err = e; }
    }
    self.postMessage({ type: "error", message: String((err && err.message) || err) });
  };
  const run = async (audio) => {
    const opts = /\.en$/.test(model) ? {} : { language: "english", task: "transcribe" };
    try { const o = await asr(audio, opts); return (o && o.text) || ""; }
    catch (e) {
      if (onGpu) {                                   // graphics card failed: fall back to CPU and retry once
        onGpu = false;
        try { asr = await load("wasm"); const o = await asr(audio, opts); return (o && o.text) || ""; } catch (e2) {}
      }
      return "";
    }
  };
  self.onmessage = (e) => {
    const m = e.data;
    if (m.type === "init") chain = chain.then(() => init(m));
    else if (m.type === "audio") chain = chain.then(async () => {
      const text = asr ? await run(m.audio) : "";
      self.postMessage({ type: "text", id: m.id, speaker: m.speaker, t: m.t, runId: m.runId, text });
    });
  };
}

const TX_JUNK = /^\s*[\[(].*[\])]\s*$/;
const TX_JUNK_WORDS = new Set(["", "you", "thank you.", "thanks for watching!", "thank you for watching.", "bye.", "."]);
function txClean(text) {
  const t = String(text || "").trim();
  if (TX_JUNK.test(t) || TX_JUNK_WORDS.has(t.toLowerCase())) return "";
  return t;
}

function txSetStatus(msg) { const el = $("tx-status"); if (el) el.textContent = msg || ""; }
function txSegs(run) { return TX.bag[run] || (TX.bag[run] = []); }
function txPendingNow() { return TX.pend[TX.runId] || 0; }

function txRenderLive() {
  const box = $("tx-live");
  if (!box) return;
  const segs = txSegs(TX.runId).slice().sort((a, b) => a.t - b.t);
  box.innerHTML = segs.length
    ? segs.map((s) => `<div class="tx-line ${s.speaker === "Agent" ? "agent" : "cust"}"><b>${s.speaker}</b> ${esc(s.text)}</div>`).join("")
    : '<div class="muted">Listening… text appears a moment after each sentence.</div>';
  box.scrollTop = box.scrollHeight;
}

function txLoadStatus() {
  const bothReady = TX.ready.Agent && TX.ready.Customer;
  if (bothReady) { txSetStatus(`● Transcript on${TX.device === "webgpu" ? " (fast mode)" : ""}`); return; }
  const pct = Math.min(TX.loadPct.Agent || 0, TX.loadPct.Customer || 0);
  txSetStatus(`● Loading speech model… ${pct}% (first time only)`);
}

/* ---- two workers: one per speaker ---- */
function txEnsureWorkers() {
  if (TX.workers.Agent) return;
  const url = URL.createObjectURL(new Blob(["(" + txWorkerBody.toString() + ")()"], { type: "text/javascript" }));
  ["Agent", "Customer"].forEach((sp) => {
    const w = new Worker(url, { type: "module" });
    TX.workers[sp] = w; TX.ready[sp] = false; TX.loadPct[sp] = 0;
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === "progress") { TX.loadPct[sp] = m.pct; if (TX.on && !(TX.ready.Agent && TX.ready.Customer)) txLoadStatus(); }
      else if (m.type === "ready") { TX.ready[sp] = true; TX.device = m.device; if (TX.on) txLoadStatus(); }
      else if (m.type === "error") { txSetStatus("Speech model failed: " + m.message); txStop(true); txKillWorkers(); }
      else if (m.type === "text") {
        TX.pend[m.runId] = Math.max(0, (TX.pend[m.runId] || 0) - 1);
        const text = txClean(m.text);
        if (text) { txSegs(m.runId).push({ t: m.t, speaker: m.speaker, text }); if (m.runId === TX.runId) txRenderLive(); }
      }
    };
    w.onerror = () => { txSetStatus("Speech engine could not start in this browser."); txStop(true); txKillWorkers(); };
    w.postMessage({ type: "init", model: CONFIG.transcribeModel || "Xenova/whisper-tiny.en", device: CONFIG.transcribeDevice || "auto" });
  });
}
function txKillWorkers() {
  Object.values(TX.workers).forEach((w) => { try { w.terminate(); } catch (e) {} });
  TX.workers = {}; TX.ready = {}; TX.loadPct = {};
}

/* ---- audio taps (one per speaker) ---- */
function txMakeTap(stream, speaker) {
  const ctx = new AudioContext({ sampleRate: 16000 });
  const src = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
  const proc = ctx.createScriptProcessor(2048, 1, 1);
  const mute = ctx.createGain(); mute.gain.value = 0;
  src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
  const tap = { speaker, ctx, proc, src, buf: [], len: 0, silent: 0, heard: false };
  proc.onaudioprocess = (e) => {
    if (!TX.recording) { tap.buf = []; tap.len = 0; tap.silent = 0; tap.heard = false; return; }
    const d = new Float32Array(e.inputBuffer.getChannelData(0));
    let sum = 0; for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
    const loud = Math.sqrt(sum / d.length) > 0.012;
    tap.buf.push(d); tap.len += d.length;
    tap.silent = loud ? 0 : tap.silent + d.length;
    if (loud) tap.heard = true;
    if (!tap.heard && tap.len > 16000) { tap.buf = []; tap.len = 0; return; }            // drop long silence
    // send a chunk after a short pause (0.4 s; 0.8 s if the speech engine is behind) or at 7 s max
    const pause = txPendingNow() > 2 ? 12800 : 6400;
    if (tap.heard && ((tap.len >= 14400 && tap.silent >= pause) || tap.len >= 112000)) txFlush(tap, false);
  };
  return tap;
}
function txFlush(tap, force) {
  if (!tap.len) return;
  const heard = tap.heard;
  const all = new Float32Array(tap.len);
  let o = 0; tap.buf.forEach((b) => { all.set(b, o); o += b.length; });
  tap.buf = []; tap.len = 0; tap.silent = 0; tap.heard = false;
  if (!heard || (!force && all.length < 8000) || all.length < 4000) return;
  const w = TX.workers[tap.speaker];
  if (!w) return;
  TX.pend[TX.runId] = (TX.pend[TX.runId] || 0) + 1;
  w.postMessage({ type: "audio", id: ++TX.seq, speaker: tap.speaker, t: Date.now(), runId: TX.runId, audio: all }, [all.buffer]);
}

/* ---- start / stop capture (once per shift) ---- */
async function txStart(auto) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.Worker) {
    txSetStatus("This browser can't do it. Use Chrome or Edge on Windows."); return;
  }
  const raw = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  try {
    TX.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const want = (CONFIG.customerDeviceLabel || "").toLowerCase();      // optional: virtual cable name, skips screen share
    let dev = null;
    if (want) dev = (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === "audioinput" && d.label.toLowerCase().includes(want));
    if (auto && !dev) { txStop(true); txSetStatus("Auto transcript: virtual audio device \"" + CONFIG.customerDeviceLabel + "\" not found. Check the cable is installed, then click Start."); return; }
    if (dev) {
      TX.disp = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: dev.deviceId }, ...raw } });
    } else {
      txSetStatus("In the share window pick the call app (or its tab) and tick “Share audio”, then click Share.");
      TX.disp = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 1 }, audio: raw, selfBrowserSurface: "exclude", systemAudio: "include",
      });
      if (!TX.disp.getAudioTracks().length) {
        txStop(true); txSetStatus("No audio was shared. Click again, choose the call app and tick “Share audio”."); return;
      }
      const vt = TX.disp.getVideoTracks()[0];
      const surface = vt && vt.getSettings ? vt.getSettings().displaySurface : "";
      if (surface === "monitor") txSetStatus("● Entire screen shared: ALL system sounds will be transcribed. Share only the call app/tab to avoid that.");
    }
  } catch (e) {
    txStop(true); txSetStatus("Not started: " + (e.name === "NotAllowedError" ? "permission was declined." : e.message)); return;
  }
  TX.auto = !!(auto || CONFIG.customerDeviceLabel);
  TX.disp.getTracks().forEach((t) => t.addEventListener("ended", () => { txStop(false); txAutoRetry(); }));
  txEnsureWorkers();
  TX.taps = [txMakeTap(TX.mic, "Agent"), txMakeTap(TX.disp, "Customer")];
  TX.on = true;
  $("btn-tx").textContent = "Stop live transcript";
  if (!/Entire screen/.test(($("tx-status")||{}).textContent || "")) txLoadStatus();
  if (callStart && currentLead) txBeginCall(currentLead);     // started mid-call
}
function txStop(silent) {
  if (TX.recording) txEndCall();            // flush + save what was said so far
  TX.on = false; TX.recording = false;
  TX.taps.forEach((t) => { try { t.proc.disconnect(); t.src.disconnect(); t.ctx.close(); } catch (e) {} });
  TX.taps = [];
  [TX.mic, TX.disp].forEach((s) => s && s.getTracks().forEach((t) => t.stop()));
  TX.mic = TX.disp = null;
  const b = $("btn-tx"); if (b) b.textContent = "Start live transcript";
  if (!silent) txSetStatus("Transcript stopped.");
}
function txAutoRetry() {                      // if the device drops, try to reconnect quietly
  if (!TX.auto || TX.retry) return;
  TX.retry = setTimeout(() => { TX.retry = null; if (!TX.on) txStart(true); }, 8000);
}
function txInit() {
  $("btn-tx").addEventListener("click", () => { TX.auto = false; TX.on ? txStop(false) : txStart(); });
  if (CONFIG.customerDeviceLabel) txStart(true);      // permanent mode: starts by itself, no share window
}

/* ---- per-call hooks (called from app.js) ---- */
function txBeginCall(lead) {
  TX.runId++; TX.leadId = lead.id; TX.bag[TX.runId] = []; TX.pend[TX.runId] = 0;
  $("tx-summary").classList.add("hidden"); $("tx-summary").textContent = "";
  if (!TX.on) { $("tx-live").classList.add("hidden"); return; }
  TX.recording = true;
  TX.taps.forEach((t) => { if (t.ctx.state === "suspended") t.ctx.resume(); });   // browsers pause audio until a click
  $("tx-live").classList.remove("hidden");
  txRenderLive();
}
function txReset() {
  TX.recording = false; TX.runId++;          // an unfinished save from the previous call keeps running on its own
  const live = $("tx-live"), sum = $("tx-summary");
  if (live) { live.classList.add("hidden"); live.innerHTML = ""; }
  if (sum) { sum.classList.add("hidden"); sum.textContent = ""; }
}
async function txEndCall() {
  if (!TX.recording) return;
  TX.recording = false;
  const run = TX.runId, leadId = TX.leadId;
  const duration = callStart ? Math.floor((Date.now() - callStart) / 1000) : 0;
  TX.taps.forEach((t) => txFlush(t, true));
  txSetStatus("Finishing transcript…");
  for (let i = 0; i < 240 && (TX.pend[run] || 0) > 0; i++) await new Promise((r) => setTimeout(r, 250));   // wait up to 60 s
  const segs = txSegs(run).slice().sort((a, b) => a.t - b.t);
  delete TX.bag[run]; delete TX.pend[run];
  const here = () => run === TX.runId;                    // false once the agent has moved to the next lead
  const show = (fn) => { if (here()) { const el = $("tx-summary"); el.classList.remove("hidden"); fn(el); } };
  if (here()) txSetStatus(TX.on ? "● Transcript on" : "");
  if (!segs.length) { show((el) => { el.textContent = "No speech was captured on this call."; }); return; }
  const text = segs.map((s) => `${s.speaker}: ${s.text}`).join("\n");
  show((el) => { el.textContent = "Saving transcript…"; });
  const { data, error } = await sb.from("call_transcripts")      // always saved, even if the agent already moved on
    .insert({ lead_id: leadId, agent_id: session.user.id, transcript: text, duration }).select("id").single();
  if (error || !data) { show((el) => { el.textContent = "Transcript captured but could not be saved (" + (error ? error.message : "unknown") + ")."; }); return; }
  show((el) => { el.textContent = "Writing summary…"; });
  const { data: res, error: fErr } = await sb.functions.invoke("summarize", { body: { action: "summarize", transcript_id: data.id } });
  const REASONS = {
    no_key: "Summary is off: no API key is connected (ask the admin).",
    off: "Summary is off: the admin set the daily limit to 0.",
    limit: "Daily summary limit reached. The transcript is saved.",
    api_error: "The summary service returned an error. The transcript is saved.",
  };
  if (fErr || !res) show((el) => { el.textContent = "Summary isn't set up yet. The transcript is saved."; });
  else if (res.ok) show((el) => { el.innerHTML = "<b>Call summary</b><br>" + esc(res.summary).replace(/\n/g, "<br>"); });
  else show((el) => { el.textContent = REASONS[res.reason] || res.message || "Summary unavailable. The transcript is saved."; });
  if (here() && currentLead && currentLead.id === leadId) txRenderPast(leadId);
}

/* ---- past summaries on a lead ---- */
async function txRenderPast(leadId) {
  const box = $("ld-tx-history");
  if (!box) return;
  box.innerHTML = "";
  const { data } = await sb.from("call_transcripts").select("transcript,summary,created_at")
    .eq("lead_id", leadId).order("created_at", { ascending: false }).limit(3);
  if (!data || !data.length || !currentLead || currentLead.id !== leadId) return;
  box.innerHTML = "<b>Past call transcripts:</b>" + data.map((r) =>
    `<div class="tx-past"><div>${new Date(r.created_at).toLocaleString()}</div>` +
    (r.summary ? `<div class="tx-sumtext">${esc(r.summary)}</div>` : "") +
    `<details><summary>Transcript</summary><pre class="tx-pre">${esc(r.transcript)}</pre></details></div>`).join("");
}

/* ---- admin: transcript history (all agents) ---- */
async function adminTxLoad() {
  const list = $("tx-admin-list"), msg = $("tx-admin-msg"), sel = $("tx-f-agent");
  if (!list) return;
  if (sel.options.length <= 1) {
    const { data: ps } = await sb.from("profiles").select("id,name").order("name");
    sel.innerHTML = '<option value="">All agents</option>' + (ps || []).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  }
  let q = sb.from("call_transcripts")
    .select("id,transcript,summary,duration,created_at,profiles(name),leads(business_name,phone)")
    .order("created_at", { ascending: false }).limit(100);
  if (sel.value) q = q.eq("agent_id", sel.value);
  const day = $("tx-f-day").value;
  if (day) {
    const a = new Date(day + "T00:00:00");
    q = q.gte("created_at", a.toISOString()).lt("created_at", new Date(a.getTime() + 864e5).toISOString());
  }
  msg.textContent = "Loading…";
  const { data, error } = await q;
  if (error) { msg.textContent = error.message; return; }
  list.innerHTML = (data || []).map((r) => `<div class="tx-admin-row" data-id="${r.id}">
    <div><b>${esc(r.leads?.business_name || "—")}</b> · ${esc(r.leads?.phone || "")} · ${esc(r.profiles?.name || "—")} ·
      ${new Date(r.created_at).toLocaleString()} · ${fmtDuration(r.duration || 0)}</div>
    <div class="tx-sumtext" data-sum>${r.summary ? esc(r.summary) : '<span class="muted">No summary.</span> <button class="btn ghost sm" data-make>Make summary</button>'}</div>
    <details><summary>Transcript</summary><pre class="tx-pre">${esc(r.transcript)}</pre></details></div>`).join("");
  msg.textContent = `${(data || []).length} shown (max 100, newest first).`;
  list.querySelectorAll("[data-make]").forEach((b) => b.addEventListener("click", async () => {
    const row = b.closest(".tx-admin-row"), slot = row.querySelector("[data-sum]");
    slot.textContent = "Writing summary…";
    const { data: res, error: e } = await sb.functions.invoke("summarize", { body: { action: "summarize", transcript_id: Number(row.dataset.id) } });
    slot.textContent = (!e && res && res.ok) ? res.summary : "Summary unavailable (" + ((res && (res.reason || res.message)) || (e && e.message) || "error") + ").";
  }));
}

/* ---- admin: summary status + daily limit ---- */
async function adminSummaryRefresh() {
  const el = $("sum-status");
  const { data, error } = await sb.functions.invoke("summarize", { body: { action: "status" } });
  if (error || !data) { el.textContent = "Summary function not deployed yet (see the setup steps)."; return; }
  $("sum-limit").value = data.limit;
  el.textContent = `API key: ${data.connected ? "connected" : "NOT connected"} · Used today: ${data.used} of ${data.limit}` +
    (data.limit <= 0 ? " · summaries are OFF (set a limit above 0)" : "");
}
function adminSummaryInit() {
  $("btn-sum-save").addEventListener("click", async () => {
    const n = Math.max(0, parseInt($("sum-limit").value, 10) || 0);
    const { error } = await sb.from("app_settings").upsert({ key: "summary_daily_limit", value: String(n) });
    toast("agents-msg", error ? error.message : `Daily summary limit saved: ${n}.`);
    adminSummaryRefresh();
  });
  const f = $("btn-tx-filter"); if (f) f.addEventListener("click", adminTxLoad);
  adminSummaryRefresh();
}

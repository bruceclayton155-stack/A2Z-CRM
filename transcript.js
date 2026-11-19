/* A2Z CRM — live call transcript (agent + customer) and end-of-call summary.
   Speech-to-text runs in the agent's browser (free). One speech worker PER speaker, so the agent's
   and the customer's voice are transcribed in parallel. The summary is made by a Supabase Edge Function. */
"use strict";

const TX = {
  on: false, recording: false, workers: {}, ready: {}, loadPct: {}, device: "",
  engine: "", recs: [], draining: false, mic: null, disp: null, taps: [], interim: {}, bag: {}, pend: {}, seq: 0, leadId: null, runId: 0,
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
    let gpu = false;
    if (m.device !== "wasm" && self.navigator && navigator.gpu) { try { gpu = !!(await navigator.gpu.requestAdapter()); } catch (e) {} }
    try { asr = await load(gpu ? "webgpu" : "wasm"); onGpu = gpu; self.postMessage({ type: "ready", device: gpu ? "webgpu" : "wasm" }); }
    catch (e) { self.postMessage(gpu ? { type: "fallback" } : { type: "error", message: String((e && e.message) || e) }); }
  };
  const run = async (audio) => {
    const opts = /\.en$/.test(model) ? {} : { language: "english", task: "transcribe" };
    try { const o = await asr(audio, opts); return (o && o.text) || ""; }
    catch (e) { if (onGpu) self.postMessage({ type: "fallback" }); return ""; }   // main restarts this engine on CPU
  };
  self.onmessage = (e) => {
    const m = e.data;
    if (m.type === "init") chain = chain.then(() => init(m));
    else if (m.type === "audio") chain = chain.then(async () => {
      const text = asr ? await run(m.audio) : "";
      self.postMessage({ type: "text", id: m.id, speaker: m.speaker, t: m.t, runId: m.runId, interim: !!m.interim, utt: m.utt, text });
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
  const live = Object.values(TX.interim).filter(Boolean).sort((a, b) => a.t - b.t);
  const line = (s, cls) => `<div class="tx-line ${s.speaker === "Agent" ? "agent" : "cust"}${cls}"><b>${s.speaker}</b> ${esc(s.text)}</div>`;
  box.innerHTML = (segs.length || live.length)
    ? segs.map((s) => line(s, "")).join("") + live.map((s) => line(s, " interim")).join("")
    : '<div class="muted">Listening… words appear as they are spoken.</div>';
  box.scrollTop = box.scrollHeight;
}

function txLoadStatus() {
  if (TX.engine === "browser") { txSetStatus("● Transcript on (live)"); return; }
  const bothReady = TX.ready.Agent && TX.ready.Customer;
  if (bothReady) { txSetStatus(`● Transcript on${TX.device === "webgpu" ? " (fast mode)" : ""}`); return; }
  const pct = Math.min(TX.loadPct.Agent || 0, TX.loadPct.Customer || 0);
  txSetStatus(`● Loading speech model… ${pct}% (first time only)`);
}

/* ---- two workers: one per speaker ---- */
function txSpawn(sp, device) {
  const w = new Worker(TX.url, { type: "module" });
  TX.workers[sp] = w; TX.ready[sp] = false; TX.loadPct[sp] = 0;
  w.onmessage = (e) => {
    const m = e.data;
    if (m.type === "progress") { TX.loadPct[sp] = m.pct; if (TX.on && !(TX.ready.Agent && TX.ready.Customer)) txLoadStatus(); }
    else if (m.type === "ready") { TX.ready[sp] = true; TX.device = m.device; if (TX.on) txLoadStatus(); }
    else if (m.type === "fallback") { try { w.terminate(); } catch (x) {} TX.taps.forEach((t) => { t.interimBusy = false; }); txSpawn(sp, "wasm"); }   // graphics card failed: use CPU
    else if (m.type === "error") { txSetStatus("Speech model failed: " + m.message); txStop(true); txKillWorkers(); }
    else if (m.type === "text") {
      const tap = TX.taps.find((t) => t.speaker === m.speaker);
      if (m.interim) {                                   // live partial text while the person is still talking
        if (tap) tap.interimBusy = false;
        if (tap && TX.recording && m.runId === TX.runId && m.utt === tap.utt) {
          const text = txClean(m.text);
          TX.interim[m.speaker] = text ? { t: m.t, speaker: m.speaker, text, utt: m.utt } : null;
          txRenderLive();
        }
        return;
      }
      TX.pend[m.runId] = Math.max(0, (TX.pend[m.runId] || 0) - 1);
      const text = txClean(m.text);
      if (text) txSegs(m.runId).push({ t: m.t, speaker: m.speaker, text });
      const cur = TX.interim[m.speaker];
      if (cur && cur.utt === m.utt) TX.interim[m.speaker] = null;     // the final text replaces the live text
      if (m.runId === TX.runId) txRenderLive();
    }
  };
  w.onerror = () => { txSetStatus("Speech engine could not start in this browser."); txStop(true); txKillWorkers(); };
  w.postMessage({ type: "init", model: CONFIG.transcribeModel || "Xenova/whisper-tiny.en", device });
}
function txEnsureWorkers() {
  if (TX.workers.Agent) return;
  TX.url = URL.createObjectURL(new Blob(["(" + txWorkerBody.toString() + ")()"], { type: "text/javascript" }));
  ["Agent", "Customer"].forEach((sp) => txSpawn(sp, CONFIG.transcribeDevice || "auto"));
}
function txKillWorkers() {
  Object.values(TX.workers).forEach((w) => { try { w.terminate(); } catch (e) {} });
  TX.workers = {}; TX.ready = {}; TX.loadPct = {};
}

/* ---- fast engine: Chrome's built-in speech recognition (true live words). Audio goes to Google's speech service. ---- */
function txPickEngine() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const ver = parseInt(((navigator.userAgent.match(/Chrome\/(\d+)/) || [])[1]) || "0", 10);
  if (CONFIG.transcribeEngine === "whisper" || !SR || ver < 139) return "whisper";   // start(track) needs Chrome 139+
  return "browser";
}
function txStartRecs() {
  TX.recs = [
    { speaker: "Agent", track: TX.mic.getAudioTracks()[0], alive: true, fails: 0, r: null },
    { speaker: "Customer", track: TX.disp.getAudioTracks()[0], alive: true, fails: 0, r: null },
  ];
  TX.recs.forEach(txRecRun);
}
function txRecFallback(msg) {
  if (TX.engine !== "browser") return;
  TX.recs.forEach((x) => { x.alive = false; try { x.r.abort(); } catch (e) {} }); TX.recs = [];
  TX.engine = "whisper"; txEnsureWorkers();
  txSetStatus(msg + " Using offline mode (slower).");
}
function txRecRun(rec) {
  if (!rec.alive) return;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const r = new SR();
  r.continuous = true; r.interimResults = true; r.maxAlternatives = 1; r.lang = CONFIG.transcribeLang || "en-US";
  r.onresult = (e) => {
    rec.fails = 0;
    if (!TX.recording && !TX.draining) return;
    let interim = "";
    const prev = TX.interim[rec.speaker];
    const t0 = prev ? prev.t : Date.now();
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i], text = res[0].transcript.trim();
      if (res.isFinal) { if (text) txSegs(TX.runId).push({ t: t0, speaker: rec.speaker, text }); TX.interim[rec.speaker] = null; }
      else interim += text + " ";
    }
    if (interim.trim()) TX.interim[rec.speaker] = { t: TX.interim[rec.speaker] ? TX.interim[rec.speaker].t : t0, speaker: rec.speaker, text: interim.trim(), utt: 0 };
    txRenderLive();
  };
  r.onerror = (ev) => {
    if (["not-allowed", "service-not-allowed", "language-not-supported", "audio-capture"].includes(ev.error) || (ev.error === "network" && ++rec.fails >= 3)) {
      rec.alive = false; txRecFallback("Live speech service unavailable (" + ev.error + ").");
    }
  };
  r.onend = () => { if (rec.alive) setTimeout(() => txRunSafe(rec), 250); };       // Chrome ends sessions now and then: restart
  rec.r = r;
  try { r.start(rec.track); } catch (e) { rec.alive = false; txRecFallback("Live speech could not start."); }
}
function txRunSafe(rec) { if (TX.on && rec.alive) txRecRun(rec); }

/* ---- audio taps (one per speaker) ---- */
function txMakeTap(stream, speaker) {
  const ctx = new AudioContext({ sampleRate: 16000 });
  const src = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
  const proc = ctx.createScriptProcessor(2048, 1, 1);
  const mute = ctx.createGain(); mute.gain.value = 0;
  src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
  const tap = { speaker, ctx, proc, src, buf: [], len: 0, silent: 0, heard: false, utt: 0, interimBusy: false, lastInterim: 0 };
  proc.onaudioprocess = (e) => {
    if (!TX.recording || TX.engine === "browser") { tap.buf = []; tap.len = 0; tap.silent = 0; tap.heard = false; return; }
    const d = new Float32Array(e.inputBuffer.getChannelData(0));
    let sum = 0; for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
    const loud = Math.sqrt(sum / d.length) > 0.012;
    tap.buf.push(d); tap.len += d.length;
    tap.silent = loud ? 0 : tap.silent + d.length;
    if (loud) tap.heard = true;
    if (!tap.heard && tap.len > 16000) { tap.buf = []; tap.len = 0; return; }            // drop long silence
    // final chunk: after a 0.5 s pause (0.8 s if the engine is behind) or at 8 s max
    const pause = txPendingNow() > 2 ? 12800 : 8000;
    if (tap.heard && ((tap.len >= 14400 && tap.silent >= pause) || tap.len >= 128000)) { txFlush(tap, false); return; }
    // live partial text: re-read what has been said so far about every 1.2 s while the person is talking
    const now = Date.now();
    if (tap.heard && tap.len >= 12000 && now - tap.lastInterim >= 1200 && (!tap.interimBusy || now - tap.lastInterim > 10000) && txPendingNow() === 0) txInterim(tap);
  };
  return tap;
}
function txInterim(tap) {
  const w = TX.workers[tap.speaker];
  if (!w || !TX.ready[tap.speaker]) return;
  const all = new Float32Array(tap.len);
  let o = 0; tap.buf.forEach((b) => { all.set(b, o); o += b.length; });
  tap.interimBusy = true; tap.lastInterim = Date.now();
  w.postMessage({ type: "audio", interim: true, utt: tap.utt, speaker: tap.speaker, t: Date.now(), runId: TX.runId, audio: all }, [all.buffer]);
}
function txFlush(tap, force) {
  if (!tap.len) return;
  const utt = tap.utt; tap.utt++;
  const heard = tap.heard;
  const all = new Float32Array(tap.len);
  let o = 0; tap.buf.forEach((b) => { all.set(b, o); o += b.length; });
  tap.buf = []; tap.len = 0; tap.silent = 0; tap.heard = false;
  if (!heard || (!force && all.length < 8000) || all.length < 4000) { TX.interim[tap.speaker] = null; return; }
  const w = TX.workers[tap.speaker];
  if (!w) return;
  TX.pend[TX.runId] = (TX.pend[TX.runId] || 0) + 1;
  w.postMessage({ type: "audio", id: ++TX.seq, utt, speaker: tap.speaker, t: Date.now(), runId: TX.runId, audio: all }, [all.buffer]);
}

/* ---- start / stop capture (once per shift) ---- */
/* mode: "load" = page opened (cable only, silent), "call" = first call click (share window if no cable), undefined = button */
async function txStart(mode) {
  if (TX.starting) return;
  TX.starting = true;
  try { await txStartInner(mode); } finally { TX.starting = false; }
}
async function txStartInner(mode) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.Worker) {
    txSetStatus("This browser can't do it. Use Chrome or Edge on Windows."); return;
  }
  const raw = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  const micOpts = { audio: { echoCancellation: true, noiseSuppression: true } };
  let dev = null;
  try {
    const want = (CONFIG.customerDeviceLabel || "").toLowerCase();      // optional: virtual cable name, skips screen share
    if (want) {
      const find = async () => (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === "audioinput" && d.label.toLowerCase().includes(want));
      dev = await find();
      if (!dev) {                                                       // device names stay hidden until mic permission is given
        const all = await navigator.mediaDevices.enumerateDevices();
        if (all.some((d) => d.kind === "audioinput" && !d.label)) {
          const t = await navigator.mediaDevices.getUserMedia({ audio: true }); t.getTracks().forEach((x) => x.stop());
          dev = await find();
        }
      }
    }
    if (mode === "load" && !dev) {
      txSetStatus(want ? "Virtual cable not found: the share window will open when you start your first call." : "");
      return;
    }
    if (dev) {
      TX.mic = await navigator.mediaDevices.getUserMedia(micOpts);
      TX.disp = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: dev.deviceId }, ...raw } });
    } else {
      txSetStatus("In the share window pick the call app (or its tab) and tick “Share audio”, then click Share.");
      TX.disp = await navigator.mediaDevices.getDisplayMedia({      // first: needs the click that started it
        video: { frameRate: 1 }, audio: raw, selfBrowserSurface: "exclude", systemAudio: "include",
      });
      if (!TX.disp.getAudioTracks().length) {
        txStop(true); txSetStatus("No audio was shared. Click “Start live transcript”, choose the call app and tick “Share audio”."); return;
      }
      const vt = TX.disp.getVideoTracks()[0];
      const surface = vt && vt.getSettings ? vt.getSettings().displaySurface : "";
      if (surface === "monitor") txSetStatus("● Entire screen shared: ALL system sounds will be transcribed. Share only the call app/tab to avoid that.");
      TX.mic = await navigator.mediaDevices.getUserMedia(micOpts);
    }
  } catch (e) {
    txStop(true);
    if (e.name === "NotAllowedError") TX.declined = true;              // do not ask again on every call
    txSetStatus("Not started: " + (e.name === "NotAllowedError" ? "permission was declined or the share window was closed. Click “Start live transcript” to try again." : e.message)); return;
  }
  TX.auto = !!dev;
  TX.disp.getTracks().forEach((t) => t.addEventListener("ended", () => { txStop(false); txAutoRetry(); }));
  TX.taps = [txMakeTap(TX.mic, "Agent"), txMakeTap(TX.disp, "Customer")];
  TX.engine = txPickEngine();
  if (TX.engine === "browser") txStartRecs(); else txEnsureWorkers();
  TX.on = true;
  $("btn-tx").textContent = "Stop live transcript";
  if (!/Entire screen/.test(($("tx-status") || {}).textContent || "")) txLoadStatus();
  if (callStart && currentLead) txBeginCall(currentLead);     // started by the call click
}
function txStop(silent) {
  if (TX.recording) txEndCall();            // flush + save what was said so far
  TX.on = false; TX.recording = false;
  TX.taps.forEach((t) => { try { t.proc.disconnect(); t.src.disconnect(); t.ctx.close(); } catch (e) {} });
  TX.taps = [];
  TX.recs.forEach((x) => { x.alive = false; try { x.r.abort(); } catch (e) {} }); TX.recs = [];
  [TX.mic, TX.disp].forEach((s) => s && s.getTracks().forEach((t) => t.stop()));
  TX.mic = TX.disp = null;
  const b = $("btn-tx"); if (b) b.textContent = "Start live transcript";
  if (!silent) txSetStatus("Transcript stopped.");
}
function txAutoRetry() {                      // if the device drops, try to reconnect quietly
  if (!TX.auto || TX.retry) return;
  TX.retry = setTimeout(() => { TX.retry = null; if (!TX.on) txStart("load"); }, 8000);
}
function txInit() {
  $("btn-tx").addEventListener("click", () => { TX.auto = false; TX.declined = false; TX.on ? txStop(false) : txStart(); });
  if (CONFIG.customerDeviceLabel) txStart("load");    // cable installed: starts by itself, no share window
}

/* ---- per-call hooks (called from app.js) ---- */
function txBeginCall(lead) {
  if (!TX.on && !TX.starting && !TX.declined) txStart("call");     // first call: start by itself (share window if no cable)
  TX.runId++; TX.leadId = lead.id; TX.bag[TX.runId] = []; TX.pend[TX.runId] = 0; TX.interim = {};
  $("tx-summary").classList.add("hidden"); $("tx-summary").textContent = "";
  if (!TX.on) { $("tx-live").classList.add("hidden"); return; }
  TX.recording = true;
  TX.taps.forEach((t) => { if (t.ctx.state === "suspended") t.ctx.resume(); });   // browsers pause audio until a click
  $("tx-live").classList.remove("hidden");
  txRenderLive();
}
function txReset() {
  TX.recording = false; TX.runId++; TX.interim = {};          // an unfinished save from the previous call keeps running on its own
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
  if (TX.engine === "browser") {                          // let the last words finish, then keep the unfinished sentence
    TX.draining = true; await new Promise((r) => setTimeout(r, 700)); TX.draining = false;
    if (run === TX.runId) { Object.values(TX.interim).forEach((i) => { if (i && i.text) txSegs(run).push({ t: i.t, speaker: i.speaker, text: i.text }); }); TX.interim = {}; }
  }
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
  else show((el) => { el.textContent = (REASONS[res.reason] || res.message || "Summary unavailable. The transcript is saved.") + (res.reason === "api_error" && res.message ? " [" + res.message + "]" : ""); });
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

/* A2Z CRM — live call transcript (agent + customer) and end-of-call summary.
   Speech-to-text runs in the agent's browser (free). The summary is made by a Supabase Edge Function
   ("summarize") that holds the API key and enforces the daily limit. */
"use strict";

const TX = {
  on: false, recording: false, worker: null, workerReady: false, loadPct: 0,
  mic: null, disp: null, taps: [], segs: [], pending: 0, seq: 0, leadId: null, runId: 0,
};

const TX_WORKER_SRC = [
  'import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2";',
  'env.allowLocalModels = false;',
  'let asr = null, model = "", chain = Promise.resolve();',
  'self.onmessage = (e) => {',
  '  const m = e.data;',
  '  if (m.type === "init") {',
  '    model = m.model;',
  '    chain = chain.then(async () => {',
  '      try {',
  '        asr = await pipeline("automatic-speech-recognition", m.model, { device: m.device,',
  '          progress_callback: (p) => { if (p.status === "progress") self.postMessage({ type: "progress", pct: Math.round(p.progress || 0) }); } });',
  '        self.postMessage({ type: "ready" });',
  '      } catch (err) { self.postMessage({ type: "error", message: String((err && err.message) || err) }); }',
  '    });',
  '  } else if (m.type === "audio") {',
  '    chain = chain.then(async () => {',
  '      let text = "";',
  '      try {',
  '        if (asr) {',
  '          const opts = /\\.en$/.test(model) ? {} : { language: "english", task: "transcribe" };',
  '          const out = await asr(m.audio, opts);',
  '          text = (out && out.text) || "";',
  '        }',
  '      } catch (err) { /* skip this chunk */ }',
  '      self.postMessage({ type: "text", id: m.id, speaker: m.speaker, t: m.t, runId: m.runId, text });',
  '    });',
  '  }',
  '};',
].join("\n");

const TX_JUNK = /^\s*[\[(].*[\])]\s*$/;
const TX_JUNK_WORDS = new Set(["", "you", "thank you.", "thanks for watching!", "thank you for watching.", "bye.", "."]);
function txClean(text) {
  const t = String(text || "").trim();
  if (TX_JUNK.test(t) || TX_JUNK_WORDS.has(t.toLowerCase())) return "";
  return t;
}

function txSetStatus(msg) { const el = $("tx-status"); if (el) el.textContent = msg || ""; }

function txRenderLive() {
  const box = $("tx-live");
  if (!box) return;
  const segs = TX.segs.slice().sort((a, b) => a.t - b.t);
  box.innerHTML = segs.length
    ? segs.map((s) => `<div class="tx-line ${s.speaker === "Agent" ? "agent" : "cust"}"><b>${s.speaker}</b> ${esc(s.text)}</div>`).join("")
    : '<div class="muted">Listening… text appears a few seconds after each sentence.</div>';
  box.scrollTop = box.scrollHeight;
}

/* ---- worker ---- */
function txEnsureWorker() {
  if (TX.worker) return;
  const url = URL.createObjectURL(new Blob([TX_WORKER_SRC], { type: "text/javascript" }));
  TX.worker = new Worker(url, { type: "module" });
  TX.worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "progress") { TX.loadPct = m.pct; if (!TX.workerReady && TX.on) txSetStatus(`● Loading speech model… ${m.pct}%`); }
    else if (m.type === "ready") { TX.workerReady = true; if (TX.on) txSetStatus("● Transcript on"); }
    else if (m.type === "error") { txSetStatus("Speech model failed: " + m.message); txStop(true); }
    else if (m.type === "text") {
      TX.pending = Math.max(0, TX.pending - 1);
      const text = txClean(m.text);
      if (text && m.runId === TX.runId) { TX.segs.push({ t: m.t, speaker: m.speaker, text }); txRenderLive(); }
    }
  };
  TX.worker.onerror = () => { txSetStatus("Speech engine could not start in this browser."); txStop(true); };
  TX.worker.postMessage({ type: "init", model: CONFIG.transcribeModel || "Xenova/whisper-tiny.en", device: CONFIG.transcribeDevice || "wasm" });
}

/* ---- audio taps (one per speaker) ---- */
function txMakeTap(stream, speaker) {
  const ctx = new AudioContext({ sampleRate: 16000 });
  const src = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
  const proc = ctx.createScriptProcessor(4096, 1, 1);
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
    if (!tap.heard && tap.len > 32000) { tap.buf = []; tap.len = 0; return; }            // drop long silence
    if (tap.heard && ((tap.len >= 24000 && tap.silent >= 11200) || tap.len >= 160000)) txFlush(tap, false);
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
  TX.pending++;
  TX.worker.postMessage({ type: "audio", id: ++TX.seq, speaker: tap.speaker, t: Date.now(), runId: TX.runId, audio: all }, [all.buffer]);
}

/* ---- start / stop capture (once per shift) ---- */
async function txStart() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia || !window.Worker) {
    txSetStatus("This browser can't do it. Use Chrome or Edge on Windows."); return;
  }
  try {
    txSetStatus("Choose “Entire screen” and tick “Share system audio”…");
    TX.disp = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 1 },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: "include",
    });
    if (!TX.disp.getAudioTracks().length) {
      TX.disp.getTracks().forEach((t) => t.stop()); TX.disp = null;
      txSetStatus("No system audio shared. Click again and tick “Share system audio”."); return;
    }
    TX.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    txStop(true); txSetStatus("Not started: " + (e.name === "NotAllowedError" ? "permission was declined." : e.message)); return;
  }
  TX.disp.getVideoTracks().forEach((t) => t.addEventListener("ended", () => txStop(false)));
  TX.disp.getAudioTracks().forEach((t) => t.addEventListener("ended", () => txStop(false)));
  txEnsureWorker();
  TX.taps = [txMakeTap(TX.mic, "Agent"), txMakeTap(TX.disp, "Customer")];
  TX.on = true;
  $("btn-tx").textContent = "Stop live transcript";
  txSetStatus(TX.workerReady ? "● Transcript on" : `● Loading speech model… ${TX.loadPct}%`);
  if (callStart && currentLead) txBeginCall(currentLead);     // started mid-call
}
function txStop(silent) {
  TX.on = false; TX.recording = false;
  TX.taps.forEach((t) => { try { t.proc.disconnect(); t.src.disconnect(); t.ctx.close(); } catch (e) {} });
  TX.taps = [];
  [TX.mic, TX.disp].forEach((s) => s && s.getTracks().forEach((t) => t.stop()));
  TX.mic = TX.disp = null;
  const b = $("btn-tx"); if (b) b.textContent = "Start live transcript";
  if (!silent) txSetStatus("Transcript stopped.");
}
function txInit() {
  $("btn-tx").addEventListener("click", () => (TX.on ? txStop(false) : txStart()));
}

/* ---- per-call hooks (called from app.js) ---- */
function txBeginCall(lead) {
  TX.segs = []; TX.pending = 0; TX.runId++; TX.leadId = lead.id;
  $("tx-summary").classList.add("hidden"); $("tx-summary").textContent = "";
  if (!TX.on) { $("tx-live").classList.add("hidden"); return; }
  TX.recording = true;
  $("tx-live").classList.remove("hidden");
  txRenderLive();
}
function txReset() {
  TX.recording = false; TX.segs = []; TX.runId++;
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
  for (let i = 0; i < 120 && TX.pending > 0; i++) await new Promise((r) => setTimeout(r, 500));   // wait up to 60 s
  if (run !== TX.runId) return;                                                                // agent already moved on
  const segs = TX.segs.slice().sort((a, b) => a.t - b.t);
  txSetStatus(TX.on ? "● Transcript on" : "");
  const sum = $("tx-summary");
  sum.classList.remove("hidden");
  if (!segs.length) { sum.textContent = "No speech was captured on this call."; return; }
  const text = segs.map((s) => `${s.speaker}: ${s.text}`).join("\n");
  sum.textContent = "Saving transcript…";
  const { data, error } = await sb.from("call_transcripts")
    .insert({ lead_id: leadId, agent_id: session.user.id, transcript: text, duration }).select("id").single();
  if (error || !data) { sum.textContent = "Transcript captured but could not be saved (" + (error ? error.message : "unknown") + ")."; return; }
  sum.textContent = "Writing summary…";
  const { data: res, error: fErr } = await sb.functions.invoke("summarize", { body: { action: "summarize", transcript_id: data.id } });
  if (run !== TX.runId && !(currentLead && currentLead.id === leadId)) return;
  const REASONS = {
    no_key: "Summary is off: no API key is connected (ask the admin).",
    off: "Summary is off: the admin set the daily limit to 0.",
    limit: "Daily summary limit reached. The transcript is saved.",
    api_error: "The summary service returned an error. The transcript is saved.",
  };
  if (fErr || !res) sum.textContent = "Summary isn't set up yet. The transcript is saved.";
  else if (res.ok) sum.innerHTML = "<b>Call summary</b><br>" + esc(res.summary).replace(/\n/g, "<br>");
  else sum.textContent = REASONS[res.reason] || res.message || "Summary unavailable. The transcript is saved.";
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
  adminSummaryRefresh();
}

// A2Z CRM — Supabase connection. The publishable key is safe to embed in web pages.
const CONFIG = {
  url: "https://nuykdlztlbdwxcqqzoob.supabase.co",
  key: "sb_publishable_6QYQXkRB01Z9mfGZskTdvA_j4ugq8o-",
  emailDomain: "@a2zcrm.local",
  callWindowStart: 9,   // local business time: earliest hour to call
  callWindowEnd: 17,    // local business time: latest hour to call
  maxVoicemailAttempts: 5,
  voicemailRetryHours: 24,
  transcribeModel: "Xenova/whisper-tiny.en",   // speech model that runs in the agent's browser (tiny = fastest; "Xenova/whisper-base.en" = more accurate, slower)
  customerDeviceLabel: "CABLE Output",   // optional: part of a virtual-cable name, e.g. "CABLE Output" (skips the share window)
  transcribeDevice: "auto",                     // "auto" = use the graphics card (fast) when the browser supports it, else CPU. "wasm" = force CPU
};

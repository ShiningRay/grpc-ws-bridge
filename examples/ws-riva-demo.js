"use strict";

const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const yargs = require("yargs");
const { hideBin } = require("yargs/helpers");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function rid(prefix = "c") { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }

const argv = yargs(hideBin(process.argv))
  .option("ws", { type: "string", default: "ws://localhost:8080", describe: "WebSocket URL of the bridge" })
  .option("target", { type: "string", describe: "Override gRPC target host:port for this call (optional)" })
  .option("mode", { choices: ["streaming", "unary"], default: "streaming", describe: "Use streaming or unary Recognize" })
  .option("wav", { type: "string", default: path.join(__dirname, "16k16bit.wav"), describe: "Path to WAV (16kHz, 16-bit PCM)" })
  .option("lang", { type: "string", default: "en-US", describe: "Language code" })
  .option("encoding", { choices: ["LINEAR16", "LINEAR_PCM"], default: "LINEAR16", describe: "Audio encoding" })
  .option("chunk", { type: "number", default: 32000, describe: "Chunk size in bytes for streaming" })
  .option("interim", { type: "boolean", default: true, describe: "Emit interim results (streaming)" })
  .option("wav-container", { type: "boolean", default: false, describe: "Send full WAV container bytes (do not strip header)" })
  .option("auth", { type: "string", describe: "Authorization bearer token (sent as metadata authorization: Bearer <token>)" })
  .option("md", { type: "array", describe: "Additional metadata key=value (repeatable)", default: [] })
  .help()
  .alias("h", "help")
  .parse();

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function send(ws, msg) { ws.send(JSON.stringify(msg)); }

function onceByType(ws, type, callId) {
  return new Promise((resolve) => {
    function handler(data) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === type && (!callId || msg.callId === callId)) {
          ws.off("message", handler);
          resolve(msg);
        }
      } catch (_) { }
    }
    ws.on("message", handler);
  });
}

function collectUntilStatus(ws, callId, onData) {
  return new Promise((resolve) => {
    function handler(data) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.callId !== callId) return;
        if (msg.type === "data") onData && onData(msg.payload);
        if (msg.type === "status") {
          ws.off("message", handler);
          resolve(msg.status);
        }
      } catch (_) { }
    }
    ws.on("message", handler);
  });
}

function parseWavPcm(buf) {
  // Minimal WAV parser to extract PCM data chunk and metadata
  // Reference: RIFF/WAVE format
  function readStr(off, n) { return buf.toString("ascii", off, off + n); }
  function readUInt32LE(off) { return buf.readUInt32LE(off); }
  function readUInt16LE(off) { return buf.readUInt16LE(off); }
  if (readStr(0, 4) !== "RIFF" || readStr(8, 4) !== "WAVE") {
    throw new Error("Not a WAV file (missing RIFF/WAVE)");
  }
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = readStr(off, 4); off += 4;
    const size = readUInt32LE(off); off += 4;
    if (id === "fmt ") {
      const audioFormat = readUInt16LE(off + 0);
      const numChannels = readUInt16LE(off + 2);
      const sampleRate = readUInt32LE(off + 4);
      const bitsPerSample = readUInt16LE(off + 14);
      fmt = { audioFormat, numChannels, sampleRate, bitsPerSample };
    } else if (id === "data") {
      data = { start: off, size };
    }
    off += size;
    if (off % 2 === 1) off += 1; // padding
    if (fmt && data) break;
  }
  if (!fmt || !data) throw new Error("Invalid WAV: missing fmt or data chunk");
  if (!(fmt.audioFormat === 1 || fmt.audioFormat === 3)) {
    // 1=PCM, 3=IEEE float
    throw new Error(`Unsupported WAV format: audioFormat=${fmt.audioFormat}`);
  }
  const pcm = buf.subarray(data.start, data.start + data.size);
  return { pcm, sampleRate: fmt.sampleRate, channels: fmt.numChannels, bitsPerSample: fmt.bitsPerSample };
}

function rivaConfig({ encoding, sampleRate, lang, channels, max_alternatives = 1, interim_results = true }) {
  return {
    encoding, // "LINEAR16" or "LINEAR_PCM"
    sample_rate_hertz: sampleRate,
    language_code: lang,
    max_alternatives,
    audio_channel_count: channels,
    enable_automatic_punctuation: true,
  };
}

function parseMetadata(argv) {
  const md = {};
  if (argv.auth) md["authorization"] = `Bearer ${argv.auth}`;
  for (const kv of argv.md || []) {
    const idx = String(kv).indexOf("=");
    if (idx > 0) {
      const k = kv.slice(0, idx);
      const v = kv.slice(idx + 1);
      if (md[k]) {
        md[k] = Array.isArray(md[k]) ? [...md[k], v] : [md[k], v];
      } else md[k] = v;
    }
  }
  return md;
}

async function runUnary(ws, opts) {
  const { wavPath, lang, encoding, target } = opts;
  const buf = fs.readFileSync(wavPath);
  const { pcm, sampleRate, channels, bitsPerSample } = parseWavPcm(buf);
  if (bitsPerSample !== 16) console.warn(`Warning: bitsPerSample=${bitsPerSample}, expected 16`);
  const callId = rid("riva-unary");
  console.log("== Riva Unary Recognize");
  const config = rivaConfig({ encoding, sampleRate, lang, channels, max_alternatives: 1 });
  const headerP = onceByType(ws, "headers", callId);
  const dataP = onceByType(ws, "data", callId);
  const statusP = onceByType(ws, "status", callId);
  const audioBytes = argv["wav-container"] ? buf : pcm;
  send(ws, {
    type: "start",
    callId,
    method: "nvidia.riva.asr.RivaSpeechRecognition/Recognize",
    target,
    metadata: parseMetadata(argv),
    binaryAsBase64: true,
    binaryFields: ["audio"],
    payload: {
      config,
      audio: audioBytes.toString("base64"),
    },
  });
  const headers = await headerP;
  console.log("headers:", headers.metadata);
  const data = await dataP;
  console.log("response:", JSON.stringify(data.payload, null, 2));
  const status = await statusP;
  console.log("status:", status.status);
}

async function runStreaming(ws, opts) {
  const { wavPath, lang, encoding, chunkBytes, interim, target } = opts;
  const buf = fs.readFileSync(wavPath);
  const { pcm, sampleRate, channels, bitsPerSample } = parseWavPcm(buf);
  if (bitsPerSample !== 16) console.warn(`Warning: bitsPerSample=${bitsPerSample}, expected 16`);
  const callId = rid("riva-stream");
  console.log("== Riva StreamingRecognize");
  const config = rivaConfig({ encoding, sampleRate, lang, channels, interim_results: interim });

  const headersP = onceByType(ws, "headers", callId);
  const items = [];
  const statusP = collectUntilStatus(ws, callId, (p) => {
    // p is StreamingRecognizeResponse
    items.push(p);
    // Print transcripts if available
    if (p?.results) {
      for (const r of p.results) {
        const alt = r.alternatives && r.alternatives[0];
        if (alt?.transcript) {
          console.log(`${r.is_final ? "FINAL" : "INT"}: ${alt.transcript}`);
        }
      }
    }
  });

  // Start call
  send(ws, {
    type: "start",
    callId,
    method: "nvidia.riva.asr.RivaSpeechRecognition/StreamingRecognize",
    target,
    metadata: parseMetadata(argv),
    binaryAsBase64: true,
    binaryFields: ["audio_content"],
  });

  // Send initial config message
  send(ws, {
    type: "write",
    callId,
    payload: { streaming_config: { config, interim_results: interim } },
  });

  // Wait briefly to ensure server applies config
  await sleep(20);

  // Stream audio chunks
  const chunk = Math.max(1024, chunkBytes | 0);
  const bytesToSend = argv["wav-container"] ? buf : pcm;
  for (let off = 0; off < bytesToSend.length; off += chunk) {
    const end = Math.min(off + chunk, pcm.length);
    const slice = bytesToSend.subarray(off, end);
    send(ws, {
      type: "write",
      callId,
      payload: { audio_content: slice.toString('base64') }
    });
    // Pace roughly in realtime for 16k16bit mono: 32kB/sec -> delay ~ slice.length / 32000 sec
    const delayMs = Math.round((slice.length / 32000) * 1000);
    if (delayMs > 0) await sleep(Math.min(delayMs, 100));
  }

  // End stream
  send(ws, { type: "end", callId });

  const headers = await headersP;
  console.log("headers:", headers.metadata);
  const status = await statusP;
  console.log("status:", status);
  console.log(`received ${items.length} responses`);
}

async function main() {
  const ws = await connect(argv.ws);
  ws.on("error", (e) => console.error("ws error:", e));
  const wavPath = path.resolve(argv.wav);
  if (!fs.existsSync(wavPath)) {
    console.error("WAV not found:", wavPath);
    process.exit(1);
  }
  const opts = {
    wavPath,
    lang: argv.lang,
    encoding: argv.encoding,
    chunkBytes: argv.chunk,
    interim: argv.interim,
    target: argv.target,
  };
  try {
    if (argv.mode === "unary") {
      await runUnary(ws, opts);
    } else {
      await runStreaming(ws, opts);
    }
  } finally {
    ws.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

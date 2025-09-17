"use strict";

const http = require("http");
const WebSocket = require("ws");
const yargs = require("yargs");
const { hideBin } = require("yargs/helpers");
const grpc = require("@grpc/grpc-js");

const { GrpcEnv } = require("./grpc/factory");
const { objectToMetadata, metadataToObject, statusObject } = require("./utils/metadata");

function log(...args) {
  console.log(new Date().toISOString(), "[grpc-ws-bridge]", ...args);
}

function dlog(...args) {
  // argv is defined below; this function is only called after argv is parsed
  try {
    if (argv && argv.verbose) log("[DEBUG]", ...args);
  } catch (_) { }
}

function preview(obj, max = 400) {
  try {
    const s = typeof obj === "string" ? obj : JSON.stringify(obj);
    return s.length > max ? s.slice(0, max) + "…" : s;
  } catch (e) {
    return String(obj);
  }
}

const argv = yargs(hideBin(process.argv))
  .option("ws-port", { type: "number", default: 8080, describe: "WebSocket server port" })
  .option("proto", { type: "array", describe: "Path(s) to .proto file(s)", demandOption: true })
  .option("include", { type: "array", describe: "Include directories for imports", default: [] })
  .option("default-target", { type: "string", default: "localhost:50051", describe: "Default gRPC target host:port" })
  .option("secure", { type: "boolean", default: false, describe: "Use TLS for gRPC connection" })
  .option("tls-ca", { type: "string", describe: "Root CA file for TLS" })
  .option("verbose", { type: "boolean", default: true, describe: "Enable verbose debug logs" })
  .help()
  .alias("h", "help")
  .parse();

const env = new GrpcEnv(argv.proto, argv.include);

const server = http.createServer();
const wss = new WebSocket.Server({ server });

// Map ws => { calls: Map<callId, activeCall> }
const wsState = new WeakMap();

function getWsState(ws) {
  if (!wsState.has(ws)) wsState.set(ws, { calls: new Map() });
  return wsState.get(ws);
}

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    dlog("send", { type: msg.type, callId: msg.callId, preview: preview({ ...msg, payload: msg.payload }, 200) });
    ws.send(JSON.stringify(msg));
  }
}

function asErrorPayload(err) {
  // grpc errors have code, details, metadata
  if (typeof err === "object" && err && ("code" in err || "details" in err)) {
    return statusObject(err);
  }
  return { code: grpc.status.UNKNOWN, details: String(err), metadata: {} };
}

function onStart(ws, msg) {
  const { callId, method, target, metadata: mdObj, payload } = msg;
  if (!callId || !method) {
    return send(ws, { type: "error", callId, error: { code: grpc.status.INVALID_ARGUMENT, details: "Missing callId or method", metadata: {} } });
  }
  const state = getWsState(ws);
  if (state.calls.has(callId)) {
    return send(ws, { type: "error", callId, error: { code: grpc.status.ALREADY_EXISTS, details: "Duplicate callId", metadata: {} } });
  }

  let parsed;
  try {
    parsed = GrpcEnv.parseFQMethod(method);
  } catch (e) {
    return send(ws, { type: "error", callId, error: asErrorPayload(e) });
  }

  const credentials = GrpcEnv.makeCredentials({ secure: argv.secure, tlsCa: argv["tls-ca"] });
  const tgt = target || argv["default-target"];

  let def;
  try {
    def = env.getMethodDef(parsed.pkgPath, parsed.serviceName, parsed.methodName);
  } catch (e) {
    return send(ws, { type: "error", callId, error: asErrorPayload(e) });
  }

  const client = env.getClient(tgt, parsed.pkgPath, parsed.serviceName, credentials);
  const md = objectToMetadata(mdObj);

  const requestStream = !!def.requestStream;
  const responseStream = !!def.responseStream;

  const methodName = parsed.methodName;

  const makeUnaryHandlers = (call) => {
    if (call && call.on) {
      call.on("metadata", (headers) => {
        dlog("headers", { callId, metadata: metadataToObject(headers) });
        send(ws, { type: "headers", callId, metadata: metadataToObject(headers) });
      });
      call.on("status", (status) => {
        send(ws, { type: "status", callId, status: statusObject(status) });
        const s = getWsState(ws);
        s.calls.delete(callId);
        dlog("status", { callId, status: statusObject(status) });
      });
    }
  };

  try {
    dlog("start", {
      callId,
      method,
      target: tgt,
      requestStream,
      responseStream,
      metadata: mdObj,
      payloadPreview: payload ? preview(payload, 300) : undefined,
    });
    if (!requestStream && !responseStream) {
      // unary
      const call = client[methodName](payload || {}, md, (err, response) => {
        if (err) {
          dlog("error", { callId, error: asErrorPayload(err) });
          return send(ws, { type: "error", callId, error: asErrorPayload(err) });
        }
        dlog("data", { callId, payloadPreview: preview(response, 200) });
        send(ws, { type: "data", callId, payload: response });
      });
      makeUnaryHandlers(call);
      state.calls.set(callId, { kind: "unary", call, info: { method, target: tgt } });
    } else if (!requestStream && responseStream) {
      // server streaming
      const stream = client[methodName](payload || {}, md);
      stream.on("metadata", (headers) => {
        dlog("headers", { callId, method, metadata: metadataToObject(headers) });
        send(ws, { type: "headers", callId, metadata: metadataToObject(headers) });
      });
      stream.on("data", (data) => {
        dlog("data", { callId, method, payloadPreview: preview(data, 200) });
        send(ws, { type: "data", callId, payload: data });
      });
      stream.on("error", (err) => {
        dlog("error", { callId, method, error: asErrorPayload(err) });
        send(ws, { type: "error", callId, error: asErrorPayload(err) });
      });
      stream.on("status", (status) => {
        send(ws, { type: "status", callId, status: statusObject(status) });
        const s = getWsState(ws);
        s.calls.delete(callId);
        dlog("status", { callId, method, status: statusObject(status) });
      });
      stream.on("end", () => { /* status event will follow */ });
      state.calls.set(callId, { kind: "server", call: stream, info: { method, target: tgt } });
    } else if (requestStream && !responseStream) {
      // client streaming
      const stream = client[methodName](md, (err, resp) => {
        if (err) return send(ws, { type: "error", callId, error: asErrorPayload(err) });
        send(ws, { type: "data", callId, payload: resp });
      });
      stream.on("metadata", (headers) => {
        dlog("headers", { callId, method, metadata: metadataToObject(headers) });
        send(ws, { type: "headers", callId, metadata: metadataToObject(headers) });
      });
      stream.on("status", (status) => {
        send(ws, { type: "status", callId, status: statusObject(status) });
        const s = getWsState(ws);
        s.calls.delete(callId);
        dlog("status", { callId, method, status: statusObject(status) });
      });
      state.calls.set(callId, { kind: "client", call: stream, info: { method, target: tgt } });
      // If payload is provided at start, treat as first write
      if (payload) { dlog("write", { callId, method, payloadPreview: preview(payload, 200) }); stream.write(payload); }
    } else {
      // bidi streaming
      const stream = client[methodName](md);
      stream.on("metadata", (headers) => {
        dlog("headers", { callId, method, metadata: metadataToObject(headers) });
        send(ws, { type: "headers", callId, metadata: metadataToObject(headers) });
      });
      stream.on("data", (data) => {
        dlog("data", { callId, method, payloadPreview: preview(data, 200) });
        send(ws, { type: "data", callId, payload: data });
      });
      stream.on("error", (err) => {
        dlog("error", { callId, method, error: asErrorPayload(err) });
        send(ws, { type: "error", callId, error: asErrorPayload(err) });
      });
      stream.on("status", (status) => {
        send(ws, { type: "status", callId, status: statusObject(status) });
        const s = getWsState(ws);
        s.calls.delete(callId);
        dlog("status", { callId, method, status: statusObject(status) });
      });
      state.calls.set(callId, { kind: "bidi", call: stream, info: { method, target: tgt } });
      if (payload) { dlog("write", { callId, method, payloadPreview: preview(payload, 200) }); stream.write(payload); }
    }
  } catch (e) {
    return send(ws, { type: "error", callId, error: asErrorPayload(e) });
  }
}

function onWrite(ws, msg) {
  const { callId, payload } = msg;
  const state = getWsState(ws);
  const entry = state.calls.get(callId);
  if (!entry) return send(ws, { type: "error", callId, error: { code: grpc.status.NOT_FOUND, details: "callId not found", metadata: {} } });
  if (entry.kind !== "client" && entry.kind !== "bidi") {
    return send(ws, { type: "error", callId, error: { code: grpc.status.FAILED_PRECONDITION, details: "Not a writable stream", metadata: {} } });
  }
  try {
    dlog("write", { callId, method: entry.info?.method, payloadPreview: preview(payload, 200) });
    entry.call.write(payload || {});
  } catch (e) {
    send(ws, { type: "error", callId, error: asErrorPayload(e) });
  }
}

function onEnd(ws, msg) {
  const { callId } = msg;
  const state = getWsState(ws);
  const entry = state.calls.get(callId);
  if (!entry) return; // ignore
  if (entry.call && entry.call.end) {
    dlog("end", { callId, method: entry.info?.method });
    try { entry.call.end(); } catch (_) { }
  }
}

function onCancel(ws, msg) {
  const { callId } = msg;
  const state = getWsState(ws);
  const entry = state.calls.get(callId);
  if (!entry) return; // ignore
  try {
    dlog("cancel", { callId, method: entry.info?.method });
    if (entry.call && entry.call.cancel) entry.call.cancel();
  } finally {
    state.calls.delete(callId);
  }
}

function cleanupWs(ws) {
  const state = getWsState(ws);
  for (const [callId, entry] of state.calls) {
    dlog("cleanup:cancel", { callId, method: entry.info?.method });
    try { if (entry.call && entry.call.cancel) entry.call.cancel(); } catch (_) { }
  }
  state.calls.clear();
}

wss.on("connection", (ws, req) => {
  log(`New WS connection from ${req.socket.remoteAddress}`);
  getWsState(ws); // init

  ws.on("message", (data) => {
    dlog("recv", { bytes: Buffer.byteLength(data), preview: preview(data.toString(), 200) });
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      return send(ws, { type: "error", error: { code: grpc.status.INVALID_ARGUMENT, details: "Invalid JSON", metadata: {} } });
    }
    dlog("parsed", { type: msg.type, callId: msg.callId });
    switch (msg.type) {
      case "start":
        onStart(ws, msg);
        break;
      case "write":
        onWrite(ws, msg);
        break;
      case "end":
        onEnd(ws, msg);
        break;
      case "cancel":
        onCancel(ws, msg);
        break;
      default:
        send(ws, { type: "error", callId: msg.callId, error: { code: grpc.status.UNIMPLEMENTED, details: `Unknown type ${msg.type}`, metadata: {} } });
    }
  });

  ws.on("close", () => {
    cleanupWs(ws);
    log("WS connection closed");
  });
  ws.on("error", (err) => {
    cleanupWs(ws);
    log("WS error", err);
  });
});

server.listen(argv["ws-port"], () => {
  log(`WebSocket server listening on :${argv["ws-port"]}`);
});

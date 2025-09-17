"use strict";

const WebSocket = require("ws");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function rid(prefix = "c") { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function send(ws, msg) {
  ws.send(JSON.stringify(msg));
}

function onceByType(ws, type, callId) {
  return new Promise((resolve) => {
    function handler(data) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === type && (!callId || msg.callId === callId)) {
          ws.off("message", handler);
          resolve(msg);
        }
      } catch (_) {}
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
      } catch (_) {}
    }
    ws.on("message", handler);
  });
}

async function demoUnary(ws) {
  const callId = rid("unary");
  console.log("\n== Unary: SayHello");
  const headerP = onceByType(ws, "headers", callId);
  const dataP = onceByType(ws, "data", callId);
  const statusP = onceByType(ws, "status", callId);
  send(ws, { type: "start", callId, method: "demo.Greeter/SayHello", payload: { name: "Alice" } });
  const headers = await headerP;
  console.log("headers:", headers.metadata);
  const data = await dataP;
  console.log("data:", data.payload);
  const status = await statusP;
  console.log("status:", status.status);
}

async function demoServerStream(ws) {
  const callId = rid("sstream");
  console.log("\n== Server streaming: GreetMany");
  const headersP = onceByType(ws, "headers", callId);
  const items = [];
  const statusP = collectUntilStatus(ws, callId, (p) => { items.push(p); });
  send(ws, { type: "start", callId, method: "demo.Greeter/GreetMany", payload: { name: "Bob", count: 3 } });
  const headers = await headersP;
  console.log("headers:", headers.metadata);
  const status = await statusP;
  console.log("data items:", items);
  console.log("status:", status);
}

async function demoClientStream(ws) {
  const callId = rid("cstream");
  console.log("\n== Client streaming: AccumulateGreetings");
  // Prepare waiters before sending start to avoid race with fast responses
  const headerP = onceByType(ws, "headers", callId).then((h) => console.log("headers:", h.metadata)).catch(() => {});
  const dataP = onceByType(ws, "data", callId);
  const statusP = onceByType(ws, "status", callId);
  send(ws, { type: "start", callId, method: "demo.Greeter/AccumulateGreetings" });
  send(ws, { type: "write", callId, payload: { name: "A" } });
  send(ws, { type: "write", callId, payload: { name: "B" } });
  send(ws, { type: "write", callId, payload: { name: "C" } });
  send(ws, { type: "end", callId });
  const data = await dataP;
  console.log("data:", data.payload);
  const status = await statusP;
  console.log("status:", status.status);
  await headerP;
}

async function demoBidi(ws) {
  const callId = rid("bidi");
  console.log("\n== Bidi streaming: Chat");
  const headersP = onceByType(ws, "headers", callId);
  const items = [];
  const statusP = collectUntilStatus(ws, callId, (p) => { items.push(p); });
  send(ws, { type: "start", callId, method: "demo.Greeter/Chat" });
  const headers = await headersP;
  console.log("headers:", headers.metadata);
  // write three messages
  send(ws, { type: "write", callId, payload: { from: "client", message: "hi", seq: "1" } });
  send(ws, { type: "write", callId, payload: { from: "client", message: "how are you?", seq: "2" } });
  send(ws, { type: "write", callId, payload: { from: "client", message: "bye", seq: "3" } });
  await sleep(200);
  send(ws, { type: "end", callId });
  const status = await statusP;
  console.log("data items:", items);
  console.log("status:", status);
}

async function main() {
  const ws = await connect("ws://localhost:8080");
  ws.on("error", (e) => console.error("ws error:", e));
  try {
    await demoUnary(ws);
    await demoServerStream(ws);
    await demoClientStream(ws);
    await demoBidi(ws);
  } finally {
    ws.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

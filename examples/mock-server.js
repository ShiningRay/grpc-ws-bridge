"use strict";

const path = require("path");
const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");
const yargs = require("yargs");
const { hideBin } = require("yargs/helpers");

const argv = yargs(hideBin(process.argv))
  .option("port", { type: "number", default: 50051, describe: "gRPC server port" })
  .option("proto", { type: "string", default: path.join(__dirname, "protos/demo.proto"), describe: "Path to demo.proto" })
  .option("verbose", { type: "boolean", default: true, describe: "Enable verbose debug logs" })
  .help()
  .alias("h", "help")
  .parse();

const loaderOptions = {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
};

function log(...args) {
  console.log(new Date().toISOString(), "[mock-grpc]", ...args);
}

function dlog(...args) {
  if (argv.verbose) log("[DEBUG]", ...args);
}

function mdToObj(md) {
  const out = {};
  if (!md) return out;
  const internal = md.internalRepr || md._internal_repr;
  if (internal) {
    for (const [key, arr] of internal) {
      const vals = arr.map((v) => (Buffer.isBuffer(v) ? v.toString("base64") : String(v)));
      out[key] = vals.length > 1 ? vals : vals[0];
    }
  }
  return out;
}

function startServer() {
  const packageDef = protoLoader.loadSync(argv.proto, loaderOptions);
  const loaded = grpc.loadPackageDefinition(packageDef);
  const demo = loaded.demo;

  const server = new grpc.Server();

  const GreeterService = demo.Greeter.service;

  const impl = {
    // Unary: SayHello
    SayHello(call, callback) {
      const name = call.request?.name || "world";
      dlog("SayHello:start", { peer: call.getPeer?.(), metadata: mdToObj(call.metadata), request: call.request });
      // Send initial metadata
      const md = new grpc.Metadata();
      md.set("server", "mock");
      dlog("SayHello:sendMetadata", mdToObj(md));
      call.sendMetadata(md);
      const resp = { message: `Hello, ${name}!` };
      dlog("SayHello:response", resp);
      callback(null, resp);
    },

    // Server streaming: GreetMany
    GreetMany(call) {
      const name = call.request?.name || "world";
      let count = call.request?.count ?? 3;
      if (count <= 0) count = 3;
      dlog("GreetMany:start", { peer: call.getPeer?.(), metadata: mdToObj(call.metadata), request: call.request, count });
      const md = new grpc.Metadata();
      md.set("server", "mock");
      dlog("GreetMany:sendMetadata", mdToObj(md));
      call.sendMetadata(md);
      let i = 0;
      const interval = setInterval(() => {
        i += 1;
        const payload = { message: `Hello ${i} to ${name}` };
        dlog("GreetMany:write", payload);
        call.write(payload);
        if (i >= count) {
          clearInterval(interval);
          dlog("GreetMany:end");
          call.end();
        }
      }, 200);
      call.on("cancelled", () => {
        clearInterval(interval);
        dlog("GreetMany:cancelled");
      });
      call.on?.("error", (err) => dlog("GreetMany:error", err));
    },

    // Client streaming: AccumulateGreetings
    AccumulateGreetings(call, callback) {
      const names = [];
      dlog("AccumulateGreetings:start", { peer: call.getPeer?.(), metadata: mdToObj(call.metadata) });
      // Send initial metadata immediately so clients don't block on waiting headers
      const md = new grpc.Metadata();
      md.set("server", "mock");
      dlog("AccumulateGreetings:sendMetadata", mdToObj(md));
      call.sendMetadata(md);
      call.on("data", (msg) => {
        dlog("AccumulateGreetings:data", msg);
        if (msg?.name) names.push(msg.name);
      });
      call.on("end", () => {
        const message = names.length ? `Hello ${names.join(", ")}` : "Hello";
        const resp = { message };
        dlog("AccumulateGreetings:response", resp);
        callback(null, resp);
      });
      call.on?.("cancelled", () => dlog("AccumulateGreetings:cancelled"));
      call.on?.("error", (err) => dlog("AccumulateGreetings:error", err));
    },

    // Bidi streaming: Chat
    Chat(call) {
      const md = new grpc.Metadata();
      md.set("server", "mock");
      dlog("Chat:start", { peer: call.getPeer?.(), metadata: mdToObj(call.metadata) });
      dlog("Chat:sendMetadata", mdToObj(md));
      call.sendMetadata(md);
      call.on("data", (msg) => {
        dlog("Chat:data", msg);
        const seq = msg?.seq || 0;
        const from = msg?.from || "client";
        const text = msg?.message || "";
        // Echo back with server tag
        const payload = { from: "server", message: `echo(${from}): ${text}`, seq };
        dlog("Chat:write", payload);
        call.write(payload);
      });
      call.on("end", () => {
        dlog("Chat:end");
        call.end();
      });
      call.on?.("cancelled", () => dlog("Chat:cancelled"));
      call.on?.("error", (err) => dlog("Chat:error", err));
    },
  };

  server.addService(GreeterService, impl);
  const addr = `0.0.0.0:${argv.port}`;
  server.bindAsync(addr, grpc.ServerCredentials.createInsecure(), (err, port) => {
    if (err) {
      console.error("Failed to bind:", err);
      process.exit(1);
    }
    server.start();
    log(`gRPC mock server listening on :${port}`);
  });
}

startServer();

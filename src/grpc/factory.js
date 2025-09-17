"use strict";

const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");

const defaultLoaderOptions = {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
};

class GrpcEnv {
  constructor(protoPaths = [], includeDirs = [], loaderOptions = {}) {
    this.protoPaths = Array.isArray(protoPaths) ? protoPaths : [protoPaths];
    this.includeDirs = Array.isArray(includeDirs) ? includeDirs : [includeDirs];
    this.loaderOptions = { ...defaultLoaderOptions, ...loaderOptions };
    this.packageDefinition = null;
    this.loaded = null;
    this.clientCache = new Map(); // key: `${target}|${fqn}` => client instance
  }

  load() {
    if (this.loaded) return this.loaded;
    const path = require("path");
    const extraDirs = Array.from(new Set(this.protoPaths.map((p) => path.resolve(path.dirname(p)))));
    const allIncludes = Array.from(new Set([
      ...this.includeDirs.map((d) => path.resolve(d)),
      ...extraDirs,
      process.cwd(),
    ]));
    const opts = { includeDirs: allIncludes, ...this.loaderOptions };
    this.packageDefinition = protoLoader.loadSync(this.protoPaths, opts);
    this.loaded = grpc.loadPackageDefinition(this.packageDefinition);
    return this.loaded;
  }

  /** Resolve a namespace object by package path, e.g., "my.pkg" */
  getPackage(pkgPath) {
    const root = this.load();
    if (!pkgPath) return root;
    return pkgPath.split(".").reduce((acc, part) => (acc ? acc[part] : undefined), root);
  }

  /**
   * Parse fully qualified method like "my.pkg.Service/Method"
   * Returns { pkgPath, serviceName, methodName }
   */
  static parseFQMethod(fqMethod) {
    if (!fqMethod || typeof fqMethod !== "string" || !fqMethod.includes("/")) {
      throw new Error(`Invalid method: ${fqMethod}`);
    }
    const [serviceFQN, methodName] = fqMethod.split("/");
    const parts = serviceFQN.split(".");
    const serviceName = parts.pop();
    const pkgPath = parts.join(".");
    return { pkgPath, serviceName, methodName };
  }

  /** Get the client constructor for a given service FQN */
  getServiceCtor(pkgPath, serviceName) {
    const pkg = this.getPackage(pkgPath);
    if (!pkg) throw new Error(`Package not found: ${pkgPath}`);
    const ctor = pkg[serviceName];
    if (!ctor) throw new Error(`Service not found: ${pkgPath}.${serviceName}`);
    return ctor;
  }

  /** Create gRPC credentials */
  static makeCredentials(options = {}) {
    const { secure, tlsCa } = options;
    if (secure) {
      let rootCert = undefined;
      if (tlsCa) {
        const fs = require("fs");
        rootCert = fs.readFileSync(tlsCa);
      }
      return grpc.credentials.createSsl(rootCert);
    }
    return grpc.credentials.createInsecure();
  }

  /** Get or create a cached client by target and service FQN */
  getClient(target, pkgPath, serviceName, credentials) {
    const fqn = pkgPath ? `${pkgPath}.${serviceName}` : serviceName;
    const key = `${target}|${fqn}`;
    if (this.clientCache.has(key)) return this.clientCache.get(key);
    const Ctor = this.getServiceCtor(pkgPath, serviceName);
    const client = new Ctor(target, credentials);
    this.clientCache.set(key, client);
    return client;
  }

  /** Lookup method definition to infer streaming types */
  getMethodDef(pkgPath, serviceName, methodName) {
    const Ctor = this.getServiceCtor(pkgPath, serviceName);
    const svc = Ctor.service;
    const def = svc && svc[methodName];
    if (!def) throw new Error(`Method not found: ${pkgPath}.${serviceName}/${methodName}`);
    return def; // has requestStream, responseStream, path
  }
}

module.exports = { GrpcEnv };

"use strict";

const grpc = require("@grpc/grpc-js");

function objectToMetadata(obj = {}) {
  const md = new grpc.Metadata();
  for (const [key, value] of Object.entries(obj)) {
    if (value == null) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      if (key.endsWith("-bin")) {
        // binary metadata is base64-encoded string
        const buf = Buffer.from(v, "base64");
        md.add(key, buf);
      } else {
        md.add(key, String(v));
      }
    }
  }
  return md;
}

function metadataToObject(md) {
  const out = {};
  if (!md) return out;
  for (const [key, values] of Object.entries(md.getMap())) {
    // getMap flattens to first value; we want all, so use internal store
  }
  // Use internal representation to preserve multiple values
  const internal = md.internalRepr || md._internal_repr; // grpc-js uses internalRepr
  if (internal) {
    for (const [key, arr] of internal) {
      // arr is array of Buffer|string
      const vals = arr.map((v) => {
        if (Buffer.isBuffer(v)) {
          return v.toString("base64");
        }
        return String(v);
      });
      out[key] = vals.length > 1 ? vals : vals[0];
    }
  }
  return out;
}

function statusObject(errOrStatus) {
  if (!errOrStatus) return null;
  const md = errOrStatus.metadata || errOrStatus.trailers;
  return {
    code: errOrStatus.code,
    details: errOrStatus.details || errOrStatus.message || "",
    metadata: metadataToObject(md),
  };
}

module.exports = { objectToMetadata, metadataToObject, statusObject };


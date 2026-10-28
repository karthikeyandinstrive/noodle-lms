#!/usr/bin/env node
// Prints fresh production secrets for .env (never commit them; store them in your secret manager).
import { randomBytes } from "node:crypto";

const b64url = (n) => randomBytes(n).toString("base64url");
console.log(`ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`);
console.log(`URL_SIGNING_SECRET=${b64url(48)}`);
console.log(`METRICS_TOKEN=${b64url(32)}`);
console.error("\n# Keep ENCRYPTION_KEY safe and stable: it decrypts stored storage and payment credentials.");

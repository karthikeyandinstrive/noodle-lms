import { writeFile } from "node:fs/promises";
import path from "node:path";
import { buildApp } from "../app";

const app = await buildApp();
await app.ready();
const out = path.resolve(import.meta.dirname, "../../../../openapi.json");
await writeFile(out, JSON.stringify(app.swagger(), null, 2));
console.log(`✓ wrote ${out}`);
await app.close();
process.exit(0);

// Shim so vitest 2.1.9 / vite-node 2.x can load Node's `node:sqlite` builtin.
// vite-node strips the `node:` prefix (only `node:test` is whitelisted) and
// then tries to load bare `sqlite` as a file. vitest.config.ts aliases that
// stripped specifier to this file, which pulls the builtin in at runtime via
// createRequire, bypassing the transform.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
export const DatabaseSync = require("node:sqlite").DatabaseSync;

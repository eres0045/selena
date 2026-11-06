import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// vitest 2.1 / vite-node 2.x does not recognise `node:sqlite` as a builtin:
// it strips the `node:` prefix and then tries to load a file named `sqlite`.
// This alias points that stripped specifier at a tiny shim that pulls the
// real builtin in at runtime via createRequire (see vitest.sqlite-shim.mjs).
// Without it, every test file fails to collect.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 15000,
    alias: [
      {
        find: /^sqlite$/,
        replacement: fileURLToPath(new URL("./vitest.sqlite-shim.mjs", import.meta.url)),
      },
    ],
  },
});

# Vendored JSON extractor

`json-loose.mjs` is `parseJsonLoose` from the Beyond Paradise Intelligence project (`src/llm/json.ts`,
sha256 `f2294a5314895dde51d4046ed6ee637e9dfee4d6c90f65f1f87f2e2752ac6ca5`, copied 17 Nov 2026).
The fleet registry entry is `llm-json-loose-parser` (maturity tested).

Only the TypeScript type annotations were removed (`<T = unknown>`, `: string`, `: T | null`, `as T`);
the logic and the comments are the upstream ones. Fenced JSON, prose before or after, braces inside
strings are handled; arrays, scalars and text without an object return `null` (the caller fails closed).

Drift check: `vendor-json-loose.test.js` compares the two when `JSON_LOOSE_UPSTREAM` names the upstream
file (skipped otherwise, the upstream is not part of this repository).

# Vendored voice linter

Copied from the shared voice linter (`scripts/voice-lint/` in the shared knowledge repository,
commit `a2d5c6fdb5ddd12b22170e261704faef3853c4bf`) on 17 Nov 2026.

Two internal comments were reworded for a public repository (one code comment in `voice-lint.mjs`,
one `_crutchComment` text in `rules.json`). Rules and code are unchanged. The substitutions are
recorded in `neutralised.json` by line range and SHA-256 of the original text; the original
wording is not kept here.

Files: `voice-lint.mjs`, `rules.json` (the linter and its rules), `neutralised.json`,
`neutralise.mjs`, `revendor.mjs` (tooling).

## Re-vendor

With the shared repository next to this one:

    node social/vendor/voice-lint/revendor.mjs

It refuses to run if an upstream note changed (hash mismatch). Then read the new wording, reword
it for a public repository, update `neutralised.json`, and run it again. Finally update the commit
hash and date above. `social/vendor-voice-lint.test.js` fails with "vendored copy is stale" when
the copy and the sibling disagree, and is skipped when the sibling is not present.

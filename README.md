# site-generator-speed-01-run-20261122

[![site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Moczilla12/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Moczilla12/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's own makefun-site 1.0.0, for the [site-generator-speed-01-run-20261122](https://make.fun/c/site-generator-speed-01-run-20261122) bounty. It answers every case byte-for-byte identical to makefun-site 1.0.0, and faster.

## How it works

`solve.js` (an ES module, `run(input)`) re-implements makefun-site's build as one fused pass:

- **Fused pipeline** — sources are read, front-mattered and permalinked in a single pass; cards are built once per source and reused by every page that shows them; the word count is taken in the same pass as the Markdown render.
- **Fused single-pass Markdown** — the body is lexed and rendered in one scan with a segment-scanning inline renderer (one regex finds the next special among `\` `` ` `` `*` `[` `&` `<` `>` `"` `'`; plain runs are appended verbatim, no per-character escaping, no token array).
- **Template JIT** — each template is compiled once per case to a plain JS function (`new Function`); rendering is string concatenation with a scope-chain lookup specialised by path arity (1/2/3 names).
- **Memoised slugify with an ASCII fast path** — pure-ASCII input skips NFKD normalisation (ASCII is stable under NFKD); anything else goes through the full rule.
- **Zero-alloc hot paths where it matters** — manual word counting (no array), manual trim/blank checks (no regex), `\r` check before the `\r\n` replace, incremental string building instead of arrays in the block gatherers.

## Verification

Differential-tested against makefun-site 1.0.0 (the kit's baseline) on the 3 practice cases plus 50 randomly generated sites from the kit generator (200–600 Markdown sources, 14–30 templates, static files, slug collisions, front-matter refusals, template errors, broken links, Unicode, non-CommonMark Markdown): **0 differences, byte for byte**.

Local timings (practice set, 3 cases, median):

| | CPU time |
|---|---|
| makefun-site 1.0.0 (baseline) | ~1,030 ms net of null (driver, cold) |
| this entry | ~580 ms net of null (driver, cold) |
| this entry, warm (in-process) | ~180 ms |

## Files

- `solve.js` — the entry: `run(input)` returns makefun-site's answer for one case's input.
- `main.ts` — the driver the harness runs (kept from the kit's baseline): reads `/input/cases.json`, answers each case with `run`, writes `/output/answers.json`.

## License

MIT. See [LICENSE](LICENSE).

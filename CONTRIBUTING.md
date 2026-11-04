# Contributing

## Commit conventions

- Every commit has the pre-commit hook bump the patch digit of `package.json` by one (`DSH_SKIP_VERSION_BUMP=1` skips it). **Take the committed version from `git show HEAD -- package.json`**, not from the file in the working tree.
- Commit messages use Conventional Commits style and carry the card number, e.g. `feat(ui): 全局配置页美术重设计（DSHBOTS-184）`.
- Commit with an exact pathspec (`git commit -- <pathspec>`), and check `git status --short` before and after, so in-flight work from other sessions never gets swept in.

## Guard tests

`tests/` holds one `*.test.js` per feature domain, plus the pins for several architectural conventions:

- `tests/styles-split.test.js`: `UI_STYLE_PARTS` corresponds one-to-one with the `ui/styles/` directory (no orphans, no missing entries, no duplicates), each file stays under 800 lines, and the concatenation has zero drift.
- `tests/code-hygiene.test.js`: the line-limit semantics (800 by default, judgement line at limit × 110 %, 0 disables it, one alert per violation, a fresh alert after the file falls back under the limit).
- Cross-slice `import` guards and token-format guards cover the whole `ui/` source tree: a missing import after a slice split leaves the page on the boot screen, so this class of failure is caught in advance.

## `ui/` contribution rules

1. **Style slices must be registered.** The concatenation order is decided by `UI_STYLE_PARTS` in `src/http.js`, so a new style file must be registered there too; `tests/styles-split.test.js` guards the table's completeness.
2. **The 800-line rule.** Both `ui/styles/*.css` and `ui/app.js` stay under 800 lines per file; beyond that, split by responsibility into new domain files.

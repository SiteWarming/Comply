# Handoff 001 - Code Review & Bug Fixes for Comply OSS
Generated: 2026-03-25

## Quick Start (30 seconds to productive)
Branch: `main`
Run: `npm install && npx tsx src/index.ts scan . --verbose`
Status: All 5 commands work (scan, init, diff, summary, notices). 115/115 deps compliant on self-scan. TypeScript compiles clean. **Nothing is committed yet.**

## Git State
Branch: `main` (no commits beyond initial `.git`)
ALL project files are untracked:
- `src/` (16 .ts files + 16 :Zone.Identifier WSL artifacts)
- `package.json`, `package-lock.json`, `tsconfig.json`
- `CLAUDE.md`, `README.md`, `LICENSE`, `.gitignore`
- `docs/handoffs/001-code-review-bugfix.md` (this file)
- `.comply/` directory (generated audit state, gitignored)

**FIRST ACTION: Commit everything.** Nothing is saved. A `git clean` would destroy the entire project.

## Environment
- Dev: `npx tsx src/index.ts [command] [args]`
- Build: `npm run build` (tsc -> dist/)
- Lint: `npm run lint` (tsc --noEmit)
- Test: **No test framework configured yet**
- Required env: `ANTHROPIC_API_KEY` (only for `--ai` flag)
- Node.js >= 20.0.0 required

## Immediate Context
User generated this entire codebase (~4,800 lines of TypeScript, 16 source files) in a single Claude Desktop session. Previous session reviewed all code, found 19 issues (7 HIGH, 12 MEDIUM), and fixed 11 of the most critical ones. The code is structurally sound -- modular, clear contracts between modules, no circular dependencies. Bugs were edge cases, not architectural problems.

## User's Actual Goal
User built this as an experiment with Claude Desktop and has no strong attachment to it. They want it working correctly and potentially production-ready. They may or may not continue developing it -- treat it as a tool that should work reliably for the use cases it already handles.

## Critical Knowledge
- **ESM modules with `.js` extension imports** -- tsconfig uses `moduleResolution: "bundler"` and `module: "ESNext"`. All inter-file imports use `.js` extensions.
- **Filesystem as database** -- `.comply/` directory IS the state. No external DB. JSON files everywhere.
- **AI is optional** -- Everything works without `ANTHROPIC_API_KEY`. The `--ai` flag triggers Claude API calls for usage analysis of flagged packages.
- **Executive summary is deterministic** -- Template-based, no AI. Handles every combination of risk scores and violation types.
- **Registry resolution is cached** -- 30-day TTL file cache under `.comply/cache/licenses/`. Delete cache to force re-resolution.
- **State roundtrip is lossy** -- `saveSnapshot` in state.ts saves evaluations in a simplified flat format (`{name, version, license, status, severity, reason, rule, remediation}`), NOT the full `PolicyEvaluation` shape. `loadLatestSnapshot` returns these flat objects typed as `PolicyEvaluation[]`. The `getEvalName`/`getEvalLicense` helpers in `computeDiff` handle both formats. **Do not assume reloaded evaluations have `.dependency` or `.license.license` fields.**

## Decision Rationale
| Decision | Why | Alternative Rejected |
|----------|-----|---------------------|
| Fix bugs inline, not rewrite | Code architecture is clean; bugs were edge cases | Full rewrite |
| Add BlueOak-1.0.0 to SPDX DB | 9 common npm packages (glob, minimatch, lru-cache) flagged as unknown | Leave as unknown |
| Remove `openai` from provider union | Not implemented, crashes at runtime | Stub implementation |
| Rewrite CLAUDE.md | Original duplicated README content | Keep original verbose version |
| Decompose SPDX expressions recursively | AND/OR expressions must evaluate each component separately | String matching on full expression |

## Gotchas & Warnings
- **:Zone.Identifier files** -- WSL artifact files alongside every real file. Not in .gitignore. Add `*:Zone.Identifier` to .gitignore before committing.
- **SPDX expressions store full string as spdxId** -- `classifySpdxExpression` in spdx.ts sets `spdxId` to the raw expression (e.g., `"MIT OR Apache-2.0"`). Policy matching in `findMatchingRule` now decomposes these, but other code that reads `spdxId` may still see the full expression string.
- **Operator precedence in state.ts** -- Lines 204-211 in `computeDiff` have `||` and `&&` in filter callbacks without parentheses around the `||` conditions. This works due to `&&` binding tighter than `||`, but it reads ambiguously.
- **`options: any` everywhere** -- All 5 CLI command handlers in index.ts type their options bag as `any`. No compile-time safety on option name access.
- **Empty catch blocks** -- Multiple files swallow errors silently (resolution.ts, health.ts, analysis.ts, state.ts). Intentional for resilience but makes debugging hard.
- **`normalizePolicy` doesn't validate** -- A malformed YAML policy file silently falls back to defaults with no diagnostic.
- **Cache path traversal risk** -- resolution.ts `getCachePath` only sanitizes `/` to `__` in dep.name. A package name containing `..` could escape the cache directory. Low real-world risk (npm doesn't allow `..` in package names) but worth hardening.
- **`repoName` from `basename(repoPath)`** -- pipeline.ts line 62 and index.ts line 331 derive repoName via `basename()`. If repoPath is `.` or ends with `/`, basename returns `.` or empty string, corrupting snapshot directory paths.
- **`loadLatestSnapshot` returns empty `licenses: []`** -- state.ts line 118. Any code consuming `Snapshot.licenses` after disk load gets nothing. Currently harmless because `computeDiff` only uses deps and evals.

## Known Issues (Intentionally Deferred -- MEDIUM priority from review)
1. **npm lockfile `isDirect` heuristic** -- extraction.ts marks packages as transitive only if path contains `node_modules/node_modules/`. Hoisted transitive deps appear as direct.
2. **pyproject.toml misses Poetry format** -- Parser targets PEP 621 only. Will not match `[tool.poetry.dependencies]` table format.
3. **Cargo workspace deps skipped** -- Rust parser matches `[dependencies]` but not `[workspace.dependencies]`.
4. **`verbose` param unused** -- health.ts `checkSingleHealth` accepts `verbose` but never forwards it.
5. **`diff.toSnapshot` mutation** -- pipeline.ts sets `diff.toSnapshot = snapshot.id` after `computeDiff` returns. Fragile ordering dependency.

## Next Actions
1. **Commit all current work** (CRITICAL -- nothing is saved)
2. Add `*:Zone.Identifier` to .gitignore before committing
3. Set up vitest as test framework
4. Write unit tests for `findMatchingRule` (SPDX compound expressions)
5. Write unit tests for `evaluateLicense` (policy evaluation paths)
6. Write unit tests for `classifySpdxExpression` (OR picks most permissive, AND picks most restrictive)
7. Write unit tests for `computeDiff` (handles both full PolicyEvaluation and flat stored format)
8. Address operator precedence in state.ts filter callbacks

## Files to Read First
1. `src/types.ts` -- All type definitions, the data model contract
2. `src/pipeline.ts` -- Orchestrator, shows the 10-phase flow
3. `src/policy.ts` -- Where the SPDX fixes live, most complex logic
4. `src/state.ts` -- Snapshot save/load/diff, the lossy roundtrip
5. `CLAUDE.md` -- Development guide with commands and architecture

## Commands to Run
```bash
npm install
npx tsc --noEmit
npx tsx src/index.ts scan . --verbose
npx tsx src/index.ts diff .
npx tsx src/index.ts summary .comply
npx tsx src/index.ts notices . | head -20
```

## Open Questions
- Should the project have a proper test suite before any more features?
- Is vitest the right choice? (ESM-native, fast, good TS support)
- Should the :Zone.Identifier files be cleaned up from the working directory?
- Should `normalizePolicy` throw on invalid YAML instead of silently falling back?
- Is the lossy state roundtrip acceptable long-term, or should full `PolicyEvaluation` be persisted?

## Confidence Levels
**High (Verified):** All 5 commands work. TypeScript compiles clean. 11 bugs fixed and tested. 115/115 deps compliant on self-scan.
**Medium (From session, not independently verified):** SPDX compound expression fix handles all edge cases correctly. State roundtrip helpers handle both formats.
**Low (Potential issue):** Operator precedence in state.ts filters may produce wrong newViolations/resolvedViolations counts in specific edge cases.

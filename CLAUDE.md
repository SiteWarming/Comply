# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Comply OSS is an AI-powered open source license compliance agent. It scans codebases, resolves licenses from registries, checks dependency health, uses a multi-agent AI pipeline to analyze *how* dependencies are used in context, evaluates compliance against configurable YAML policy, and generates reports with executive summaries, NOTICES files, and drift tracking.

Key differentiator: AI analyzes usage context (static linking, SaaS vs distributed, dev-only) to determine whether license obligations are actually triggered, not just whether a license exists.

**Dual-mode design:** Developers with AI assistants (Claude Code, Cursor) run `comply scan --for-assistant` — zero API keys needed, the assistant IS the AI layer. For CI/headless, `--ai` uses OpenRouter for multi-model access (free models for triage, premium only when needed). MCP server integration available via `comply mcp`.

## Commands

```bash
npm install                                          # Install dependencies
npm run build                                        # TypeScript compile (tsc)
npm run lint                                         # Type-check only (tsc --noEmit)
npx tsx src/cli/index.ts scan /path/to/repo --verbose    # Dev mode scan
npx tsx src/cli/index.ts scan /path/to/repo --ai         # With AI analysis
npx tsx src/cli/index.ts scan /path/to/repo --ai --ai-tier budget    # Free models only
npx tsx src/cli/index.ts scan /path/to/repo --ai --ai-tier premium   # All agents incl. premium
npx tsx src/cli/index.ts init                            # Generate default policy YAML
npx tsx src/cli/index.ts diff /path/to/repo              # Show changes since last scan
npx tsx src/cli/index.ts summary .comply -o report.md    # Org-wide multi-repo roll-up
npx tsx src/cli/index.ts notices /path/to/repo --save NOTICES  # Generate attribution file
npx tsx src/cli/index.ts scan /path/to/repo --for-assistant  # JSON for AI assistants (no API key)
npx tsx src/cli/index.ts eval                            # Run AI eval harness
npx tsx src/cli/index.ts eval --agent classifier -v      # Eval single agent, verbose
npx tsx src/cli/index.ts mcp                             # Start MCP server
npx tsx src/cli/index.ts init --mcp                      # Generate policy + .mcp.json
```

No test framework is set up yet. Manual testing uses fixture repos:
```bash
mkdir -p test/fixtures/sample-npm
echo '{"dependencies":{"express":"^4.18.0","chalk":"^5.3.0"}}' > test/fixtures/sample-npm/package.json
npx tsx src/cli/index.ts scan test/fixtures/sample-npm --verbose
```

## Architecture

### Pipeline (10 sequential phases)

`cli/index.ts` (CLI via commander) → `pipeline/pipeline.ts` (orchestrator) runs phases in order:

1. **Discovery** (`pipeline/discovery.ts`) — Walk repo tree matching `MANIFEST_PATTERNS` array (package.json, requirements.txt, go.mod, Cargo.toml, etc.)
2. **Workspace Detection** (`pipeline/workspaces.ts`) — Detect monorepo tools (npm, pnpm, lerna, nx, turborepo)
3. **Extraction** (`pipeline/extraction.ts`) — Parse manifest/lock files into `Dependency[]`
4. **Resolution** (`pipeline/resolution.ts`) — Hit npm/PyPI/crates.io/deps.dev registries for license info, batched 10 at a time with 30-day file cache under `.comply/cache/licenses/`. Go modules use deps.dev (primary) with GitHub license API fallback.
5. **Health** (`pipeline/health.ts`) — Check age, deprecation, license drift between pinned and latest versions (npm, PyPI, crates.io, deps.dev)
6. **Evaluation** (`pipeline/policy.ts`) — Apply YAML policy rules (allow/deny/allow_if/review) per license. Supports per-workspace distribution model overrides for monorepos.
7. **AI Analysis** (`ai/orchestrator.ts`) — Optional (`--ai`). Multi-agent pipeline: Classifier → Usage Analyzer → Obligation Reasoner → Conflict Detector → Remediation Advisor
8. **Reporting** (`output/reporting.ts` + `output/executive-summary.ts`) — Generate Markdown + JSON reports
9. **Drift** (`state/state.ts`) — Compare against previous snapshot, compute diff
10. **State + NOTICES** (`state/state.ts` + `output/notices.ts`) — Save snapshot to `.comply/repos/{name}/snapshots/{id}/`, generate NOTICES files

### AI Subsystem (`src/ai/`)

```
src/ai/
  types.ts              # ModelTier, CompletionRequest/Response, Message, AIConfig
  provider.ts           # AIProvider interface + ProviderFactory (auto-detects from env)
  providers/
    openrouter.ts       # Primary — OpenAI-compatible REST via native fetch
    anthropic.ts        # Fallback — direct Anthropic SDK
  router.ts             # Maps model tiers (free/mid/premium) to model IDs
  prompts.ts            # PromptLoader — reads prompts/*.prompt.md files at runtime
  schemas.ts            # Zod output schemas for all agents + parseAndValidate()
  cache.ts              # File-based AI result caching (.comply/cache/ai/)
  orchestrator.ts       # Multi-agent pipeline router (classifier→usage→obligation→conflict→remediation)
  overrides.ts          # Load comply-overrides.yaml for manual corrections
  eval.ts               # Eval harness — scores agents against ground truth
  agents/
    base.ts             # BaseAgent abstract class (prompt rendering, retry, validation)
    classifier.ts       # Free tier — triage: dev-only? test-only? build-tool? runtime?
    usage-analyzer.ts   # Mid tier — how is dependency used (import, static link, vendored)?
    obligation-reasoner.ts  # Mid/premium — does usage + distribution trigger obligations?
    conflict-detector.ts    # Premium — cross-dependency license compatibility
    remediation-advisor.ts  # Mid — suggest alternatives for non-compliant deps
    executive-summary.ts    # Mid — AI-polished executive summary (opt-in)
```

**Agent routing:** Classifier runs first on free tier. If classified as dev/test/build with high confidence, deeper agents are skipped (saving cost). Usage Analyzer and Obligation Reasoner run on mid tier for runtime packages. Conflict Detector runs once on premium tier if 2+ copyleft deps in runtime. Remediation Advisor runs for non-compliant results.

**Tier ceiling (`--ai-tier`):** `budget` = free only ($0), `balanced` = free+mid (default), `premium` = all agents.

### Prompt Management

All prompts live in `prompts/*.prompt.md` — YAML front-matter + Markdown body. Zero prompt text in source code. The PromptLoader reads them at runtime with `{{variable}}` substitution. Prompt version is part of the cache key.

### Key types

All types live in `types.ts`. The core data flow is:
`ManifestFile[]` → `Dependency[]` → `ResolvedLicense[]` → `PolicyEvaluation[]` → `AuditReport`

### State model

`.comply/` directory is the audit database (filesystem, no external DB). Structure:
- `repos/{name}/meta.json` — Last run info
- `repos/{name}/snapshots/{id}/` — Full audit artifacts (snapshot.json, manifest.json, licenses.json, policy-eval.json, health.json, report.md, report.json, NOTICES)
- `repos/{name}/diffs/` — Inter-scan diffs
- `cache/licenses/{ecosystem}/{package}.json` — 30-day TTL registry cache
- `cache/ai/{agent}/{hash}.json` — 30-day TTL AI result cache

### Assistant Mode & MCP Server

**`--for-assistant` mode** (`output/assistant-report.ts`): Outputs structured JSON (`AssistantReport`) containing meta, summary, flagged packages with full context (license details, policy evaluation, health data, code snippets), and a pre-written analysis prompt. The developer's AI assistant reasons about this data directly — no API keys needed.

**MCP server** (`cli/mcp-server.ts`): Exposes four tools over stdio for deep AI assistant integration:
- `comply_scan` — Full compliance scan returning AssistantReport JSON
- `comply_explain_license` — License explanation with distribution-model-aware obligation analysis
- `comply_diff` — Changes since last scan
- `comply_policy` — Current policy configuration

Setup: `comply init --mcp` generates `.mcp.json`, or `comply mcp` starts the server directly.

### Module boundaries

Each module has a clear input/output contract. `pipeline/pipeline.ts` is the only file that imports from all modules. The `ai/` subsystem is self-contained — `pipeline.ts` calls `runAIOrchestrator()` and gets back updated evaluations. `state/spdx.ts` is a pure utility (license classification database) used by `pipeline/resolution.ts` and `pipeline/policy.ts`.

### Source tree

```
src/
  types.ts              # Shared types (ManifestFile, Dependency, PolicyEvaluation, etc.)
  cli/                  # CLI entry points
    index.ts            # commander CLI
    mcp-server.ts       # MCP server for AI assistants
  pipeline/             # Core audit phases (run in order by pipeline.ts)
    pipeline.ts         # Orchestrator — imports and sequences all phases
    discovery.ts        # Phase 1: find manifest/lock files
    workspaces.ts       # Phase 2: monorepo workspace detection
    extraction.ts       # Phase 3: parse manifests into Dependency[]
    resolution.ts       # Phase 4: resolve licenses from registries
    health.ts           # Phase 5: dependency age/deprecation signals
    policy.ts           # Phase 6: evaluate against YAML policy rules
    analysis.ts         # Usage analysis bridge to AI subsystem
    fix.ts              # Auto-resolve obvious compliance issues
  output/               # Report generation and formatting
    reporting.ts        # Markdown + JSON report builder
    executive-summary.ts # Plain-English summary for stakeholders
    notices.ts          # NOTICES/ATTRIBUTION file generator
    assistant-report.ts # Structured JSON for --for-assistant mode
    summary.ts          # Org-wide multi-repo roll-up
  state/                # Persistence and reference data
    state.ts            # Snapshot management, drift/diff tracking
    spdx.ts             # SPDX license classification database
  ai/                   # AI analysis subsystem (self-contained)
    ...                 # See AI Subsystem section above
```

## Adding a New Ecosystem

1. Add filename patterns to `MANIFEST_PATTERNS` in `pipeline/discovery.ts`
2. Add parser case in `pipeline/extraction.ts`
3. Add registry resolver function in `pipeline/resolution.ts`
4. Add health checker in `pipeline/health.ts`
5. Policy, reporting, state, AI, and workspaces are ecosystem-agnostic — no changes needed

## Adding a New AI Agent

1. Create prompt file in `prompts/{name}.prompt.md` with YAML front-matter
2. Add Zod output schema in `src/ai/schemas.ts`
3. Create agent class in `src/ai/agents/{name}.ts` extending `BaseAgent`
4. Add ground truth cases in `eval/ground-truth/`
5. Wire into `src/ai/orchestrator.ts` routing logic

## Environment Variables

- `OPENROUTER_API_KEY` — Recommended for `--ai` flag (covers all models via OpenRouter)
- `ANTHROPIC_API_KEY` — Alternative for direct Anthropic access

## Tech Stack

- TypeScript (strict, ES2022, ESM modules with `.js` extension imports)
- Runtime: Node.js >=20
- CLI: commander
- Dependencies: @anthropic-ai/sdk, @modelcontextprotocol/sdk, yaml, glob, chalk, ora, zod
- No test framework, no linter, no formatter configured yet
- Build output: `dist/` (declaration maps + source maps enabled)

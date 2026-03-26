# Comply OSS

**AI-powered open source license compliance agent.**

Comply scans your codebase, resolves licenses for every dependency, evaluates compliance against your policy, and uses AI to analyze *how* flagged packages are actually used — because "GPL detected" isn't the same as "GPL obligations triggered."

## Why This Exists

Existing tools (FOSSA, Snyk, WhiteSource) flag licenses but don't reason about context. They'll tell you "GPL detected in 14 packages" with zero context about whether your specific usage actually triggers copyleft obligations. The answer depends on your distribution model, how the code is linked, and whether you're shipping a product or running a service. Those tools don't make that distinction.

Comply does. It reads your actual source code to determine whether the way you use a package triggers its license terms. GPL in a SaaS product that's never distributed? Usually fine. GPL in a CLI tool shipped to customers? That's a real problem. AGPL in anything network-facing? Red alert. Comply makes those distinctions automatically.

### Built For

- **PE/M&A Due Diligence** — Scan every repo in a target company's GitHub org. Hand the executive summary to counsel. Attach the detailed reports to the diligence memo.
- **Engineering Compliance** — Run in CI, fail builds on new violations, generate NOTICES files automatically.
- **Legal Teams** — Human-readable reports with severity tiers, plain-English executive summaries, and specific remediation steps.
- **Open Source Maintainers** — Keep your dependency tree clean. Auto-generate the NOTICES/ATTRIBUTION file most projects forget.

## Quick Start

```bash
# Scan the current directory
npx comply-oss scan .

# Or install globally
npm install -g comply-oss
comply scan /path/to/your/repo --verbose
```

## Commands

### `comply scan [path]`

Core audit command. Scans a repository and produces a full compliance report.

```bash
comply scan .                           # Basic scan
comply scan . --verbose                 # Show detailed progress
comply scan . --ai                      # Enable AI usage analysis
comply scan . --policy comply-policy.yaml   # Use custom policy
comply scan . --ci                      # CI mode (GitHub Actions annotations)
comply scan . --ci --fail-on critical   # Only fail on critical violations
comply scan . --ci --fail-on new        # Only fail on new violations since last scan
comply scan . --diff-only               # Only analyze changes since last snapshot
comply scan . --ecosystem npm python    # Only scan specific ecosystems
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--ai` | Enable AI-powered usage analysis for flagged packages. Requires `ANTHROPIC_API_KEY`. |
| `--ai-model <model>` | AI model to use (default: `claude-sonnet-4-20250514`) |
| `--ai-limit <n>` | Max packages to analyze with AI (default: 20) |
| `--policy <file>` | Path to YAML policy file |
| `--ci` | CI mode: outputs GitHub Actions annotations, machine-readable |
| `--fail-on <level>` | CI exit condition: `any`, `critical`, `high`, `new` (default: `any`) |
| `--diff-only` | Only deep-analyze dependencies that changed since last scan |
| `--ecosystem <list>` | Restrict to specific ecosystems |
| `-v, --verbose` | Detailed progress output |
| `-o, --output <dir>` | Audit state directory (default: `.comply`) |

### `comply init`

Generate a policy file with sensible defaults.

```bash
comply init                             # Creates comply-policy.yaml
comply init -o my-policy.yaml           # Custom filename
```

### `comply summary [audit-dir]`

Multi-repo org-wide compliance roll-up. Reads all repo snapshots from the shared audit directory and produces a single dashboard.

```bash
comply summary .comply                  # Markdown to stdout
comply summary .comply -o report.md     # Save to file
comply summary .comply --json           # JSON output
comply summary .comply --json -o org-compliance.json
```

This is the diligence deliverable — one page showing every repo's risk score, aggregate statistics, and cross-repo violations (the same violating package appearing in multiple repos).

### `comply notices [path]`

Generate a NOTICES/ATTRIBUTION file from the latest scan.

```bash
comply notices .                        # Print to stdout
comply notices . --save NOTICES         # Save to file
comply notices . --format markdown      # Markdown format
comply notices . --all                  # Include all packages, not just attribution-required
```

### `comply diff [path]`

Show what changed since the last scan.

```bash
comply diff .
```

## What the Report Contains

Each scan generates a Markdown report with these sections:

1. **Executive Summary** — A 3-5 sentence plain-English assessment suitable for non-technical stakeholders. Risk level, key findings, and a clear recommendation.

2. **Detailed Summary** — Counts: total dependencies, direct vs. transitive, compliant, non-compliant, needs review.

3. **Monorepo Structure** — If detected, shows workspace layout with per-workspace dependency counts.

4. **Violations** — Each non-compliant package with license, severity, reason, and specific remediation steps (replace with X, add notice, refactor to avoid static linking, etc.).

5. **Dependency Health** — Deprecated packages, abandoned packages (3+ years without updates), and packages where the license changed in newer versions.

6. **License Distribution** — Breakdown by license type and tier (permissive, weak copyleft, strong copyleft, etc.).

7. **Drift** — What changed since the last scan (added, removed, version bumped, status changed).

Plus a machine-readable JSON version of everything.

## CI Integration

```yaml
# GitHub Actions
- name: License Compliance
  run: npx comply-oss scan . --ci --policy comply-policy.yaml
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}  # Optional, for AI analysis
```

Comply exits with code 1 if violations are found. Use `--fail-on` to control sensitivity:

- `--fail-on any` — Fail on any violation (default)
- `--fail-on critical` — Only fail on AGPL/SSPL-level issues
- `--fail-on high` — Fail on critical + GPL violations
- `--fail-on new` — Only fail on violations introduced since last scan (allows existing tech debt while preventing new issues)

## Supported Ecosystems

| Ecosystem | Manifests | Lock Files | Registry Lookup | AI Analysis |
|-----------|-----------|-----------|-----------------|-------------|
| npm/Node.js | ✅ package.json | ✅ package-lock.json | ✅ npmjs.org | ✅ |
| Python | ✅ requirements.txt, pyproject.toml | 🔜 poetry.lock | ✅ pypi.org | ✅ |
| Go | ✅ go.mod | 🔜 go.sum | 🔜 | ✅ |
| Rust | ✅ Cargo.toml | 🔜 Cargo.lock | 🔜 | ✅ |
| Java | 🔜 pom.xml, build.gradle | 🔜 | 🔜 | 🔜 |
| Ruby | 🔜 Gemfile | 🔜 | 🔜 | 🔜 |
| .NET | 🔜 .csproj | 🔜 | 🔜 | 🔜 |

## Monorepo Support

Comply detects monorepo workspace structures automatically:

- **npm workspaces** (package.json `workspaces` field)
- **pnpm workspaces** (pnpm-workspace.yaml)
- **Lerna** (lerna.json)
- **Nx** (nx.json)
- **Turborepo** (turbo.json, delegates to npm/pnpm workspace detection)

When a monorepo is detected, dependencies are scoped to their containing workspace. The policy file supports per-workspace distribution model overrides:

```yaml
distribution_model:
  default: saas
  overrides:
    packages/cli: distributed
    packages/internal-tools: internal
```

## How It Works

```
Repository
  ↓
Discovery ── find package.json, requirements.txt, go.mod, etc.
  ↓
Workspace Detection ── detect monorepo structure, scope dependencies
  ↓
Extraction ── parse manifests into dependency lists
  ↓
License Resolution ── query npm/PyPI registries, cache results
  ↓
Health Check ── age, deprecation, license drift between versions
  ↓
Policy Evaluation ── check each license against your rules
  ↓
AI Analysis ── (optional) read source code to determine usage context
  ↓
Report Generation ── executive summary, violations, health, NOTICES
  ↓
State Persistence ── snapshot to .comply/, compute diff from last run
```

## State Directory

Comply persists audit state as files — no database required. The folder structure is the audit.

```
.comply/
├── repos/{repo}/
│   ├── meta.json              # Last run metadata
│   ├── snapshots/{id}/
│   │   ├── snapshot.json      # Run metadata
│   │   ├── manifest.json      # Dependency tree
│   │   ├── licenses.json      # Resolved licenses
│   │   ├── policy-eval.json   # Compliance results
│   │   ├── health.json        # Dependency age/deprecation data
│   │   ├── workspaces.json    # Monorepo workspace mapping
│   │   ├── report.md          # Human-readable report
│   │   ├── report.json        # Machine-readable report
│   │   ├── NOTICES            # Attribution file (text)
│   │   └── NOTICES.md         # Attribution file (markdown)
│   └── diffs/                 # Changes between scans
└── cache/licenses/            # Registry lookup cache (30-day TTL)
```

## What This Is Good At

- **Single-repo scans** of npm and Python projects with full license resolution
- **Identifying non-permissive licenses** and classifying them by risk tier
- **Executive summaries** that non-technical stakeholders can read in 30 seconds
- **AI-powered usage analysis** that determines whether your specific usage pattern triggers license obligations
- **Drift detection** across repeated scans — only deep-analyze what changed
- **Multi-repo roll-ups** for org-wide visibility
- **NOTICES file generation** for proper attribution compliance
- **CI integration** with configurable failure thresholds

## What This Is Not Good At (Yet)

We believe in being honest about limitations. Here's what Comply doesn't handle well today, and what we're working toward.

### Build Artifact Analysis

Comply analyzes your dependency tree as declared in manifest files. It does **not** analyze what actually ships in your final bundle. A modern JS project might have 800 packages in node_modules but only bundle 200 into production. From a compliance perspective, only what ships matters for distribution-triggered obligations. Comply currently treats all declared runtime dependencies as potentially shipped, which means it will flag some packages that get tree-shaken out. This is a conservative approach — it will over-flag rather than under-flag — but it means the violation count may be higher than reality.

**What would fix this:** Reading webpack stats files, esbuild metafiles, or Rollup output to determine what actually ends up in the distributed artifact. This is on the roadmap.

### Vendored / Copy-Pasted Code

Comply finds dependencies declared in manifest files. It does **not** detect open source code that was copy-pasted directly into your codebase without being declared as a dependency. This is common in older codebases and is a significant compliance risk that Comply will miss entirely.

**What would fix this:** Source code fingerprinting against known open source libraries (similar to what Google's OSS scanner does). This is complex and is a v2 feature.

### License Resolution Completeness

License resolution depends on registry APIs (npm, PyPI). Some packages have missing, malformed, or ambiguous license metadata. Comply handles SPDX expressions and common aliases, but unusual license strings or custom licenses will be classified as "unknown" and flagged for manual review. The Go and Rust ecosystem resolvers are not yet connected to their respective registries (pkg.go.dev, crates.io) — those ecosystems will discover dependencies but won't resolve licenses automatically.

### Monorepo Compliance Scoping

Comply detects workspace structure and scopes dependencies to workspaces, but **policy evaluation is not yet per-workspace**. All dependencies are currently evaluated against the repo-level distribution model. The policy file schema supports per-workspace overrides, but the evaluation engine doesn't read them yet. This means in a monorepo with both a CLI tool (distributed) and an internal dashboard (internal), both get evaluated with the same rules.

### Legal Advice

Comply is a technical tool, not a lawyer. Its compliance assessments are based on commonly understood interpretations of open source licenses, but license law is jurisdiction-dependent and fact-specific. The reports should be used as inputs to a legal review, not as substitutes for one. In particular:

- License compatibility analysis (can MIT + GPL coexist in the same project?) is simplified
- Dual-licensing and commercial license exceptions are not detected
- Fair use, license exceptions, and jurisdiction-specific rules are not considered
- The distinction between "linking" in compiled languages vs. "importing" in interpreted languages is a genuinely unsettled legal question that Comply takes a conservative position on

### Large-Scale Performance

First scan of a repo with 2,000+ dependencies will take several minutes due to registry API calls. The 30-day license cache makes subsequent scans fast, but the initial scan is network-bound. AI analysis at scale (100+ flagged packages) will incur significant API costs.

### Ecosystem Coverage

npm and Python have the deepest support. Go and Rust have dependency extraction but no registry-backed license resolution. Java, Ruby, .NET, and PHP have manifest detection only — the parsers and resolvers need community contribution.

## Contributing

The codebase is intentionally modular. Each phase is a standalone module with clear inputs and outputs. To add support for a new ecosystem:

1. Add manifest filename patterns to `src/discovery.ts`
2. Add a parser function to `src/extraction.ts`
3. Add a registry resolver to `src/resolution.ts`
4. Add a health checker to `src/health.ts`
5. Everything else (policy, reporting, state) is ecosystem-agnostic

See [CLAUDE.md](./CLAUDE.md) for the full development guide, architecture decisions, and roadmap.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | For `--ai` flag | Claude API key for usage analysis |

## License

Apache-2.0 — because a license compliance tool really shouldn't have license compliance issues.

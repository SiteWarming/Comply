#!/usr/bin/env node
// ============================================================================
// Comply OSS — CLI Entry Point
// ============================================================================

import { Command } from 'commander';
import { resolve, basename, join } from 'node:path';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { runPipeline } from '../pipeline/pipeline.js';
import { getDefaultPolicy, loadPolicy } from '../pipeline/policy.js';
import { generateOrgSummary, renderOrgSummaryMarkdown } from '../output/summary.js';
import { generateNoticesFile, saveNoticesFile } from '../output/notices.js';
import { buildAssistantReport } from '../output/assistant-report.js';
import YAML from 'yaml';
import type { ComplyConfig, Ecosystem } from '../types.js';

const VERSION = '0.1.0';

const program = new Command();

program
  .name('comply')
  .description('AI-powered open source license compliance agent')
  .version(VERSION);

// ============================================================================
// scan — Core audit command
// ============================================================================
program
  .command('scan')
  .description('Scan a repository for license compliance')
  .argument('[path]', 'Path to the repository to scan', '.')
  .option('-o, --output <dir>', 'Output directory for audit state', '.comply')
  .option('-p, --policy <file>', 'Path to policy YAML file')
  .option('--ai', 'Enable AI-powered usage analysis for flagged packages')
  .option('--ai-provider <name>', 'AI provider: openrouter (default) or anthropic')
  .option('--ai-model <model>', 'AI model override (bypasses tier routing)')
  .option('--ai-key <key>', 'AI API key (overrides env vars)')
  .option('--ai-tier <tier>', 'AI tier ceiling: budget, balanced (default), premium', 'balanced')
  .option('--ai-limit <n>', 'Max packages to analyze with AI', '20')
  .option('--ai-cache-ttl <days>', 'AI cache TTL in days', '30')
  .option('--ai-summary', 'Use AI to polish executive summary')
  .option('--prompts-dir <path>', 'Custom prompts directory')
  .option('--for-assistant', 'Output structured JSON for AI assistant consumption (no API key needed)')
  .option('--ecosystem <ecosystems...>', 'Only scan these ecosystems (npm, python, go, rust)')
  .option('--diff-only', 'Only analyze changes since last scan')
  .option('--ci', 'CI mode: output GitHub Actions annotations')
  .option('--fail-on <level>', 'Exit non-zero on: any, critical, high, new (default: any)', 'any')
  .option('-v, --verbose', 'Verbose output')
  .action(async (path: string, options: any) => {
    const repoPath = resolve(path);
    const auditDir = resolve(options.output);
    const ciMode = !!options.ci;
    const assistantMode = !!options.forAssistant;
    const quietMode = ciMode || assistantMode;

    if (!quietMode) {
      console.log('');
      console.log(`  ╭─────────────────────────────────────╮`);
      console.log(`  │  🔍 Comply OSS v${VERSION}              │`);
      console.log(`  │  License Compliance Agent            │`);
      console.log(`  ╰─────────────────────────────────────╯`);
      console.log('');
      console.log(`  Repository: ${repoPath}`);
      console.log(`  Audit Dir:  ${auditDir}`);
      if (options.policy) console.log(`  Policy:     ${options.policy}`);
      if (options.ai) {
        const providerName = options.aiProvider || 'auto-detect';
        const tierName = options.aiTier || 'balanced';
        console.log(`  AI Analysis: enabled (provider: ${providerName}, tier: ${tierName})`);
      }
      console.log('');
    }

    const config: ComplyConfig = {
      repoPath,
      auditDir,
      policyPath: options.policy ? resolve(options.policy) : undefined,
      enableAIAnalysis: assistantMode ? false : !!options.ai,
      ai: options.ai ? {
        provider: (options.aiProvider as 'openrouter' | 'anthropic') || undefined as any,
        model: options.aiModel,
        apiKey: options.aiKey,
      } : undefined,
      ecosystems: options.ecosystem as Ecosystem[] | undefined,
      aiAnalysisLimit: parseInt(options.aiLimit, 10),
      aiTier: options.aiTier as ComplyConfig['aiTier'],
      diffOnly: !!options.diffOnly,
      verbose: !!options.verbose,
    };

    try {
      const result = await runPipeline(config, quietMode ? undefined : {
        onPhase(phase, detail) {
          const icons: Record<string, string> = {
            discovery: '📂',
            workspaces: '📦',
            extraction: '📦',
            resolution: '🔑',
            health: '⚕️',
            evaluation: '⚖️',
            analysis: '🤖',
            drift: '📊',
            reporting: '📝',
            notices: '📄',
            saving: '💾',
          };
          console.log(`  ${icons[phase] || '▸'} ${detail || phase}`);
        },
        onProgress(current, total, item) {
          process.stdout.write(`    [${current}/${total}] Analyzing ${item}...\r`);
        },
      });

      // ---- CI Mode Output ----
      if (ciMode) {
        // GitHub Actions annotation format
        if (result.ciAnnotations) {
          for (const ann of result.ciAnnotations) {
            const file = ann.file ? `,file=${ann.file}` : '';
            console.log(`::${ann.level}${file}::${ann.message}`);
          }
        }

        // Output summary as step output (GITHUB_OUTPUT file for modern runners)
        const ghOutput = process.env.GITHUB_OUTPUT;
        if (ghOutput) {
          const { appendFileSync } = await import('node:fs');
          appendFileSync(ghOutput, `risk_score=${result.summary.riskScore}\n`);
          appendFileSync(ghOutput, `violations=${result.summary.nonCompliant}\n`);
          appendFileSync(ghOutput, `total=${result.summary.total}\n`);
          appendFileSync(ghOutput, `report=${result.reportPath}\n`);
        }

        // Determine exit code based on --fail-on
        const shouldFail = determineCIFailure(result, options.failOn);
        if (shouldFail) {
          process.exit(1);
        }
        return;
      }

      // ---- Assistant Mode Output ----
      if (assistantMode) {
        const policy = await loadPolicy(config.policyPath);
        const distributionModel = policy.distributionModel?.default ?? 'saas';

        const report = await buildAssistantReport({
          repoPath,
          distributionModel,
          ecosystems: result.ecosystems ?? [],
          evaluations: result.evaluations ?? [],
          healthData: result.healthData,
          riskScore: result.summary.riskScore,
        });

        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        return;
      }

      // ---- Interactive Output ----
      console.log('');
      console.log('  ─────────────────────────────────────');
      console.log('');

      const s = result.summary;
      const riskLabel = s.riskScore === 0 ? '✅ CLEAN' :
        s.riskScore <= 20 ? '🟢 LOW RISK' :
        s.riskScore <= 50 ? '🟡 MODERATE' :
        s.riskScore <= 80 ? '🟠 HIGH RISK' : '🔴 CRITICAL';

      console.log(`  Risk Score: ${s.riskScore}/100 ${riskLabel}`);
      console.log('');
      console.log(`  Total:            ${s.total}`);
      console.log(`  ✅ Compliant:      ${s.compliant}`);
      console.log(`  ❌ Non-Compliant:  ${s.nonCompliant}`);
      console.log(`  ⚠️  Needs Review:  ${s.needsReview}`);
      console.log('');

      // Workspace info
      if (result.workspaceConfig) {
        console.log(`  📦 Monorepo (${result.workspaceConfig.tool}): ${result.workspaceConfig.workspaces.length} workspaces`);
        console.log('');
      }

      // Health highlights
      if (result.healthData) {
        const deprecated = result.healthData.filter(h => h.isDeprecated).length;
        const abandoned = result.healthData.filter(h => h.maintenanceRisk === 'abandoned' && !h.isDeprecated).length;
        const licenseChanged = result.healthData.filter(h => h.licenseChanged).length;

        if (deprecated > 0 || abandoned > 0 || licenseChanged > 0) {
          console.log('  ⚕️  Health Alerts:');
          if (deprecated > 0) console.log(`     🚫 ${deprecated} deprecated package(s)`);
          if (abandoned > 0) console.log(`     🔴 ${abandoned} abandoned package(s) (3+ years)`);
          if (licenseChanged > 0) console.log(`     ⚠️  ${licenseChanged} license(s) changed in newer versions`);
          console.log('');
        }
      }

      // Diff info
      if (result.diff) {
        const d = result.diff.summary;
        console.log(`  📊 Changes since last scan:`);
        console.log(`     Added: ${d.added}  Removed: ${d.removed}  Changed: ${d.changed}`);
        if (d.newViolations > 0) {
          console.log(`     ⚠️  ${d.newViolations} new violation(s)`);
        }
        if (d.resolvedViolations > 0) {
          console.log(`     ✅ ${d.resolvedViolations} violation(s) resolved`);
        }
        console.log('');
      }

      console.log(`  📝 Report:  ${result.reportPath}`);
      console.log(`  📋 JSON:    ${result.jsonPath}`);
      if (result.noticesPath) {
        console.log(`  📄 NOTICES: ${result.noticesPath}`);
      }
      console.log('');

      // On first scan, ensure .comply/ is gitignored
      await ensureGitignore(auditDir);

      // Exit with non-zero if there are violations
      if (s.nonCompliant > 0) {
        process.exit(1);
      }
    } catch (err) {
      console.error(`\n  ❌ Error: ${(err as Error).message}\n`);
      if (options.verbose) {
        console.error((err as Error).stack);
      }
      process.exit(2);
    }
  });

// ============================================================================
// init — Create a policy file with sensible defaults
// ============================================================================
program
  .command('init')
  .description('Initialize a policy file with sensible defaults')
  .option('-o, --output <file>', 'Output path for policy file', 'comply-policy.yaml')
  .option('--mcp', 'Also generate .mcp.json for AI assistant integration')
  .action(async (options: any) => {
    const outputPath = resolve(options.output);

    const yamlContent = `# Comply OSS — License Policy Configuration
# https://github.com/comply-oss/comply
#
# This file defines your organization's open source license compliance policy.
# Customize the rules below to match your distribution model and risk tolerance.

version: 1

# How your software is distributed. This affects which licenses trigger obligations.
# Options: saas, distributed, internal, library, cli
distribution_model:
  default: saas
  # Per-workspace overrides for monorepos:
  # overrides:
  #   packages/cli: distributed
  #   packages/internal-tools: internal

# License rules define how each license category is handled.
# Actions: allow, allow_if (conditional), deny, review
license_rules:
  permissive:
    licenses:
      - MIT
      - BSD-2-Clause
      - BSD-3-Clause
      - Apache-2.0
      - ISC
      - 0BSD
      - Unlicense
      - CC0-1.0
      - WTFPL
      - Zlib
      - BSL-1.0
      - BlueOak-1.0.0
      - Artistic-2.0
      - Python-2.0
      - X11
      - CC-BY-4.0
      - CC-BY-3.0
    action: allow

  weak_copyleft:
    licenses:
      - LGPL-2.0
      - LGPL-2.1
      - LGPL-3.0
      - MPL-2.0
      - EPL-1.0
      - EPL-2.0
      - EUPL-1.2
      - CC-BY-SA-4.0
    action: allow_if
    conditions:
      - dynamic_linking_only
      - no_modifications

  strong_copyleft:
    licenses:
      - GPL-2.0
      - GPL-3.0
    action: allow_if
    conditions:
      - internal_use_only

  network_copyleft:
    licenses:
      - AGPL-3.0
      - SSPL-1.0
    action: deny
    reason: "Network copyleft licenses require source disclosure for SaaS use"

  non_commercial:
    licenses:
      - CC-BY-NC-4.0
      - CC-BY-NC-SA-4.0
      - CC-BY-NC-ND-4.0
    action: deny
    reason: "Incompatible with commercial use"

# Severity levels for reporting and CI gates
severity_levels:
  critical:
    - AGPL-3.0
    - SSPL-1.0
  high:
    - GPL-2.0
    - GPL-3.0
    - CC-BY-NC-4.0
  medium:
    - LGPL-2.1
    - LGPL-3.0
    - MPL-2.0
    - EPL-2.0
  low:
    - Apache-2.0
  none:
    - MIT
    - BSD-2-Clause
    - BSD-3-Clause
    - ISC
    - 0BSD
    - Unlicense

# Packages explicitly approved regardless of license
# allowlist:
#   - some-gpl-package-we-reviewed

# Packages explicitly denied regardless of license
# denylist:
#   - known-malicious-package

# AI analysis configuration
# Uncomment and customize to control AI-powered analysis
# ai:
#   provider: openrouter              # openrouter (recommended) or anthropic
#   tier: balanced                    # budget (free models only), balanced (default), premium (all)
#   overrides_file: comply-overrides.yaml
#   cache_ttl_days: 30
#   models:
#     free:
#       - google/gemini-flash-1.5
#       - deepseek/deepseek-chat
#     mid:
#       - anthropic/claude-sonnet-4-20250514
#     premium:
#       - anthropic/claude-opus-4-20250514
`;

    await writeFile(outputPath, yamlContent);
    console.log(`\n  ✅ Policy file created: ${outputPath}\n`);
    console.log(`  Edit this file to customize your compliance rules,`);
    console.log(`  then run: comply scan --policy ${options.output}\n`);

    // Ensure .comply/ is in .gitignore
    await ensureGitignore('.comply');

    if (options.mcp) {
      const mcpConfig = {
        mcpServers: {
          comply: {
            command: 'npx',
            args: ['comply-oss', 'mcp'],
          },
        },
      };
      const mcpPath = resolve('.mcp.json');
      await writeFile(mcpPath, JSON.stringify(mcpConfig, null, 2) + '\n');
      console.log(`  🔌 MCP config created: .mcp.json`);
      console.log(`  AI assistants (Claude Code, Cursor) can now use Comply tools directly.\n`);
    }
  });

// ============================================================================
// diff — Show changes since the last scan
// ============================================================================
program
  .command('diff')
  .description('Show changes since the last scan')
  .argument('[path]', 'Path to the repository', '.')
  .option('-o, --output <dir>', 'Audit state directory', '.comply')
  .action(async (path: string, options: any) => {
    const repoPath = resolve(path);
    const auditDir = resolve(options.output);
    const repoName = basename(repoPath);

    try {
      const diffDir = join(auditDir, 'repos', repoName, 'diffs');
      let files: string[];
      try {
        files = await readdir(diffDir);
      } catch {
        console.log('\n  No previous diffs found. Run `comply scan` at least twice.\n');
        return;
      }
      const latestDiff = files.sort().pop();

      if (!latestDiff) {
        console.log('\n  No previous diffs found. Run `comply scan` at least twice.\n');
        return;
      }

      const diff = JSON.parse(await readFile(join(diffDir, latestDiff), 'utf-8'));

      console.log(`\n  📊 Diff: ${diff.fromSnapshot} → ${diff.toSnapshot}`);
      console.log(`  Date: ${new Date(diff.timestamp).toLocaleString()}`);
      console.log('');
      console.log(`  Added:    ${diff.summary.added}`);
      console.log(`  Removed:  ${diff.summary.removed}`);
      console.log(`  Changed:  ${diff.summary.changed}`);
      if (diff.summary.newViolations > 0) {
        console.log(`  ⚠️  New Violations: ${diff.summary.newViolations}`);
      }
      if (diff.summary.resolvedViolations > 0) {
        console.log(`  ✅ Resolved: ${diff.summary.resolvedViolations}`);
      }
      console.log('');

      for (const entry of diff.entries) {
        switch (entry.type) {
          case 'added':
            console.log(`  + ${entry.dependency} ${entry.after?.version || ''} [${entry.after?.license || '?'}] ${entry.after?.status || ''}`);
            break;
          case 'removed':
            console.log(`  - ${entry.dependency} ${entry.before?.version || ''}`);
            break;
          case 'version_changed':
            console.log(`  ~ ${entry.dependency} ${entry.before?.version} → ${entry.after?.version}`);
            break;
          case 'status_changed':
            console.log(`  ! ${entry.dependency} ${entry.before?.status} → ${entry.after?.status}`);
            break;
        }
      }
      console.log('');
    } catch (err) {
      console.error(`\n  ❌ Error: ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

// ============================================================================
// summary — Multi-repo org-wide compliance roll-up
// ============================================================================
program
  .command('summary')
  .description('Generate org-wide compliance summary across all scanned repos')
  .argument('[audit-dir]', 'Path to the shared audit directory', '.comply')
  .option('--json', 'Output as JSON instead of Markdown')
  .option('-o, --output <file>', 'Save summary to file')
  .action(async (auditDirArg: string, options: any) => {
    const auditDir = resolve(auditDirArg);

    try {
      console.log('\n  📊 Generating organization compliance summary...\n');

      const summary = await generateOrgSummary(auditDir);

      if (options.json) {
        const output = JSON.stringify(summary, null, 2);
        if (options.output) {
          await writeFile(resolve(options.output), output);
          console.log(`  ✅ JSON summary saved to ${options.output}\n`);
        } else {
          console.log(output);
        }
        return;
      }

      const markdown = renderOrgSummaryMarkdown(summary);

      if (options.output) {
        await writeFile(resolve(options.output), markdown);
        console.log(`  ✅ Summary saved to ${options.output}\n`);
      } else {
        // Print to console
        console.log(markdown);
      }

      // Always print key stats
      const a = summary.aggregate;
      console.log('');
      console.log('  ─────────────────────────────────────');
      const riskLabel = a.aggregateRiskScore === 0 ? '✅ CLEAN' :
        a.aggregateRiskScore <= 20 ? '🟢 LOW RISK' :
        a.aggregateRiskScore <= 50 ? '🟡 MODERATE' :
        a.aggregateRiskScore <= 80 ? '🟠 HIGH RISK' : '🔴 CRITICAL';

      console.log(`  Org Risk: ${a.aggregateRiskScore}/100 ${riskLabel}`);
      console.log(`  Repos: ${summary.metadata.repoCount} (${a.cleanRepos} clean, ${a.violatingRepos} with violations)`);
      console.log(`  Total Dependencies: ${a.totalDependencies}`);
      console.log(`  Violations: ${a.nonCompliant}`);
      if (summary.crossRepoViolations.length > 0) {
        console.log(`  Cross-Repo Issues: ${summary.crossRepoViolations.length} shared violating package(s)`);
      }
      console.log('');
    } catch (err) {
      console.error(`\n  ❌ Error: ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

// ============================================================================
// notices — Generate a NOTICES/ATTRIBUTION file from the latest scan
// ============================================================================
program
  .command('notices')
  .description('Generate a NOTICES/ATTRIBUTION file from the latest scan')
  .argument('[path]', 'Path to the repository', '.')
  .option('-o, --output <dir>', 'Audit state directory', '.comply')
  .option('--format <fmt>', 'Output format: text or markdown', 'text')
  .option('--all', 'Include all packages, not just those requiring attribution')
  .option('--save <file>', 'Save to specific file path')
  .action(async (path: string, options: any) => {
    const repoPath = resolve(path);
    const auditDir = resolve(options.output);
    const repoName = basename(repoPath);

    try {
      // Load the latest report
      const metaPath = join(auditDir, 'repos', repoName, 'meta.json');
      const meta = JSON.parse(await readFile(metaPath, 'utf-8'));

      if (!meta.lastSnapshot) {
        console.error('\n  ❌ No scan results found. Run `comply scan` first.\n');
        process.exit(1);
      }

      const reportPath = join(auditDir, 'repos', repoName, 'snapshots', meta.lastSnapshot, 'report.json');
      const report = JSON.parse(await readFile(reportPath, 'utf-8'));

      const content = generateNoticesFile(repoName, report.evaluations, {
        format: options.format,
        includeAll: !!options.all,
      });

      if (options.save) {
        const savePath = resolve(options.save);
        await saveNoticesFile(content, savePath);
        console.log(`\n  ✅ NOTICES file saved to ${savePath}\n`);
      } else {
        console.log(content);
      }
    } catch (err) {
      console.error(`\n  ❌ Error: ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

// ============================================================================
// eval — Run the AI eval harness against ground truth
// ============================================================================
program
  .command('eval')
  .description('Evaluate AI agent accuracy against ground truth dataset')
  .option('--agent <name>', 'Test a specific agent (default: all)')
  .option('--model <id>', 'Override model for testing')
  .option('--ai-provider <name>', 'AI provider: openrouter or anthropic')
  .option('--ai-key <key>', 'AI API key')
  .option('--eval-dir <path>', 'Path to eval directory', 'eval')
  .option('--prompts-dir <path>', 'Custom prompts directory')
  .option('-v, --verbose', 'Show per-case results')
  .action(async (options: any) => {
    const { runEval, formatScorecard } = await import('../ai/eval.js');
    const { createProvider } = await import('../ai/provider.js');

    console.log('\n  🧪 Comply OSS — AI Eval Harness\n');

    try {
      const provider = createProvider({
        provider: options.aiProvider,
        apiKey: options.aiKey,
      });

      const result = await runEval({
        provider,
        evalDir: resolve(options.evalDir),
        promptsDir: options.promptsDir ? resolve(options.promptsDir) : undefined,
        agentFilter: options.agent,
        modelOverride: options.model,
        verbose: !!options.verbose,
      });

      console.log('');
      console.log(formatScorecard(result));
      console.log(`  Results saved to: eval/results/${result.runId}.json\n`);
    } catch (err) {
      console.error(`\n  ❌ Error: ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

// ============================================================================
// mcp — Start MCP server for AI assistant integration
// ============================================================================
program
  .command('mcp')
  .description('Start MCP server for AI assistant integration (Claude Code, Cursor, etc.)')
  .action(async () => {
    const { startMcpServer } = await import('./mcp-server.js');
    await startMcpServer();
  });

// ============================================================================
// fix — Auto-resolve obvious compliance issues
// ============================================================================
program
  .command('fix')
  .description('Auto-resolve obvious compliance issues and update policy/overrides')
  .argument('[path]', 'Path to the repository', '.')
  .option('-o, --output <dir>', 'Audit state directory', '.comply')
  .option('-p, --policy <file>', 'Path to policy YAML file')
  .option('--dry-run', 'Show what would be fixed without writing files')
  .action(async (path: string, options: any) => {
    const repoPath = resolve(path);
    const auditDir = resolve(options.output);

    console.log('\n  🔧 Comply OSS — Auto-Fix\n');

    try {
      // Run a fresh scan to get current evaluations
      const config = {
        repoPath,
        auditDir,
        policyPath: options.policy ? resolve(options.policy) : undefined,
        enableAIAnalysis: false,
        diffOnly: false,
        verbose: false,
      };

      const result = await runPipeline(config);
      const { loadPolicy } = await import('../pipeline/policy.js');
      const policy = await loadPolicy(config.policyPath);
      const { generateFixes, formatFixSummary, serializePolicy } = await import('../pipeline/fix.js');

      const fixResult = generateFixes(result.evaluations ?? [], policy);

      console.log(formatFixSummary(fixResult));

      if (fixResult.fixes.length > 0 && !options.dryRun) {
        const { writeFile } = await import('node:fs/promises');

        // Write updated policy
        const policyPath = config.policyPath || resolve('comply-policy.yaml');
        const policyYaml = serializePolicy(fixResult.updatedPolicy);
        await writeFile(policyPath, policyYaml);
        console.log(`\n  ✅ Policy updated: ${policyPath}`);

        // Re-scan to show updated results
        console.log('  Re-scanning with updated policy...\n');
        const reResult = await runPipeline({ ...config, policyPath });
        const s = reResult.summary;
        console.log(`  Risk: ${s.riskScore}/100 | Compliant: ${s.compliant}/${s.total} | Review: ${s.needsReview}`);
      } else if (options.dryRun && fixResult.fixes.length > 0) {
        console.log('\n  (dry run — no files modified)');
      }

      console.log('');
    } catch (err) {
      console.error(`\n  ❌ Error: ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

// ============================================================================
// Helpers
// ============================================================================

function determineCIFailure(
  result: Awaited<ReturnType<typeof runPipeline>>,
  failOn: string
): boolean {
  const s = result.summary;
  const annotations = result.ciAnnotations || [];

  switch (failOn) {
    case 'any':
      return s.nonCompliant > 0;
    case 'critical':
      return annotations.some(a => a.severity === 'critical' && a.level === 'error');
    case 'high':
      return annotations.some(a =>
        (a.severity === 'critical' || a.severity === 'high') && a.level === 'error'
      );
    case 'new':
      // Only fail on new violations (not pre-existing ones)
      return (result.diff?.summary.newViolations || 0) > 0;
    default:
      return s.nonCompliant > 0;
  }
}

/**
 * Ensure .comply/ is in .gitignore so audit data doesn't get committed.
 * Creates .gitignore if it doesn't exist. Idempotent.
 */
async function ensureGitignore(auditDir: string): Promise<void> {
  // The .comply/ folder lives inside the auditDir's parent.
  // Add it to the gitignore of that directory (typically the scanned repo when run in-place).
  const { dirname, basename: baseName } = await import('node:path');
  const parentDir = dirname(resolve(auditDir));
  const folderName = baseName(resolve(auditDir));
  const gitignorePath = join(parentDir, '.gitignore');

  try {
    let content: string;
    try {
      content = await readFile(gitignorePath, 'utf-8');
    } catch {
      content = '';
    }

    // Check if the audit folder is already ignored
    const lines = content.split('\n');
    const alreadyIgnored = lines.some(line => {
      const trimmed = line.trim();
      return trimmed === folderName || trimmed === `${folderName}/` || trimmed === `${folderName}/**`;
    });

    if (!alreadyIgnored) {
      const suffix = content.endsWith('\n') || content === '' ? '' : '\n';
      const block = `${suffix}\n# Comply OSS audit data (reports, snapshots, cache)\n${folderName}/\n`;
      await writeFile(gitignorePath, content + block);
      console.log(`  📝 Added ${folderName}/ to .gitignore`);
    }
  } catch {
    // Non-fatal — user may not have write access or may not be in a git repo
  }
}

program.parse();

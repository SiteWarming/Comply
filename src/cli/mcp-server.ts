#!/usr/bin/env node
// ============================================================================
// Comply OSS — MCP Server
// ============================================================================
//
// Exposes Comply's compliance scanning as MCP tools so AI coding assistants
// (Claude Code, Cursor, etc.) can invoke them directly without API keys.
//
// Usage:
//   npx tsx src/mcp-server.ts
//   node dist/mcp-server.js
//
// Add to .mcp.json:
//   { "comply": { "command": "npx", "args": ["comply-oss", "mcp"] } }
// ============================================================================

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolve, basename } from 'node:path';
import { runPipeline } from '../pipeline/pipeline.js';
import { loadPolicy } from '../pipeline/policy.js';
import { buildAssistantReport } from '../output/assistant-report.js';
import { loadLatestSnapshot } from '../state/state.js';
import { classifyLicense } from '../state/spdx.js';
import type { ComplyConfig, Ecosystem } from '../types.js';

const VERSION = '0.1.0';

const server = new McpServer({
  name: 'comply-oss',
  version: VERSION,
});

// ============================================================================
// Tool: comply_scan
// ============================================================================
server.tool(
  'comply_scan',
  'Scan a repository for open source license compliance. Returns structured data about all dependencies, their licenses, policy evaluations, and flagged packages that need attention. Use this to understand the compliance posture of a codebase.',
  {
    path: z.string().optional().describe('Path to the repository to scan (default: current directory)'),
    policy: z.string().optional().describe('Path to a comply-policy.yaml file'),
    ecosystems: z.array(z.string()).optional().describe('Filter to specific ecosystems: npm, python, go, rust'),
  },
  async ({ path, policy, ecosystems }) => {
    try {
      const repoPath = resolve(path ?? '.');
      const auditDir = resolve(repoPath, '.comply');

      const config: ComplyConfig = {
        repoPath,
        auditDir,
        policyPath: policy ? resolve(policy) : undefined,
        enableAIAnalysis: false,
        ecosystems: ecosystems as Ecosystem[] | undefined,
        diffOnly: false,
        verbose: false,
      };

      const result = await runPipeline(config);

      const policyData = await loadPolicy(config.policyPath);
      const distributionModel = policyData.distributionModel?.default ?? 'saas';

      const report = await buildAssistantReport({
        repoPath,
        distributionModel,
        ecosystems: result.ecosystems ?? [],
        evaluations: result.evaluations ?? [],
        healthData: result.healthData,
        vulnData: result.vulnData,
        riskScore: result.summary.riskScore,
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(report, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Scan failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ============================================================================
// Tool: comply_explain_license
// ============================================================================
server.tool(
  'comply_explain_license',
  'Explain what a specific SPDX license means for compliance. Returns the license tier, whether it has copyleft obligations, attribution requirements, and how it interacts with different distribution models (SaaS, distributed, internal, library).',
  {
    license: z.string().describe('SPDX license identifier (e.g., MIT, GPL-3.0, AGPL-3.0-only, Apache-2.0)'),
    distributionModel: z.enum(['saas', 'distributed', 'internal', 'library', 'cli']).optional()
      .describe('How the software is distributed (affects whether obligations trigger)'),
  },
  async ({ license, distributionModel }) => {
    const info = classifyLicense(license);

    const obligations: string[] = [];

    if (info.requiresAttribution) {
      obligations.push('Attribution: Must include license text and copyright notice in distributions');
    }
    if (info.requiresSourceDisclosure) {
      obligations.push('Source Disclosure: Must make source code available to recipients');
    }
    if (info.copyleft && !info.networkCopyleft) {
      obligations.push('Copyleft: Derivative works must be licensed under the same terms');
    }
    if (info.networkCopyleft) {
      obligations.push('Network Copyleft (AGPL): Source must be provided even for network/SaaS use');
    }

    const explanation = {
      spdxId: info.spdxId,
      name: info.name,
      tier: info.tier,
      copyleft: info.copyleft,
      networkCopyleft: info.networkCopyleft,
      requiresAttribution: info.requiresAttribution,
      requiresSourceDisclosure: info.requiresSourceDisclosure,
      obligations,
      distributionAnalysis: distributionModel
        ? analyzeObligationTriggers(info, distributionModel)
        : undefined,
    };

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(explanation, null, 2),
      }],
    };
  },
);

// ============================================================================
// Tool: comply_diff
// ============================================================================
server.tool(
  'comply_diff',
  'Show compliance changes since the last scan. Identifies new dependencies, removed dependencies, license changes, and new/resolved violations. Useful for reviewing what changed in a PR or after dependency updates.',
  {
    path: z.string().optional().describe('Path to the repository (default: current directory)'),
    auditDir: z.string().optional().describe('Path to the .comply directory (default: .comply)'),
  },
  async ({ path, auditDir: auditDirOpt }) => {
    try {
      const repoPath = resolve(path ?? '.');
      const auditDir = auditDirOpt ? resolve(auditDirOpt) : resolve(repoPath, '.comply');
      const repoName = basename(repoPath);

      const snapshot = await loadLatestSnapshot(auditDir, repoName);
      if (!snapshot) {
        return {
          content: [{
            type: 'text' as const,
            text: 'No previous scan found. Run comply_scan first to establish a baseline.',
          }],
        };
      }

      const config: ComplyConfig = {
        repoPath,
        auditDir,
        enableAIAnalysis: false,
        diffOnly: false,
        verbose: false,
      };

      const result = await runPipeline(config);

      if (result.diff) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              from: result.diff.fromSnapshot,
              to: result.diff.toSnapshot,
              summary: result.diff.summary,
              changes: result.diff.entries,
            }, null, 2),
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: 'No changes detected since last scan.',
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Diff failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ============================================================================
// Tool: comply_policy
// ============================================================================
server.tool(
  'comply_policy',
  'Show the current compliance policy configuration. Returns the distribution model, license rules (allow/deny/review), severity levels, and any allowlisted or denylisted packages.',
  {
    policyPath: z.string().optional().describe('Path to comply-policy.yaml (default: auto-detect)'),
  },
  async ({ policyPath }) => {
    try {
      const policy = await loadPolicy(policyPath ? resolve(policyPath) : undefined);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(policy, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to load policy: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ============================================================================
// Helpers
// ============================================================================

function analyzeObligationTriggers(
  license: { copyleft: boolean; networkCopyleft: boolean; requiresAttribution: boolean; requiresSourceDisclosure: boolean; tier: string },
  distributionModel: string,
): string {
  const lines: string[] = [];

  if (license.tier === 'permissive') {
    lines.push('- This is a permissive license. No copyleft obligations in any distribution model.');
    if (license.requiresAttribution) {
      lines.push('- Attribution required: include license text in NOTICES file.');
    }
    return lines.join('\n');
  }

  switch (distributionModel) {
    case 'saas':
      if (license.networkCopyleft) {
        lines.push('- TRIGGERS: AGPL/network copyleft applies to SaaS. Source disclosure required for network-accessible services.');
      } else if (license.copyleft) {
        lines.push('- DOES NOT TRIGGER: Standard copyleft (GPL/LGPL) does not trigger for SaaS — no distribution occurs.');
      }
      break;

    case 'distributed':
      if (license.copyleft || license.networkCopyleft) {
        lines.push('- TRIGGERS: Copyleft triggers when distributing to end users. Must provide source code.');
      }
      break;

    case 'internal':
      lines.push('- DOES NOT TRIGGER: Internal use almost never triggers copyleft obligations.');
      break;

    case 'library':
      if (license.tier === 'weak_copyleft') {
        lines.push('- CONDITIONAL: Weak copyleft (LGPL) allows dynamic linking without copyleft. Static linking triggers.');
      } else if (license.copyleft) {
        lines.push('- TRIGGERS: Strong copyleft applies to libraries when distributed.');
      }
      break;

    case 'cli':
      if (license.copyleft || license.networkCopyleft) {
        lines.push('- TRIGGERS: CLI tools are distributed to users. Copyleft obligations apply.');
      }
      break;
  }

  if (license.requiresAttribution) {
    lines.push('- Attribution always required regardless of distribution model.');
  }

  return lines.join('\n') || '- No specific obligations identified for this combination.';
}

// ============================================================================
// Start server
// ============================================================================

export async function startMcpServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run directly if executed as main module
const isMainModule = process.argv[1]?.endsWith('mcp-server.ts') ||
  process.argv[1]?.endsWith('mcp-server.js');

if (isMainModule) {
  startMcpServer().catch((err) => {
    console.error('MCP server failed to start:', err);
    process.exit(1);
  });
}

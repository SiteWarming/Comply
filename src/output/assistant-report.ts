// ============================================================================
// Assistant Report — Structured output optimized for AI assistant consumption
// ============================================================================
//
// When a developer runs `comply scan --for-assistant`, this module produces
// a JSON document containing everything an AI coding assistant needs to reason
// about license obligations — without needing API keys or the AI subsystem.
//
// The developer's AI assistant (Claude Code, Cursor, etc.) IS the AI layer.
// ============================================================================

import type {
  PolicyEvaluation, DistributionModel, Ecosystem, LicenseTier,
  ComplianceStatus, Severity,
} from '../types.js';
import type { DependencyHealth } from '../pipeline/health.js';
import { findUsageLocations, extractCodeSnippets } from '../pipeline/analysis.js';

export interface AssistantReport {
  meta: {
    tool: 'comply-oss';
    version: string;
    scanDate: string;
    repoPath: string;
    distributionModel: DistributionModel;
    ecosystems: Ecosystem[];
  };

  summary: {
    totalDependencies: number;
    compliant: number;
    nonCompliant: number;
    needsReview: number;
    conditionallyCompliant: number;
    riskScore: number;
  };

  /** Only packages that need AI reasoning — not the full list */
  flagged: FlaggedPackage[];

  /** Pre-written prompt telling the AI what to analyze */
  analysisPrompt: string;
}

export interface FlaggedPackage {
  name: string;
  version: string;
  ecosystem: Ecosystem;
  isDirect: boolean;
  source: string;

  license: {
    spdxId: string | null;
    tier: LicenseTier;
    copyleft: boolean;
    networkCopyleft: boolean;
    requiresAttribution: boolean;
    requiresSourceDisclosure: boolean;
  };

  policy: {
    status: ComplianceStatus;
    severity: Severity;
    matchedRule: string;
    reason: string;
    conditions?: string[];
  };

  health?: {
    isDeprecated: boolean;
    maintenanceRisk: string;
    licenseChanged: boolean;
    latestLicense?: string;
  };

  usage: {
    locations: string[];
    codeSnippets: CodeSnippet[];
    importCount: number;
  };
}

export interface CodeSnippet {
  file: string;
  line: number;
  code: string;
}

/**
 * Build an assistant report from pipeline results.
 * Gathers code snippets for flagged packages so the AI has full context.
 */
export async function buildAssistantReport(opts: {
  repoPath: string;
  distributionModel: DistributionModel;
  ecosystems: Ecosystem[];
  evaluations: PolicyEvaluation[];
  healthData?: DependencyHealth[];
  riskScore: number;
  includeSnippets?: boolean;
}): Promise<AssistantReport> {
  const { evaluations, healthData, includeSnippets = true } = opts;

  const flaggedEvals = evaluations.filter(e =>
    e.status === 'non_compliant' ||
    e.status === 'conditionally_compliant' ||
    e.status === 'needs_review'
  );

  const flagged: FlaggedPackage[] = [];

  for (const evaluation of flaggedEvals) {
    const dep = evaluation.dependency;
    const lic = evaluation.license.license;

    // Find health data for this package
    const health = healthData?.find(h => h.name === dep.name && h.version === dep.version);

    // Gather usage context
    let locations: string[] = [];
    let snippets: CodeSnippet[] = [];

    if (includeSnippets) {
      locations = await findUsageLocations(dep.name, opts.repoPath, dep.ecosystem);
      const rawSnippets = await extractCodeSnippets(locations, dep.name);

      snippets = rawSnippets.map(snippet => {
        const headerMatch = snippet.match(/^--- (.+) \(line (\d+)\) ---/);
        return {
          file: headerMatch?.[1]?.replace(opts.repoPath + '/', '') ?? 'unknown',
          line: parseInt(headerMatch?.[2] ?? '0', 10),
          code: snippet,
        };
      });

      // Make locations relative
      locations = locations.map(l => l.replace(opts.repoPath + '/', ''));
    }

    flagged.push({
      name: dep.name,
      version: dep.version,
      ecosystem: dep.ecosystem,
      isDirect: dep.isDirect,
      source: dep.source,
      license: {
        spdxId: lic.spdxId,
        tier: lic.tier,
        copyleft: lic.copyleft,
        networkCopyleft: lic.networkCopyleft,
        requiresAttribution: lic.requiresAttribution,
        requiresSourceDisclosure: lic.requiresSourceDisclosure,
      },
      policy: {
        status: evaluation.status,
        severity: evaluation.severity,
        matchedRule: evaluation.matchedRule,
        reason: evaluation.reason,
      },
      health: health ? {
        isDeprecated: health.isDeprecated,
        maintenanceRisk: health.maintenanceRisk,
        licenseChanged: health.licenseChanged,
        latestLicense: health.latestLicense ?? undefined,
      } : undefined,
      usage: {
        locations,
        codeSnippets: snippets,
        importCount: locations.length,
      },
    });
  }

  const statusCounts = {
    compliant: evaluations.filter(e => e.status === 'compliant').length,
    nonCompliant: evaluations.filter(e => e.status === 'non_compliant').length,
    needsReview: evaluations.filter(e => e.status === 'needs_review').length,
    conditionallyCompliant: evaluations.filter(e => e.status === 'conditionally_compliant').length,
  };

  return {
    meta: {
      tool: 'comply-oss',
      version: '0.1.0',
      scanDate: new Date().toISOString(),
      repoPath: opts.repoPath,
      distributionModel: opts.distributionModel,
      ecosystems: opts.ecosystems,
    },
    summary: {
      totalDependencies: evaluations.length,
      ...statusCounts,
      riskScore: opts.riskScore,
    },
    flagged,
    analysisPrompt: buildAnalysisPrompt(opts.distributionModel),
  };
}

function buildAnalysisPrompt(distributionModel: DistributionModel): string {
  return `You are analyzing a license compliance scan for a "${distributionModel}" software project. For each flagged package in the "flagged" array:

1. **Classification**: Is this package actually used at runtime, or is it dev-only/test-only/build-tool? Check the code snippets and manifest source for evidence.

2. **Obligation Analysis**: Given the usage patterns in the code snippets, does this license's copyleft obligation actually trigger under the "${distributionModel}" distribution model?
   - SaaS: GPL does NOT trigger (no distribution). AGPL DOES trigger (network use counts).
   - Distributed: GPL triggers when shipping to end users.
   - Internal: Almost nothing triggers.
   - Library: LGPL allows dynamic linking without copyleft.

3. **Action Required**: For each package, recommend one of:
   - SAFE: No action needed (obligations don't trigger for this usage)
   - NOTICE: Add attribution to NOTICES file
   - REVIEW: Needs human/legal review (explain why)
   - REPLACE: Find an alternative (suggest specific packages)
   - REFACTOR: Change how the package is used (e.g., switch from static to dynamic linking)

Focus on what actually matters, not theoretical risk. "GPL detected" is meaningless without context — what matters is whether YOUR specific usage triggers obligations.`;
}

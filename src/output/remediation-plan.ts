// ============================================================================
// Remediation Plan — Generate prioritized action items from scan findings
// ============================================================================
//
// Every scan should produce a clear "what to do next" section, even without AI.
// This module analyzes evaluations + health data and produces a structured,
// prioritized remediation plan that renders into the Markdown report.
// ============================================================================

import type { PolicyEvaluation, RemediationStep } from '../types.js';
import type { DependencyHealth } from '../pipeline/health.js';

// ---- Public Types ----

export type ActionPriority = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface RemediationAction {
  priority: ActionPriority;
  category: 'violation' | 'license_review' | 'deprecated' | 'license_drift' | 'abandoned';
  package: string;
  version: string;
  isDirect: boolean;
  summary: string;
  details: string[];
  effort: 'trivial' | 'low' | 'medium' | 'high';
}

export interface RemediationPlan {
  actions: RemediationAction[];
  stats: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
    totalEffort: string;
  };
}

// ---- Plan Generation ----

export function generateRemediationPlan(
  evaluations: PolicyEvaluation[],
  healthData?: DependencyHealth[]
): RemediationPlan {
  const actions: RemediationAction[] = [];

  // Priority 1: Non-compliant packages (violations)
  actions.push(...generateViolationActions(evaluations));

  // Priority 2: Needs-review packages (unknown/unresolvable licenses)
  actions.push(...generateReviewActions(evaluations));

  // Priority 3: Deprecated packages
  if (healthData) {
    actions.push(...generateDeprecatedActions(healthData, evaluations));
  }

  // Priority 4: License drift (only flag restrictive changes)
  if (healthData) {
    actions.push(...generateLicenseDriftActions(healthData));
  }

  // Priority 5: Abandoned direct dependencies
  if (healthData) {
    actions.push(...generateAbandonedActions(healthData, evaluations));
  }

  // Sort by priority
  const priorityOrder: Record<ActionPriority, number> = {
    critical: 0, high: 1, medium: 2, low: 3, info: 4,
  };
  actions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  return {
    actions,
    stats: computeStats(actions),
  };
}

// ---- Category Generators ----

function generateViolationActions(evaluations: PolicyEvaluation[]): RemediationAction[] {
  return evaluations
    .filter(e => e.status === 'non_compliant')
    .map(e => {
      const details: string[] = [];
      details.push(`License: ${e.license.license.spdxId || e.license.rawLicense || 'Unknown'}`);
      details.push(`Reason: ${e.reason}`);

      if (e.remediation && e.remediation.length > 0) {
        for (const r of e.remediation) {
          details.push(`${capitalize(r.action)}: ${r.description}`);
        }
      }

      if (e.usageAnalysis) {
        details.push(`Usage context: ${e.usageAnalysis.reasoning}`);
      }

      const effort = getMaxEffort(e.remediation);
      const priority = severityToPriority(e.severity);

      return {
        priority,
        category: 'violation' as const,
        package: e.dependency.name,
        version: e.dependency.version,
        isDirect: e.dependency.isDirect,
        summary: `Non-compliant license (${e.license.license.spdxId || e.license.rawLicense || 'Unknown'}) — ${e.reason}`,
        details,
        effort,
      };
    });
}

function generateReviewActions(evaluations: PolicyEvaluation[]): RemediationAction[] {
  return evaluations
    .filter(e => e.status === 'needs_review')
    .map(e => {
      const raw = e.license.rawLicense || '';
      const details: string[] = [];
      let summary: string;
      let effort: RemediationAction['effort'] = 'low';

      if (!raw || raw === 'UNKNOWN' || raw === '') {
        // No license metadata at all
        summary = 'No license metadata found — manual review required';
        details.push('This package has no license information in the registry.');
        details.push('Check the package source repository for a LICENSE file.');
        details.push('If licensed, add a `comply-overrides.yaml` entry to record the license.');
        details.push('If unlicensed, consider replacing with a licensed alternative.');
      } else if (raw.toUpperCase().startsWith('SEE LICENSE')) {
        // File reference license
        summary = `License declared via file reference ("${raw}") — verify and override`;
        details.push('The registry points to a LICENSE file instead of declaring the SPDX ID.');
        details.push('This is usually a standard permissive license (MIT, Apache-2.0, BSD).');
        details.push(`Check the package's LICENSE file and add a \`comply-overrides.yaml\` entry.`);
        effort = 'trivial';
      } else if (raw.includes(' OR ') || raw.includes(' AND ')) {
        // Complex SPDX expression that couldn't be resolved
        summary = `Complex license expression ("${raw}") — verify interpretation`;
        details.push(`The license expression "${raw}" could not be fully classified.`);
        details.push('Review the expression and add a `comply-overrides.yaml` entry with the applicable license.');
      } else {
        // Custom or unrecognized license string
        summary = `Unrecognized license "${raw}" — verify compliance`;
        details.push(`The license string "${raw}" is not a recognized SPDX identifier.`);
        details.push('Check the package source for the actual license terms.');
        details.push('Add a `comply-overrides.yaml` entry mapping to the correct SPDX ID.');
      }

      return {
        priority: e.dependency.isDirect ? 'high' as const : 'medium' as const,
        category: 'license_review' as const,
        package: e.dependency.name,
        version: e.dependency.version,
        isDirect: e.dependency.isDirect,
        summary,
        details,
        effort,
      };
    });
}

function generateDeprecatedActions(
  healthData: DependencyHealth[],
  evaluations: PolicyEvaluation[]
): RemediationAction[] {
  const evalMap = new Map(evaluations.map(e => [`${e.dependency.name}@${e.dependency.version}`, e]));

  return healthData
    .filter(h => h.isDeprecated)
    .map(h => {
      const eval_ = evalMap.get(`${h.name}@${h.version}`);
      const isDirect = eval_?.dependency.isDirect ?? false;
      const details: string[] = [];

      if (h.deprecationMessage) {
        details.push(`Registry message: ${h.deprecationMessage}`);
      }

      // Try to extract migration target from deprecation message
      const migrationTarget = extractMigrationTarget(h.deprecationMessage);
      if (migrationTarget) {
        details.push(`Suggested replacement: ${migrationTarget}`);
      }

      if (!isDirect) {
        details.push('This is a transitive dependency — updating the parent package may resolve this.');
      }

      return {
        priority: isDirect ? 'medium' as const : 'low' as const,
        category: 'deprecated' as const,
        package: h.name,
        version: h.version,
        isDirect,
        summary: `Deprecated — ${h.deprecationMessage ? truncate(h.deprecationMessage, 120) : 'no longer maintained'}`,
        details,
        effort: isDirect ? 'medium' as const : 'low' as const,
      };
    });
}

function generateLicenseDriftActions(healthData: DependencyHealth[]): RemediationAction[] {
  // Only flag license changes that move toward MORE restrictive licenses
  const MORE_RESTRICTIVE_TIERS = new Set(['strong_copyleft', 'network_copyleft', 'non_commercial', 'proprietary']);

  return healthData
    .filter(h => h.licenseChanged && h.latestLicense)
    .filter(h => {
      // BlueOak-1.0.0 is permissive — not a concern
      // ISC → MIT is fine
      // We only flag if the new license COULD be more restrictive
      const latest = h.latestLicense!.toUpperCase();
      // If moving to a known permissive license, skip
      const PERMISSIVE = ['MIT', 'ISC', 'BSD-2-CLAUSE', 'BSD-3-CLAUSE', 'APACHE-2.0', 'BLUEOAK-1.0.0', '0BSD', 'UNLICENSE'];
      return !PERMISSIVE.includes(latest);
    })
    .map(h => ({
      priority: 'info' as const,
      category: 'license_drift' as const,
      package: h.name,
      version: h.version,
      isDirect: false,
      summary: `License changed to "${h.latestLicense}" in v${h.latestVersion} — review before upgrading`,
      details: [
        `Installed version has a different license than latest (v${h.latestVersion}): ${h.latestLicense}`,
        'Review the new license terms before bumping to the latest version.',
      ],
      effort: 'trivial' as const,
    }));
}

function generateAbandonedActions(
  healthData: DependencyHealth[],
  evaluations: PolicyEvaluation[]
): RemediationAction[] {
  const evalMap = new Map(evaluations.map(e => [`${e.dependency.name}@${e.dependency.version}`, e]));

  // Only flag direct abandoned dependencies — transitive ones are noise
  return healthData
    .filter(h => {
      const eval_ = evalMap.get(`${h.name}@${h.version}`);
      const isDirect = eval_?.dependency.isDirect ?? false;
      return isDirect && h.maintenanceRisk === 'abandoned' && !h.isDeprecated; // deprecated already covered
    })
    .map(h => {
      const years = h.daysSinceLastPublish
        ? Math.floor(h.daysSinceLastPublish / 365)
        : null;

      return {
        priority: 'low' as const,
        category: 'abandoned' as const,
        package: h.name,
        version: h.version,
        isDirect: true,
        summary: `Not updated in ${years ?? '3+'} years — consider alternatives`,
        details: [
          `Last published ${years ?? '3+'} year(s) ago.`,
          'Check if the package still meets your needs or if actively maintained alternatives exist.',
        ],
        effort: 'medium' as const,
      };
    });
}

// ---- Markdown Rendering ----

export function renderRemediationPlan(plan: RemediationPlan): string {
  if (plan.actions.length === 0) return '';

  const lines: string[] = [];

  lines.push(`## 🔧 Remediation Plan`);
  lines.push('');

  // Summary bar
  const { stats } = plan;
  const parts: string[] = [];
  if (stats.critical > 0) parts.push(`🔴 ${stats.critical} critical`);
  if (stats.high > 0) parts.push(`🟠 ${stats.high} high`);
  if (stats.medium > 0) parts.push(`🟡 ${stats.medium} medium`);
  if (stats.low > 0) parts.push(`🟢 ${stats.low} low`);
  if (stats.info > 0) parts.push(`ℹ️ ${stats.info} informational`);
  lines.push(`**${plan.actions.length} action${plan.actions.length > 1 ? 's' : ''}** — ${parts.join(' · ')} — estimated effort: ${stats.totalEffort}`);
  lines.push('');

  // Group by category for readability
  const categories: Array<{ key: RemediationAction['category']; title: string; icon: string }> = [
    { key: 'violation', title: 'License Violations', icon: '❌' },
    { key: 'license_review', title: 'License Review Required', icon: '⚠️' },
    { key: 'deprecated', title: 'Deprecated Packages', icon: '🚫' },
    { key: 'license_drift', title: 'License Drift Alerts', icon: '🔄' },
    { key: 'abandoned', title: 'Abandoned Dependencies', icon: '📦' },
  ];

  for (const cat of categories) {
    const catActions = plan.actions.filter(a => a.category === cat.key);
    if (catActions.length === 0) continue;

    lines.push(`### ${cat.icon} ${cat.title} (${catActions.length})`);
    lines.push('');

    for (const action of catActions) {
      const priorityIcon = priorityToIcon(action.priority);
      const directLabel = action.isDirect ? '**direct**' : 'transitive';
      lines.push(`${priorityIcon} **${action.package}@${action.version}** (${directLabel}, effort: ${action.effort})`);
      lines.push(`  ${action.summary}`);
      for (const detail of action.details) {
        lines.push(`  - ${detail}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ---- Helpers ----

function severityToPriority(severity: string): ActionPriority {
  switch (severity) {
    case 'critical': return 'critical';
    case 'high': return 'high';
    case 'medium': return 'medium';
    case 'low': return 'low';
    default: return 'medium';
  }
}

function priorityToIcon(priority: ActionPriority): string {
  switch (priority) {
    case 'critical': return '🔴';
    case 'high': return '🟠';
    case 'medium': return '🟡';
    case 'low': return '🟢';
    case 'info': return 'ℹ️';
  }
}

function getMaxEffort(remediation?: RemediationStep[]): RemediationAction['effort'] {
  if (!remediation || remediation.length === 0) return 'medium';
  const order: Record<string, number> = { trivial: 0, low: 1, medium: 2, high: 3 };
  let max = 0;
  for (const r of remediation) {
    max = Math.max(max, order[r.effort] ?? 2);
  }
  return (['trivial', 'low', 'medium', 'high'] as const)[max];
}

function extractMigrationTarget(message: string | null): string | null {
  if (!message) return null;

  // Common patterns: "Please use X instead", "Use X instead", "replaced by X"
  const patterns = [
    /(?:please |)use\s+([^\s.]+(?:\s+[^\s.]+)?)\s+instead/i,
    /replaced\s+by\s+([^\s.]+)/i,
    /please\s+(?:update|upgrade)\s+to\s+([^\s.]+)/i,
    /update\s+to\s+([^\s.]+(?:@[^\s.]+)?)/i,
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match) return match[1];
  }

  return null;
}

function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + '…';
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');
}

function computeStats(actions: RemediationAction[]): RemediationPlan['stats'] {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const effortWeights: Record<string, number> = { trivial: 0.25, low: 0.5, medium: 1, high: 2 };
  let totalHours = 0;

  for (const action of actions) {
    counts[action.priority]++;
    totalHours += effortWeights[action.effort] ?? 1;
  }

  let totalEffort: string;
  if (totalHours <= 1) totalEffort = '< 1 hour';
  else if (totalHours <= 4) totalEffort = '1–4 hours';
  else if (totalHours <= 8) totalEffort = '4–8 hours (half day)';
  else if (totalHours <= 16) totalEffort = '1–2 days';
  else totalEffort = `${Math.ceil(totalHours / 8)}+ days`;

  return { ...counts, totalEffort };
}

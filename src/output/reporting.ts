// ============================================================================
// Reporting — Generate Markdown and JSON compliance reports
// ============================================================================

import { writeFile, mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { generateExecutiveSummary } from './executive-summary.js';
import type {
  AuditReport, PolicyEvaluation, ResolvedLicense, Dependency,
  Ecosystem, LicenseTier, ComplianceStatus, Severity, SnapshotDiff,
} from '../types.js';

/**
 * Build an AuditReport from evaluation results.
 */
export function buildReport(
  repoPath: string,
  ecosystems: Ecosystem[],
  dependencies: Dependency[],
  evaluations: PolicyEvaluation[],
  duration: number
): AuditReport {
  const directDeps = dependencies.filter(d => d.isDirect).length;

  const statusCounts = {
    compliant: 0,
    non_compliant: 0,
    needs_review: 0,
    conditionally_compliant: 0,
  };
  for (const e of evaluations) {
    statusCounts[e.status]++;
  }

  // License distribution
  const licenseDistribution: Record<string, number> = {};
  const tierDistribution: Record<LicenseTier, number> = {
    permissive: 0, weak_copyleft: 0, strong_copyleft: 0,
    network_copyleft: 0, non_commercial: 0, proprietary: 0, unknown: 0,
  };

  for (const e of evaluations) {
    const spdx = e.license.license.spdxId || 'Unknown';
    licenseDistribution[spdx] = (licenseDistribution[spdx] || 0) + 1;
    tierDistribution[e.license.license.tier]++;
  }

  // Risk score: 0 = clean, 100 = critical
  const riskScore = calculateRiskScore(evaluations);

  const report: AuditReport = {
    metadata: {
      repoPath,
      repoName: basename(repoPath),
      timestamp: new Date().toISOString(),
      duration,
      complyVersion: '0.1.0',
      ecosystems,
    },
    summary: {
      totalDependencies: dependencies.length,
      directDependencies: directDeps,
      transitiveDependencies: dependencies.length - directDeps,
      compliant: statusCounts.compliant,
      nonCompliant: statusCounts.non_compliant,
      needsReview: statusCounts.needs_review,
      conditionallyCompliant: statusCounts.conditionally_compliant,
      riskScore,
    },
    executiveSummary: '', // Placeholder — generated below
    evaluations,
    licenseDistribution,
    tierDistribution,
  };

  // Generate executive summary from the complete report data
  report.executiveSummary = generateExecutiveSummary(report);

  return report;
}

/**
 * Render the report as Markdown.
 */
export function renderMarkdownReport(report: AuditReport, diff?: SnapshotDiff): string {
  const lines: string[] = [];
  const s = report.summary;
  const m = report.metadata;

  lines.push(`# OSS License Compliance Report`);
  lines.push('');
  lines.push(`**Repository:** ${m.repoName}`);
  lines.push(`**Path:** ${m.repoPath}`);
  lines.push(`**Date:** ${new Date(m.timestamp).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`);
  lines.push(`**Ecosystems:** ${m.ecosystems.join(', ')}`);
  lines.push(`**Scan Duration:** ${(m.duration / 1000).toFixed(1)}s`);
  lines.push('');

  // Risk indicator
  const riskLabel = s.riskScore === 0 ? '✅ CLEAN' :
    s.riskScore <= 20 ? '🟢 LOW RISK' :
    s.riskScore <= 50 ? '🟡 MODERATE RISK' :
    s.riskScore <= 80 ? '🟠 HIGH RISK' : '🔴 CRITICAL RISK';

  lines.push(`## Risk Score: ${s.riskScore}/100 — ${riskLabel}`);
  lines.push('');

  // Executive Summary — the 30-second read for non-technical stakeholders
  lines.push(`## Executive Summary`);
  lines.push('');
  lines.push(report.executiveSummary);
  lines.push('');

  // Summary table
  lines.push(`## Detailed Summary`);
  lines.push('');
  lines.push(`| Metric | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total Dependencies | ${s.totalDependencies} |`);
  lines.push(`| Direct Dependencies | ${s.directDependencies} |`);
  lines.push(`| Transitive Dependencies | ${s.transitiveDependencies} |`);
  lines.push(`| ✅ Compliant | ${s.compliant} |`);
  lines.push(`| ❌ Non-Compliant | ${s.nonCompliant} |`);
  lines.push(`| ⚠️ Needs Review | ${s.needsReview} |`);
  lines.push(`| 🔶 Conditionally Compliant | ${s.conditionallyCompliant} |`);
  lines.push('');

  // License tier breakdown
  lines.push(`## License Tier Distribution`);
  lines.push('');
  const td = report.tierDistribution;
  if (td.permissive) lines.push(`- **Permissive** (MIT, BSD, Apache, etc.): ${td.permissive}`);
  if (td.weak_copyleft) lines.push(`- **Weak Copyleft** (LGPL, MPL, EPL): ${td.weak_copyleft}`);
  if (td.strong_copyleft) lines.push(`- **Strong Copyleft** (GPL): ${td.strong_copyleft}`);
  if (td.network_copyleft) lines.push(`- **Network Copyleft** (AGPL, SSPL): ${td.network_copyleft}`);
  if (td.non_commercial) lines.push(`- **Non-Commercial** (CC-NC): ${td.non_commercial}`);
  if (td.proprietary) lines.push(`- **Proprietary/Restrictive**: ${td.proprietary}`);
  if (td.unknown) lines.push(`- **Unknown**: ${td.unknown}`);
  lines.push('');

  // Violations section (non-compliant)
  const violations = report.evaluations.filter(e => e.status === 'non_compliant');
  if (violations.length > 0) {
    lines.push(`## ❌ Violations (${violations.length})`);
    lines.push('');
    violations.sort((a, b) => severityOrder(a.severity) - severityOrder(b.severity));

    for (const v of violations) {
      lines.push(`### ${severityIcon(v.severity)} ${v.dependency.name}@${v.dependency.version}`);
      lines.push('');
      lines.push(`- **License:** ${v.license.license.spdxId || v.license.rawLicense}`);
      lines.push(`- **Severity:** ${v.severity.toUpperCase()}`);
      lines.push(`- **Reason:** ${v.reason}`);

      if (v.remediation && v.remediation.length > 0) {
        lines.push(`- **Remediation:**`);
        for (const r of v.remediation) {
          lines.push(`  - [${r.effort}] ${r.description}`);
        }
      }

      if (v.usageAnalysis) {
        lines.push(`- **Usage Analysis:** ${v.usageAnalysis.reasoning}`);
      }
      lines.push('');
    }
  }

  // Needs review section
  const reviews = report.evaluations.filter(e => e.status === 'needs_review');
  if (reviews.length > 0) {
    lines.push(`## ⚠️ Needs Review (${reviews.length})`);
    lines.push('');
    for (const r of reviews) {
      lines.push(`- **${r.dependency.name}@${r.dependency.version}** — ${r.license.license.spdxId || r.license.rawLicense || 'Unknown'}: ${r.reason}`);
    }
    lines.push('');
  }

  // Conditionally compliant section
  const conditional = report.evaluations.filter(e => e.status === 'conditionally_compliant');
  if (conditional.length > 0) {
    lines.push(`## 🔶 Conditionally Compliant (${conditional.length})`);
    lines.push('');
    for (const c of conditional) {
      lines.push(`- **${c.dependency.name}@${c.dependency.version}** — ${c.license.license.spdxId || c.license.rawLicense}: ${c.reason}`);
    }
    lines.push('');
  }

  // Diff section
  if (diff && diff.entries.length > 0) {
    lines.push(`## 📊 Changes Since Last Scan`);
    lines.push('');
    lines.push(`| Metric | Count |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Added | ${diff.summary.added} |`);
    lines.push(`| Removed | ${diff.summary.removed} |`);
    lines.push(`| Changed | ${diff.summary.changed} |`);
    lines.push(`| New Violations | ${diff.summary.newViolations} |`);
    lines.push(`| Resolved Violations | ${diff.summary.resolvedViolations} |`);
    lines.push('');

    if (diff.summary.newViolations > 0) {
      const newViols = diff.entries.filter(e =>
        (e.type === 'added' && e.after?.status === 'non_compliant') ||
        (e.type === 'status_changed' && e.after?.status === 'non_compliant')
      );
      lines.push(`### New Violations`);
      lines.push('');
      for (const v of newViols) {
        lines.push(`- **${v.dependency}**: ${v.after?.license || 'Unknown license'}`);
      }
      lines.push('');
    }
  }

  // Full compliant list (collapsed)
  const compliant = report.evaluations.filter(e => e.status === 'compliant');
  if (compliant.length > 0) {
    lines.push(`## ✅ Compliant Packages (${compliant.length})`);
    lines.push('');
    lines.push('<details>');
    lines.push('<summary>Click to expand full list</summary>');
    lines.push('');
    lines.push(`| Package | Version | License |`);
    lines.push(`|---------|---------|---------|`);
    for (const c of compliant) {
      lines.push(`| ${c.dependency.name} | ${c.dependency.version} | ${c.license.license.spdxId || c.license.rawLicense} |`);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  // Top licenses
  lines.push(`## License Distribution`);
  lines.push('');
  const sorted = Object.entries(report.licenseDistribution)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);
  lines.push(`| License | Count |`);
  lines.push(`|---------|-------|`);
  for (const [license, count] of sorted) {
    lines.push(`| ${license} | ${count} |`);
  }
  lines.push('');

  // Footer
  lines.push(`---`);
  lines.push(`*Generated by [Comply OSS](https://github.com/comply-oss/comply) v${m.complyVersion}*`);

  return lines.join('\n');
}

/**
 * Save the report as both Markdown and JSON.
 */
export async function saveReport(
  report: AuditReport,
  markdown: string,
  outputDir: string
): Promise<{ mdPath: string; jsonPath: string }> {
  await mkdir(outputDir, { recursive: true });

  const mdPath = join(outputDir, 'report.md');
  const jsonPath = join(outputDir, 'report.json');

  await writeFile(mdPath, markdown);
  await writeFile(jsonPath, JSON.stringify(report, null, 2));

  return { mdPath, jsonPath };
}

// ---- Utilities ----

function calculateRiskScore(evaluations: PolicyEvaluation[]): number {
  if (evaluations.length === 0) return 0;

  let rawScore = 0;
  for (const e of evaluations) {
    let weight = 0;

    switch (e.severity) {
      case 'critical':
        if (e.status === 'non_compliant') weight = 25;
        else if (e.status === 'needs_review') weight = 10;
        break;
      case 'high':
        if (e.status === 'non_compliant') weight = 15;
        else if (e.status === 'needs_review') weight = 5;
        break;
      case 'medium':
        if (e.status === 'non_compliant') weight = 5;
        else if (e.status === 'needs_review') weight = 1;
        // conditionally_compliant contributes 0 — matched a rule, not a violation
        break;
      case 'low':
        if (e.status === 'non_compliant') weight = 2;
        break;
    }

    if (weight === 0) continue;

    // Discount dev dependencies (90% off — rarely a real issue)
    const dep = e.dependency;
    if ((dep as any).isDev) {
      weight *= 0.1;
    }
    // Discount transitive deps (50% off — not a direct choice)
    else if (!dep.isDirect) {
      weight *= 0.5;
    }

    rawScore += weight;
  }

  // Normalize against total dep count so large repos aren't unfairly penalized
  const maxReasonable = Math.max(evaluations.length * 0.25, 1);
  const normalized = Math.round((rawScore / maxReasonable) * 100);

  return Math.min(100, normalized);
}

function severityOrder(s: Severity): number {
  const order: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, none: 4 };
  return order[s] ?? 5;
}

function severityIcon(s: Severity): string {
  const icons: Record<Severity, string> = {
    critical: '🔴',
    high: '🟠',
    medium: '🟡',
    low: '🟢',
    none: '✅',
  };
  return icons[s] ?? '❓';
}

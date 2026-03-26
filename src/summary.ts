// ============================================================================
// Summary — Multi-repo compliance roll-up for org-wide visibility
// ============================================================================
//
// When a PE firm or compliance team runs Comply across 15+ repos in an org,
// they need one combined view — not 15 separate reports. This module reads
// all repo snapshots from the .comply directory and produces a single
// org-wide dashboard: aggregate risk score, which repos have violations,
// sorted by severity, with an executive summary suitable for a diligence memo.
// ============================================================================

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { generateExecutiveSummary } from './executive-summary.js';
import type { AuditReport, Severity, ComplianceStatus, LicenseTier } from './types.js';

interface RepoSummary {
  name: string;
  lastRun: string;
  riskScore: number;
  totalDependencies: number;
  compliant: number;
  nonCompliant: number;
  needsReview: number;
  conditionallyCompliant: number;
  topViolations: Array<{
    package: string;
    license: string;
    severity: Severity;
  }>;
  ecosystems: string[];
}

export interface OrgSummary {
  metadata: {
    timestamp: string;
    auditDir: string;
    repoCount: number;
    complyVersion: string;
  };
  aggregate: {
    totalDependencies: number;
    totalUnique: number;
    compliant: number;
    nonCompliant: number;
    needsReview: number;
    conditionallyCompliant: number;
    aggregateRiskScore: number;
    cleanRepos: number;
    violatingRepos: number;
  };
  repos: RepoSummary[];
  /** Packages that appear in multiple repos — shared risk surface */
  crossRepoViolations: Array<{
    package: string;
    license: string;
    severity: Severity;
    repos: string[];
  }>;
  /** License distribution across all repos */
  orgLicenseDistribution: Record<string, number>;
  /** Tier distribution across all repos */
  orgTierDistribution: Record<LicenseTier, number>;
}

/**
 * Read all repo snapshots from the audit directory and produce an org-wide summary.
 */
export async function generateOrgSummary(auditDir: string): Promise<OrgSummary> {
  const reposDir = join(auditDir, 'repos');

  let repoDirs: string[];
  try {
    repoDirs = await readdir(reposDir);
  } catch {
    throw new Error(`No repos found in ${reposDir}. Run 'comply scan' on at least one repository first.`);
  }

  const repos: RepoSummary[] = [];
  const allReports: AuditReport[] = [];

  for (const repoName of repoDirs) {
    try {
      const report = await loadLatestReport(auditDir, repoName);
      if (report) {
        allReports.push(report);
        repos.push(extractRepoSummary(repoName, report));
      }
    } catch {
      // Skip repos with corrupt/missing data
    }
  }

  if (repos.length === 0) {
    throw new Error('No valid scan results found. Run `comply scan` first.');
  }

  // Sort repos: highest risk first
  repos.sort((a, b) => b.riskScore - a.riskScore);

  // Aggregate
  const aggregate = computeAggregate(repos);

  // Cross-repo violations: same package flagged in multiple repos
  const crossRepoViolations = findCrossRepoViolations(allReports);

  // Org-wide license distribution
  const orgLicenseDistribution: Record<string, number> = {};
  const orgTierDistribution: Record<LicenseTier, number> = {
    permissive: 0, weak_copyleft: 0, strong_copyleft: 0,
    network_copyleft: 0, non_commercial: 0, proprietary: 0, unknown: 0,
  };

  for (const report of allReports) {
    for (const [license, count] of Object.entries(report.licenseDistribution)) {
      orgLicenseDistribution[license] = (orgLicenseDistribution[license] || 0) + count;
    }
    for (const [tier, count] of Object.entries(report.tierDistribution)) {
      orgTierDistribution[tier as LicenseTier] += count;
    }
  }

  return {
    metadata: {
      timestamp: new Date().toISOString(),
      auditDir,
      repoCount: repos.length,
      complyVersion: '0.1.0',
    },
    aggregate,
    repos,
    crossRepoViolations,
    orgLicenseDistribution,
    orgTierDistribution,
  };
}

/**
 * Render the org summary as Markdown.
 */
export function renderOrgSummaryMarkdown(summary: OrgSummary): string {
  const lines: string[] = [];
  const a = summary.aggregate;
  const m = summary.metadata;

  const date = new Date(m.timestamp).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  lines.push(`# Organization License Compliance Summary`);
  lines.push('');
  lines.push(`**Date:** ${date}`);
  lines.push(`**Repositories Scanned:** ${m.repoCount}`);
  lines.push(`**Total Dependencies:** ${a.totalDependencies}`);
  lines.push('');

  // --- Org-level risk ---
  const riskLabel = a.aggregateRiskScore === 0 ? '✅ CLEAN' :
    a.aggregateRiskScore <= 20 ? '🟢 LOW RISK' :
    a.aggregateRiskScore <= 50 ? '🟡 MODERATE RISK' :
    a.aggregateRiskScore <= 80 ? '🟠 HIGH RISK' : '🔴 CRITICAL RISK';

  lines.push(`## Aggregate Risk: ${a.aggregateRiskScore}/100 — ${riskLabel}`);
  lines.push('');

  // --- Executive summary paragraph ---
  lines.push(`## Executive Summary`);
  lines.push('');
  lines.push(generateOrgExecutiveSummary(summary));
  lines.push('');

  // --- Repo-by-repo table ---
  lines.push(`## Repository Compliance Status`);
  lines.push('');
  lines.push(`| Repository | Risk | Dependencies | ✅ | ❌ | ⚠️ | Last Scanned |`);
  lines.push(`|------------|------|--------------|-----|-----|------|--------------|`);

  for (const repo of summary.repos) {
    const risk = repo.riskScore === 0 ? '✅ 0' :
      repo.riskScore <= 20 ? `🟢 ${repo.riskScore}` :
      repo.riskScore <= 50 ? `🟡 ${repo.riskScore}` :
      repo.riskScore <= 80 ? `🟠 ${repo.riskScore}` : `🔴 ${repo.riskScore}`;

    const lastRun = new Date(repo.lastRun).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    lines.push(`| ${repo.name} | ${risk} | ${repo.totalDependencies} | ${repo.compliant} | ${repo.nonCompliant} | ${repo.needsReview} | ${lastRun} |`);
  }
  lines.push('');

  // --- Aggregate stats ---
  lines.push(`## Aggregate Statistics`);
  lines.push('');
  lines.push(`| Metric | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total Repositories | ${m.repoCount} |`);
  lines.push(`| Clean Repositories | ${a.cleanRepos} |`);
  lines.push(`| Repositories with Violations | ${a.violatingRepos} |`);
  lines.push(`| Total Dependencies (all repos) | ${a.totalDependencies} |`);
  lines.push(`| Total Compliant | ${a.compliant} |`);
  lines.push(`| Total Non-Compliant | ${a.nonCompliant} |`);
  lines.push(`| Total Needs Review | ${a.needsReview} |`);
  lines.push('');

  // --- Cross-repo violations ---
  if (summary.crossRepoViolations.length > 0) {
    lines.push(`## ⚠️ Cross-Repository Violations`);
    lines.push('');
    lines.push(`These packages are flagged in multiple repositories — fixing them once may resolve issues across the organization.`);
    lines.push('');
    lines.push(`| Package | License | Severity | Affected Repos |`);
    lines.push(`|---------|---------|----------|----------------|`);

    for (const v of summary.crossRepoViolations) {
      lines.push(`| ${v.package} | ${v.license} | ${v.severity} | ${v.repos.join(', ')} |`);
    }
    lines.push('');
  }

  // --- Org license distribution ---
  lines.push(`## License Distribution (All Repositories)`);
  lines.push('');

  const td = summary.orgTierDistribution;
  const total = Object.values(td).reduce((a, b) => a + b, 0);
  if (total > 0) {
    if (td.permissive) lines.push(`- **Permissive** (MIT, BSD, Apache): ${td.permissive} (${Math.round(td.permissive / total * 100)}%)`);
    if (td.weak_copyleft) lines.push(`- **Weak Copyleft** (LGPL, MPL): ${td.weak_copyleft} (${Math.round(td.weak_copyleft / total * 100)}%)`);
    if (td.strong_copyleft) lines.push(`- **Strong Copyleft** (GPL): ${td.strong_copyleft} (${Math.round(td.strong_copyleft / total * 100)}%)`);
    if (td.network_copyleft) lines.push(`- **Network Copyleft** (AGPL): ${td.network_copyleft} (${Math.round(td.network_copyleft / total * 100)}%)`);
    if (td.unknown) lines.push(`- **Unknown**: ${td.unknown} (${Math.round(td.unknown / total * 100)}%)`);
  }
  lines.push('');

  // --- Per-repo violation details ---
  const violatingRepos = summary.repos.filter(r => r.nonCompliant > 0);
  if (violatingRepos.length > 0) {
    lines.push(`## Violation Details by Repository`);
    lines.push('');

    for (const repo of violatingRepos) {
      lines.push(`### ${repo.name} (Risk: ${repo.riskScore}/100)`);
      lines.push('');

      if (repo.topViolations.length > 0) {
        for (const v of repo.topViolations) {
          const icon = v.severity === 'critical' ? '🔴' : v.severity === 'high' ? '🟠' : '🟡';
          lines.push(`- ${icon} **${v.package}** — ${v.license} (${v.severity})`);
        }
      }
      lines.push('');
    }
  }

  // Footer
  lines.push(`---`);
  lines.push(`*Generated by [Comply OSS](https://github.com/comply-oss/comply) v${m.complyVersion}*`);

  return lines.join('\n');
}

// ---- Internal Helpers ----

async function loadLatestReport(auditDir: string, repoName: string): Promise<AuditReport | null> {
  try {
    const metaPath = join(auditDir, 'repos', repoName, 'meta.json');
    const meta = JSON.parse(await readFile(metaPath, 'utf-8'));

    if (!meta.lastSnapshot) return null;

    const reportPath = join(auditDir, 'repos', repoName, 'snapshots', meta.lastSnapshot, 'report.json');
    return JSON.parse(await readFile(reportPath, 'utf-8'));
  } catch {
    return null;
  }
}

function extractRepoSummary(repoName: string, report: AuditReport): RepoSummary {
  const violations = report.evaluations
    .filter(e => e.status === 'non_compliant')
    .sort((a, b) => {
      const order: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, none: 4 };
      return (order[a.severity] ?? 5) - (order[b.severity] ?? 5);
    })
    .slice(0, 5)
    .map(e => ({
      package: e.dependency.name,
      license: e.license.license.spdxId || e.license.rawLicense || 'Unknown',
      severity: e.severity,
    }));

  return {
    name: repoName,
    lastRun: report.metadata.timestamp,
    riskScore: report.summary.riskScore,
    totalDependencies: report.summary.totalDependencies,
    compliant: report.summary.compliant,
    nonCompliant: report.summary.nonCompliant,
    needsReview: report.summary.needsReview,
    conditionallyCompliant: report.summary.conditionallyCompliant,
    topViolations: violations,
    ecosystems: report.metadata.ecosystems,
  };
}

function computeAggregate(repos: RepoSummary[]) {
  let totalDeps = 0, compliant = 0, nonCompliant = 0, needsReview = 0, conditionally = 0;

  for (const r of repos) {
    totalDeps += r.totalDependencies;
    compliant += r.compliant;
    nonCompliant += r.nonCompliant;
    needsReview += r.needsReview;
    conditionally += r.conditionallyCompliant;
  }

  const cleanRepos = repos.filter(r => r.riskScore === 0).length;
  const violatingRepos = repos.filter(r => r.nonCompliant > 0).length;

  // Aggregate risk: weighted average biased toward worst repos
  const riskScores = repos.map(r => r.riskScore);
  const maxRisk = Math.max(...riskScores);
  const avgRisk = riskScores.reduce((a, b) => a + b, 0) / riskScores.length;
  // Weight: 60% max, 40% avg — one bad repo can't be hidden by good ones
  const aggregateRiskScore = Math.round(maxRisk * 0.6 + avgRisk * 0.4);

  return {
    totalDependencies: totalDeps,
    totalUnique: 0, // Would need dedup across repos
    compliant,
    nonCompliant,
    needsReview,
    conditionallyCompliant: conditionally,
    aggregateRiskScore,
    cleanRepos,
    violatingRepos,
  };
}

function findCrossRepoViolations(reports: AuditReport[]): OrgSummary['crossRepoViolations'] {
  const violationMap = new Map<string, {
    license: string;
    severity: Severity;
    repos: Set<string>;
  }>();

  for (const report of reports) {
    const repoName = report.metadata.repoName;
    for (const evaluation of report.evaluations) {
      if (evaluation.status !== 'non_compliant') continue;

      const pkgName = evaluation.dependency.name;
      if (!violationMap.has(pkgName)) {
        violationMap.set(pkgName, {
          license: evaluation.license.license.spdxId || 'Unknown',
          severity: evaluation.severity,
          repos: new Set(),
        });
      }
      violationMap.get(pkgName)!.repos.add(repoName);
    }
  }

  // Only include packages that appear in 2+ repos
  return [...violationMap.entries()]
    .filter(([_, v]) => v.repos.size > 1)
    .map(([name, v]) => ({
      package: name,
      license: v.license,
      severity: v.severity,
      repos: [...v.repos],
    }))
    .sort((a, b) => {
      const order: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, none: 4 };
      return (order[a.severity] ?? 5) - (order[b.severity] ?? 5);
    });
}

function generateOrgExecutiveSummary(summary: OrgSummary): string {
  const a = summary.aggregate;
  const parts: string[] = [];

  if (a.aggregateRiskScore === 0) {
    return `All ${summary.metadata.repoCount} repositories are fully compliant. A total of ${a.totalDependencies} open source dependencies were analyzed across the organization with no license violations or issues detected. No action is required at this time.`;
  }

  // Opening
  if (a.violatingRepos === 0) {
    parts.push(`Across ${summary.metadata.repoCount} repositories and ${a.totalDependencies} total dependencies, no confirmed license violations were found. However, ${a.needsReview} package${a.needsReview > 1 ? 's' : ''} require${a.needsReview === 1 ? 's' : ''} manual review.`);
  } else {
    parts.push(`Across ${summary.metadata.repoCount} repositories and ${a.totalDependencies} total dependencies, ${a.nonCompliant} license violation${a.nonCompliant > 1 ? 's were' : ' was'} identified in ${a.violatingRepos} repositor${a.violatingRepos > 1 ? 'ies' : 'y'}.`);
  }

  // Worst offenders
  const worst = summary.repos.filter(r => r.riskScore > 50);
  if (worst.length > 0) {
    const names = worst.map(r => r.name).join(', ');
    parts.push(`The highest risk repositor${worst.length > 1 ? 'ies are' : 'y is'} ${names}, which should be prioritized for remediation.`);
  }

  // Cross-repo issues
  if (summary.crossRepoViolations.length > 0) {
    parts.push(`${summary.crossRepoViolations.length} violating package${summary.crossRepoViolations.length > 1 ? 's appear' : ' appears'} in multiple repositories, representing a shared risk surface that can be addressed efficiently through centralized remediation.`);
  }

  // Recommendation
  if (a.aggregateRiskScore <= 20) {
    parts.push(`Overall risk is low. Address the identified issues at your next regular maintenance cycle.`);
  } else if (a.aggregateRiskScore <= 50) {
    parts.push(`Recommend addressing violations before any distribution, acquisition, or compliance certification.`);
  } else {
    parts.push(`Immediate remediation is recommended. Engage legal counsel for copyleft license obligations. A complete remediation plan is provided in the per-repository details below.`);
  }

  return parts.join(' ');
}

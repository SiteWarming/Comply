// ============================================================================
// Executive Summary — Plain-English one-pager for non-technical stakeholders
// ============================================================================
//
// Generates a 3-5 sentence summary that a PE partner, GC, or board member
// can read in 30 seconds and understand the risk posture. Works without AI
// by default — uses structured templates. AI-enhanced mode available for
// more polished output when an API key is present.
// ============================================================================

import type { AuditReport, PolicyEvaluation, Severity, LicenseTier } from './types.js';

/**
 * Generate a plain-English executive summary from audit results.
 * No AI required — this is deterministic template-based generation.
 */
export function generateExecutiveSummary(report: AuditReport): string {
  const s = report.summary;
  const m = report.metadata;
  const paragraphs: string[] = [];

  // --- Opening assessment ---
  paragraphs.push(openingAssessment(s, m));

  // --- Key findings ---
  const findings = keyFindings(report);
  if (findings) {
    paragraphs.push(findings);
  }

  // --- Risk characterization ---
  const risk = riskCharacterization(report);
  if (risk) {
    paragraphs.push(risk);
  }

  // --- Recommendation ---
  paragraphs.push(recommendation(report));

  return paragraphs.join('\n\n');
}

function openingAssessment(
  s: AuditReport['summary'],
  m: AuditReport['metadata']
): string {
  const date = new Date(m.timestamp).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  const ecosystemList = m.ecosystems.join(', ');

  if (s.riskScore === 0) {
    return `This repository (${m.repoName}) was scanned on ${date} and found to be fully compliant. All ${s.totalDependencies} open source dependencies (${s.directDependencies} direct, ${s.transitiveDependencies} transitive) across ${ecosystemList} carry permissive licenses with no compliance issues detected.`;
  }

  if (s.nonCompliant === 0 && s.needsReview === 0 && s.conditionallyCompliant > 0) {
    return `This repository (${m.repoName}) was scanned on ${date} across ${s.totalDependencies} open source dependencies (${ecosystemList}). No outright violations were found, but ${s.conditionallyCompliant} package${s.conditionallyCompliant > 1 ? 's' : ''} carry${s.conditionallyCompliant === 1 ? 'ies' : ''} conditional license terms that require verification of how they are used in the codebase.`;
  }

  if (s.nonCompliant === 0 && s.needsReview > 0) {
    return `This repository (${m.repoName}) was scanned on ${date} across ${s.totalDependencies} open source dependencies (${ecosystemList}). No confirmed violations were found, but ${s.needsReview} package${s.needsReview > 1 ? 's have' : ' has'} licenses that could not be fully evaluated and require${s.needsReview === 1 ? 's' : ''} manual review.`;
  }

  // There are violations
  const severityWord = s.riskScore > 80 ? 'critical' :
    s.riskScore > 50 ? 'significant' :
    s.riskScore > 20 ? 'moderate' : 'minor';

  return `This repository (${m.repoName}) was scanned on ${date} and ${s.nonCompliant} license violation${s.nonCompliant > 1 ? 's were' : ' was'} identified across ${s.totalDependencies} open source dependencies (${ecosystemList}). The overall risk level is ${severityWord} (score: ${s.riskScore}/100).`;
}

function keyFindings(report: AuditReport): string | null {
  const violations = report.evaluations.filter(e => e.status === 'non_compliant');

  if (violations.length === 0) return null;

  const critical = violations.filter(e => e.severity === 'critical');
  const high = violations.filter(e => e.severity === 'high');

  const parts: string[] = [];

  if (critical.length > 0) {
    const names = critical.map(e => `${e.dependency.name} (${e.license.license.spdxId || 'unknown license'})`);
    parts.push(`${critical.length} critical-severity issue${critical.length > 1 ? 's' : ''}: ${names.join(', ')}. ${describeCritical(critical)}`);
  }

  if (high.length > 0) {
    const names = high.slice(0, 3).map(e => `${e.dependency.name} (${e.license.license.spdxId || 'unknown license'})`);
    const suffix = high.length > 3 ? ` and ${high.length - 3} more` : '';
    parts.push(`${high.length} high-severity issue${high.length > 1 ? 's' : ''}: ${names.join(', ')}${suffix}`);
  }

  const medium = violations.filter(e => e.severity === 'medium');
  if (medium.length > 0) {
    parts.push(`${medium.length} medium-severity issue${medium.length > 1 ? 's' : ''} involving weak copyleft licenses`);
  }

  if (parts.length === 0) return null;

  return `Key findings: ${parts.join('. ')}.`;
}

function describeCritical(critical: PolicyEvaluation[]): string {
  const hasAGPL = critical.some(e => {
    const spdx = e.license.license.spdxId?.toUpperCase() || '';
    return spdx.includes('AGPL');
  });
  const hasSSPL = critical.some(e => {
    const spdx = e.license.license.spdxId?.toUpperCase() || '';
    return spdx.includes('SSPL');
  });
  const hasGPL = critical.some(e => {
    const spdx = e.license.license.spdxId?.toUpperCase() || '';
    return spdx.includes('GPL') && !spdx.includes('AGPL') && !spdx.includes('LGPL');
  });

  if (hasAGPL || hasSSPL) {
    return 'These licenses require full source code disclosure for any network-accessible software, which would include SaaS products.';
  }
  if (hasGPL) {
    return 'These licenses require source code disclosure when the software is distributed, which may apply depending on your deployment model.';
  }
  return 'These require immediate attention as they may impose significant obligations on how the software can be used or distributed.';
}

function riskCharacterization(report: AuditReport): string | null {
  const td = report.tierDistribution;
  const total = report.summary.totalDependencies;
  if (total === 0) return null;

  const permPct = Math.round((td.permissive / total) * 100);
  const unknownCount = td.unknown;

  const parts: string[] = [];

  if (permPct >= 90) {
    parts.push(`${permPct}% of dependencies use permissive licenses (MIT, BSD, Apache), which is a strong baseline`);
  } else if (permPct >= 70) {
    parts.push(`${permPct}% of dependencies use permissive licenses`);
  } else {
    parts.push(`Only ${permPct}% of dependencies use permissive licenses, which is below typical thresholds`);
  }

  if (unknownCount > 0) {
    const unknownPct = Math.round((unknownCount / total) * 100);
    parts.push(`${unknownCount} package${unknownCount > 1 ? 's' : ''} (${unknownPct}%) could not have ${unknownCount > 1 ? 'their licenses' : 'its license'} determined and should be reviewed manually`);
  }

  const copyleftTotal = td.weak_copyleft + td.strong_copyleft + td.network_copyleft;
  if (copyleftTotal > 0) {
    parts.push(`${copyleftTotal} package${copyleftTotal > 1 ? 's use' : ' uses'} copyleft licenses that may impose obligations depending on usage context`);
  }

  if (parts.length === 0) return null;

  return parts.join('. ') + '.';
}

function recommendation(report: AuditReport): string {
  const s = report.summary;

  if (s.riskScore === 0) {
    return 'No action is required. This codebase has a clean license profile. Recommend re-scanning periodically as dependencies are added or updated.';
  }

  if (s.nonCompliant === 0 && s.needsReview > 0) {
    return `Recommendation: Review the ${s.needsReview} package${s.needsReview > 1 ? 's' : ''} with unresolved licenses. These are likely low-risk but should be confirmed before any acquisition, distribution, or compliance certification.`;
  }

  if (s.riskScore <= 20) {
    return `Recommendation: Address the ${s.nonCompliant} identified violation${s.nonCompliant > 1 ? 's' : ''}. Remediation steps are provided in the detailed findings below. Estimated effort is low — most issues can be resolved through package substitution or adding required attribution notices.`;
  }

  if (s.riskScore <= 50) {
    return `Recommendation: Address the ${s.nonCompliant} violation${s.nonCompliant > 1 ? 's' : ''} before any distribution, acquisition closing, or compliance certification. The detailed findings below include specific remediation steps for each issue. A follow-up scan should be performed after remediation to confirm resolution.`;
  }

  // High / critical risk
  const criticalCount = report.evaluations.filter(e =>
    e.status === 'non_compliant' && (e.severity === 'critical' || e.severity === 'high')
  ).length;

  return `Recommendation: This codebase has ${criticalCount} high or critical-severity license violation${criticalCount > 1 ? 's' : ''} that require immediate remediation. These issues should be resolved before any transaction close, product distribution, or compliance certification. Engage legal counsel for any copyleft license obligations. A complete remediation plan with estimated effort is provided in the detailed findings below.`;
}

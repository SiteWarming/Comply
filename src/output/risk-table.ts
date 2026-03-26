// ============================================================================
// Risk Table — Render ranked dependency risk summary for reports
// ============================================================================

import type { RankedDependency } from './risk-score.js';

/**
 * Render a ranked summary table of at-risk dependencies.
 * Sorted by composite risk score descending. Shows top N entries.
 */
export function renderRankedSummaryTable(
  ranked: RankedDependency[],
  opts?: { limit?: number }
): string {
  const atRisk = ranked.filter(r => r.compositeScore > 0);
  if (atRisk.length === 0) return '';

  const limit = opts?.limit ?? 25;
  const shown = atRisk.slice(0, limit);
  const lines: string[] = [];

  lines.push(`## 🎯 Dependency Risk Ranking`);
  lines.push('');
  lines.push(`Top dependencies ranked by composite risk score (license + maintenance + vulnerabilities).`);
  lines.push('');
  lines.push(`| # | Package | Score | Severity | Staleness | CVEs | Fix Available | Type |`);
  lines.push(`|---|---------|-------|----------|-----------|------|---------------|------|`);

  for (let i = 0; i < shown.length; i++) {
    const r = shown[i];
    const icon = riskIcon(r.compositeScore);
    const staleness = formatStaleness(r.maintenanceRisk, r.daysSinceLastPublish);
    const cves = r.cveCount > 0 ? String(r.cveCount) : '--';
    const fix = r.fixVersion ?? '--';
    const type = r.isDirect ? '**direct**' : 'transitive';
    lines.push(`| ${i + 1} | ${r.name}@${r.version} | ${icon} ${r.compositeScore} | ${severityLabel(r.severity)} | ${staleness} | ${cves} | ${fix} | ${type} |`);
  }

  lines.push('');

  if (atRisk.length > limit) {
    lines.push(`*Plus ${atRisk.length - limit} more dependencies with risk score > 0 (not shown).*`);
    lines.push('');
  }

  return lines.join('\n');
}

function riskIcon(score: number): string {
  if (score >= 70) return '🔴';
  if (score >= 40) return '🟠';
  if (score >= 15) return '🟡';
  return '🟢';
}

function severityLabel(s: string): string {
  const labels: Record<string, string> = {
    critical: '🔴 Critical', high: '🟠 High', medium: '🟡 Medium',
    low: '🟢 Low', none: '✅ None',
  };
  return labels[s] ?? s;
}

function formatStaleness(risk: string, days: number | null): string {
  if (risk === 'abandoned') {
    const years = days ? Math.floor(days / 365) : null;
    return years ? `${years}y+ abandoned` : 'abandoned';
  }
  if (risk === 'stale') {
    const years = days ? Math.floor(days / 365) : null;
    return years ? `${years}y stale` : 'stale';
  }
  if (risk === 'aging') return 'aging (1-2y)';
  if (risk === 'stable') return 'stable';
  if (risk === 'active') return 'active';
  return 'unknown';
}

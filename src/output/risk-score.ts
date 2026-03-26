// ============================================================================
// Risk Score — Composite per-dependency risk ranking
// ============================================================================
//
// Combines license severity, maintenance risk, vulnerability data, and
// dependency directness into a single 0-100 score for stack-ranking.
// All weight constants are at the top for easy tuning.
// ============================================================================

import type { PolicyEvaluation, Severity } from '../types.js';
import type { DependencyHealth } from '../pipeline/health.js';
import type { DependencyVulnerabilities } from '../pipeline/vulnerabilities.js';

// ---- Weight Constants (tune these) ----

const LICENSE_WEIGHTS: Record<Severity, number> = {
  critical: 40,
  high: 30,
  medium: 15,
  low: 5,
  none: 0,
};

const MAINTENANCE_WEIGHTS: Record<string, number> = {
  abandoned: 25,
  stale: 15,
  aging: 8,
  stable: 2,
  active: 0,
  unknown: 5,
};

/** CVSS multiplier — max 35 points at CVSS 10.0 */
const CVSS_MULTIPLIER = 3.5;
const VULN_SCORE_CAP = 35;

/** Discount for transitive deps (not a direct choice) */
const TRANSITIVE_MULTIPLIER = 0.6;

/** If a fix version exists, reduce vuln score by this factor */
const FIX_AVAILABLE_FACTOR = 0.7;

// ---- Public Types ----

export interface RiskSignals {
  licenseScore: number;
  maintenanceScore: number;
  vulnerabilityScore: number;
  directMultiplier: number;
  fixAvailableReduction: number;
}

export interface RankedDependency {
  name: string;
  version: string;
  ecosystem: string;
  isDirect: boolean;
  compositeScore: number;
  signals: RiskSignals;
  severity: Severity;
  maintenanceRisk: string;
  cveCount: number;
  maxCvss: number;
  fixVersion: string | null;
  daysSinceLastPublish: number | null;
}

// ---- Main Entry Point ----

/**
 * Compute a composite risk score for every evaluated dependency,
 * combining license, maintenance, and vulnerability signals.
 * Returns sorted descending by compositeScore.
 */
export function computeDependencyRiskScores(
  evaluations: PolicyEvaluation[],
  healthData: DependencyHealth[],
  vulnData: DependencyVulnerabilities[]
): RankedDependency[] {
  const healthMap = new Map(healthData.map(h => [`${h.name}@${h.version}@${h.ecosystem}`, h]));
  const vulnMap = new Map(vulnData.map(v => [`${v.name}@${v.version}@${v.ecosystem}`, v]));

  const ranked = evaluations.map(eval_ => {
    const key = `${eval_.dependency.name}@${eval_.dependency.version}@${eval_.dependency.ecosystem}`;
    const health = healthMap.get(key);
    const vuln = vulnMap.get(key);

    return scoreOne(eval_, health, vuln);
  });

  // Sort descending by composite score, then by name for stability
  ranked.sort((a, b) => b.compositeScore - a.compositeScore || a.name.localeCompare(b.name));

  return ranked;
}

// ---- Scoring Logic ----

function scoreOne(
  eval_: PolicyEvaluation,
  health: DependencyHealth | undefined,
  vuln: DependencyVulnerabilities | undefined
): RankedDependency {
  // License score: only count if non-compliant or needs review
  const licenseScore = eval_.status === 'compliant'
    ? 0
    : LICENSE_WEIGHTS[eval_.severity] ?? 0;

  // Maintenance score
  const maintenanceRisk = health?.maintenanceRisk ?? 'unknown';
  const maintenanceScore = MAINTENANCE_WEIGHTS[maintenanceRisk] ?? 5;

  // Vulnerability score — CVSS-driven with CVE count bonus
  // CVSS score is primary signal; additional CVEs add marginal risk
  const cveCount = vuln?.totalCount ?? 0;
  const maxCvss = vuln?.maxCvss ?? 0;
  const cvssScore = maxCvss > 0
    ? Math.min(VULN_SCORE_CAP, maxCvss * CVSS_MULTIPLIER)
    : (cveCount > 0 ? 15 : 0); // baseline 15 for CVEs without CVSS
  const cveCountBonus = Math.min(10, Math.max(0, cveCount - 1) * 3); // +3 per extra CVE, max +10
  const rawVulnScore = Math.min(VULN_SCORE_CAP, cvssScore + cveCountBonus);
  const hasFixAvailable = (vuln?.vulnerabilities ?? []).some(v => v.fixedVersions.length > 0);
  const fixAvailableReduction = hasFixAvailable ? FIX_AVAILABLE_FACTOR : 1.0;
  const vulnerabilityScore = rawVulnScore * fixAvailableReduction;

  // Direct vs transitive multiplier
  const isDirect = eval_.dependency.isDirect;
  const directMultiplier = isDirect ? 1.0 : TRANSITIVE_MULTIPLIER;

  // Composite
  const raw = (licenseScore + maintenanceScore + vulnerabilityScore) * directMultiplier;
  const compositeScore = Math.min(100, Math.round(raw));

  return {
    name: eval_.dependency.name,
    version: eval_.dependency.version,
    ecosystem: eval_.dependency.ecosystem,
    isDirect,
    compositeScore,
    signals: {
      licenseScore,
      maintenanceScore,
      vulnerabilityScore: Math.round(vulnerabilityScore * 10) / 10,
      directMultiplier,
      fixAvailableReduction,
    },
    severity: eval_.severity,
    maintenanceRisk,
    cveCount: vuln?.totalCount ?? 0,
    maxCvss,
    fixVersion: bestFixVersion(vuln),
    daysSinceLastPublish: health?.daysSinceLastPublish ?? null,
  };
}

// ---- Helpers ----

/**
 * Pick the best (highest) fix version across all vulnerabilities for a dependency.
 */
function bestFixVersion(vuln: DependencyVulnerabilities | undefined): string | null {
  if (!vuln) return null;

  const allFixed = vuln.vulnerabilities.flatMap(v => v.fixedVersions);
  if (allFixed.length === 0) return null;

  return allFixed.sort(compareSemver).at(-1) ?? null;
}

/**
 * Compare two semver-ish strings. Handles x.y.z and x.y.z-pre formats.
 * Falls back to lexicographic for non-numeric segments.
 */
function compareSemver(a: string, b: string): number {
  const partsA = a.split(/[.-]/).map(p => {
    const n = parseInt(p, 10);
    return isNaN(n) ? p : n;
  });
  const partsB = b.split(/[.-]/).map(p => {
    const n = parseInt(p, 10);
    return isNaN(n) ? p : n;
  });

  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const pa = partsA[i] ?? 0;
    const pb = partsB[i] ?? 0;
    if (typeof pa === 'number' && typeof pb === 'number') {
      if (pa !== pb) return pa - pb;
    } else {
      const cmp = String(pa).localeCompare(String(pb));
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

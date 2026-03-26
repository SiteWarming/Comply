// ============================================================================
// Vulnerabilities — Query OSV.dev for known CVEs across all ecosystems
// ============================================================================
//
// OSV.dev is Google's free, open vulnerability database. It aggregates
// advisories from GitHub (npm), PyPI, crates.io, and Go — exactly the
// ecosystems Comply supports. The batch API lets us check all deps in a
// few HTTP calls with no API key required.
// ============================================================================

import type { Dependency, Ecosystem } from '../types.js';

// ---- Public Types ----

export interface VulnerabilityInfo {
  cveId: string | null;
  aliases: string[];
  cvssScore: number | null;
  severity: 'critical' | 'high' | 'medium' | 'low';
  summary: string;
  fixedVersions: string[];
  url: string;
}

export interface DependencyVulnerabilities {
  name: string;
  version: string;
  ecosystem: Ecosystem;
  vulnerabilities: VulnerabilityInfo[];
  maxCvss: number;
  totalCount: number;
}

// ---- Ecosystem Mapping ----

const ECOSYSTEM_MAP: Partial<Record<Ecosystem, string>> = {
  npm: 'npm',
  python: 'PyPI',
  go: 'Go',
  rust: 'crates.io',
};

function mapEcosystemToOSV(eco: Ecosystem): string | null {
  return ECOSYSTEM_MAP[eco] ?? null;
}

// ---- Main Entry Point ----

/**
 * Check all dependencies for known vulnerabilities via OSV.dev batch API.
 * Batched in groups of 100. Returns results for all deps (including zero-vuln ones).
 */
export async function checkVulnerabilities(
  dependencies: Dependency[],
  opts?: { verbose?: boolean }
): Promise<DependencyVulnerabilities[]> {
  // Filter to supported ecosystems
  const supported = dependencies.filter(d => mapEcosystemToOSV(d.ecosystem) !== null);
  const unsupported = dependencies.length - supported.length;

  if (opts?.verbose && unsupported > 0) {
    console.log(`  Skipping ${unsupported} dependencies from unsupported ecosystems for vulnerability check`);
  }

  if (supported.length === 0) {
    return [];
  }

  const results: DependencyVulnerabilities[] = [];
  const batchSize = 100;

  for (let i = 0; i < supported.length; i += batchSize) {
    const batch = supported.slice(i, i + batchSize);
    const batchResults = await queryOSVBatch(batch, opts?.verbose);
    results.push(...batchResults);
  }

  return results;
}

// ---- OSV Batch Query ----

async function queryOSVBatch(
  deps: Dependency[],
  verbose?: boolean
): Promise<DependencyVulnerabilities[]> {
  const queries = deps.map(dep => ({
    package: {
      name: dep.name,
      ecosystem: mapEcosystemToOSV(dep.ecosystem)!,
    },
    version: dep.version,
  }));

  try {
    // Step 1: Batch query returns only vuln IDs (lightweight)
    const response = await fetch('https://api.osv.dev/v1/querybatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queries }),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      if (verbose) {
        console.log(`  OSV.dev returned ${response.status} — skipping vulnerability data for this batch`);
      }
      return deps.map(d => makeEmptyVulnResult(d));
    }

    const data = await response.json() as { results: Array<{ vulns?: Array<{ id: string }> }> };
    const batchResults = data.results ?? [];

    // Step 2: Collect all unique vuln IDs and fetch full details
    const allVulnIds = new Set<string>();
    for (const result of batchResults) {
      for (const v of result?.vulns ?? []) {
        if (v.id) allVulnIds.add(v.id);
      }
    }

    // Cap hydration to prevent OOM on massive repos
    const idsToHydrate = [...allVulnIds].slice(0, MAX_HYDRATION_LIMIT);
    if (allVulnIds.size > MAX_HYDRATION_LIMIT && verbose) {
      console.log(`  ⚠️  ${allVulnIds.size} vulnerabilities found, hydrating top ${MAX_HYDRATION_LIMIT} (cap reached)`);
    }

    // Hydrate vulnerability details in parallel (batched to avoid overwhelming the API)
    const vulnDetailsMap = await hydrateVulnerabilities(idsToHydrate, verbose);

    // Step 3: Map results back to dependencies
    return deps.map((dep, idx) => {
      const result = batchResults[idx];
      const vulnIds = (result?.vulns ?? []).map(v => v.id).filter(Boolean);

      const vulnerabilities = vulnIds
        .map(id => vulnDetailsMap.get(id))
        .filter(Boolean) as VulnerabilityInfo[];

      const maxCvss = vulnerabilities.reduce((max, v) => Math.max(max, v.cvssScore ?? 0), 0);

      return {
        name: dep.name,
        version: dep.version,
        ecosystem: dep.ecosystem,
        vulnerabilities,
        maxCvss,
        totalCount: vulnerabilities.length,
      };
    });
  } catch (err) {
    if (verbose) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  OSV.dev query failed: ${msg} — continuing without vulnerability data for this batch`);
    }
    return deps.map(d => makeEmptyVulnResult(d));
  }
}

/**
 * Fetch full vulnerability details for a set of IDs.
 * Batched in groups of 10 concurrent requests.
 */
async function hydrateVulnerabilities(
  ids: string[],
  verbose?: boolean
): Promise<Map<string, VulnerabilityInfo>> {
  const map = new Map<string, VulnerabilityInfo>();
  const concurrency = 10;

  for (let i = 0; i < ids.length; i += concurrency) {
    const batch = ids.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(id => fetchVulnDetails(id))
    );
    for (let j = 0; j < batch.length; j++) {
      const result = results[j];
      if (result) {
        map.set(batch[j], result);
      }
    }
  }

  return map;
}

/** Maximum number of individual vulns to hydrate per scan (prevents OOM on large repos) */
const MAX_HYDRATION_LIMIT = 500;

const VALID_OSV_ID = /^[A-Z][A-Z0-9]+-[A-Za-z0-9._-]+$/;

async function fetchVulnDetails(id: string): Promise<VulnerabilityInfo | null> {
  if (!VALID_OSV_ID.test(id)) return null;

  try {
    const response = await fetch(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`, {
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return null;

    const raw = await response.json();
    return parseVulnerability(raw);
  } catch {
    return null;
  }
}

// ---- Vulnerability Parsing ----

function parseVulnerability(raw: unknown): VulnerabilityInfo | null {
  if (!raw || typeof raw !== 'object') return null;

  const vuln = raw as Record<string, unknown>;
  const id = typeof vuln.id === 'string' ? vuln.id : null;
  if (!id) return null;

  const aliases = Array.isArray(vuln.aliases)
    ? (vuln.aliases as unknown[]).filter((a): a is string => typeof a === 'string')
    : [];

  // CVE ID: prefer alias matching CVE- pattern, fall back to the OSV id
  const cveId = aliases.find(a => a.startsWith('CVE-')) ?? (id.startsWith('CVE-') ? id : null);

  const cvssScore = extractCvssScore(vuln);
  const severity = cvssToSeverity(cvssScore);

  const summary = typeof vuln.summary === 'string'
    ? truncate(vuln.summary, 200)
    : (typeof vuln.details === 'string' ? truncate(vuln.details, 200) : 'No description available');

  const fixedVersions = extractFixedVersions(vuln);
  const url = `https://osv.dev/vulnerability/${id}`;

  return {
    cveId,
    aliases: [id, ...aliases],
    cvssScore,
    severity,
    summary,
    fixedVersions,
    url,
  };
}

// ---- CVSS Extraction ----

function extractCvssScore(vuln: Record<string, unknown>): number | null {
  const severityArray = vuln.severity;

  if (Array.isArray(severityArray)) {
    // Prefer CVSS_V3 over CVSS_V2
    for (const preferred of ['CVSS_V4', 'CVSS_V3', 'CVSS_V2']) {
      for (const entry of severityArray) {
        if (entry && typeof entry === 'object') {
          const e = entry as Record<string, unknown>;
          if (e.type === preferred && typeof e.score === 'string') {
            // OSV returns CVSS vector strings; parse the score from them
            // Format: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" — score is separate
            // Actually, some entries have a numeric `score` field directly
            const parsed = parseFloat(e.score);
            if (!isNaN(parsed)) return parsed;
          }
          if (e.type === preferred && typeof e.score === 'number') {
            return e.score;
          }
        }
      }
    }
  }

  // Fallback: check database_specific.severity string
  const dbSpecific = vuln.database_specific;
  if (dbSpecific && typeof dbSpecific === 'object') {
    const db = dbSpecific as Record<string, unknown>;
    const sevStr = typeof db.severity === 'string' ? db.severity.toUpperCase() : null;
    if (sevStr) {
      const approx: Record<string, number> = {
        CRITICAL: 9.5, HIGH: 7.5, MODERATE: 5.5, MEDIUM: 5.0, LOW: 2.0,
      };
      return approx[sevStr] ?? null;
    }
  }

  return null;
}

function cvssToSeverity(score: number | null): VulnerabilityInfo['severity'] {
  if (score === null) return 'medium'; // Present vuln without score still matters
  if (score >= 9.0) return 'critical';
  if (score >= 7.0) return 'high';
  if (score >= 4.0) return 'medium';
  return 'low';
}

// ---- Fixed Version Extraction ----

function extractFixedVersions(vuln: Record<string, unknown>): string[] {
  const affected = vuln.affected;
  if (!Array.isArray(affected)) return [];

  const fixed = new Set<string>();

  for (const entry of affected) {
    if (!entry || typeof entry !== 'object') continue;
    const a = entry as Record<string, unknown>;
    const ranges = a.ranges;
    if (!Array.isArray(ranges)) continue;

    for (const range of ranges) {
      if (!range || typeof range !== 'object') continue;
      const r = range as Record<string, unknown>;
      const events = r.events;
      if (!Array.isArray(events)) continue;

      for (const event of events) {
        if (!event || typeof event !== 'object') continue;
        const e = event as Record<string, unknown>;
        if (typeof e.fixed === 'string') {
          fixed.add(e.fixed);
        }
      }
    }
  }

  return [...fixed];
}

// ---- Helpers ----

function makeEmptyVulnResult(dep: Dependency): DependencyVulnerabilities {
  return {
    name: dep.name,
    version: dep.version,
    ecosystem: dep.ecosystem,
    vulnerabilities: [],
    maxCvss: 0,
    totalCount: 0,
  };
}

function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + '…';
}

// ============================================================================
// Health — Dependency age, deprecation, and maintenance risk signals
// ============================================================================
//
// Licenses are only half the picture. A package last published in 2019 with
// an MIT license is a different risk profile than one published last month.
// This module pulls health signals from the same registry calls we're already
// making, so it's nearly free to add.
// ============================================================================

import type { Dependency, Ecosystem } from '../types.js';

export interface DependencyHealth {
  name: string;
  version: string;
  ecosystem: Ecosystem;
  /** When the installed version was published */
  publishedAt: string | null;
  /** When the latest version was published */
  latestPublishedAt: string | null;
  /** Latest available version */
  latestVersion: string | null;
  /** Whether the installed version is the latest */
  isLatest: boolean;
  /** Whether this package is deprecated */
  isDeprecated: boolean;
  /** Deprecation message if applicable */
  deprecationMessage: string | null;
  /** Days since last publish of any version */
  daysSinceLastPublish: number | null;
  /** Maintenance risk classification */
  maintenanceRisk: 'active' | 'stable' | 'aging' | 'stale' | 'abandoned' | 'unknown';
  /** License at latest version (may differ from installed version) */
  latestLicense: string | null;
  /** Whether the license changed between installed and latest */
  licenseChanged: boolean;
}

/**
 * Fetch health signals for a list of dependencies.
 * Batched to avoid overwhelming registries.
 */
export async function checkDependencyHealth(
  dependencies: Dependency[],
  opts?: { verbose?: boolean }
): Promise<DependencyHealth[]> {
  const results: DependencyHealth[] = [];
  const batchSize = 10;

  for (let i = 0; i < dependencies.length; i += batchSize) {
    const batch = dependencies.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(dep => checkSingleHealth(dep, opts?.verbose))
    );
    results.push(...batchResults);
  }

  return results;
}

async function checkSingleHealth(dep: Dependency, verbose?: boolean): Promise<DependencyHealth> {
  switch (dep.ecosystem) {
    case 'npm':
      return checkNpmHealth(dep);
    case 'python':
      return checkPyPIHealth(dep);
    default:
      return makeUnknownHealth(dep);
  }
}

async function checkNpmHealth(dep: Dependency): Promise<DependencyHealth> {
  try {
    const response = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(dep.name)}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) }
    );

    if (!response.ok) return makeUnknownHealth(dep);

    const data = await response.json() as any;
    const time = data.time || {};
    const distTags = data['dist-tags'] || {};
    const latestVersion = distTags.latest || null;

    // Get publish date for installed version
    const publishedAt = time[dep.version] || null;

    // Get publish date for latest version
    const latestPublishedAt = latestVersion ? (time[latestVersion] || null) : null;

    // Check deprecation on the installed version
    const versionData = data.versions?.[dep.version] || {};
    const isDeprecated = !!versionData.deprecated;
    const deprecationMessage = versionData.deprecated || null;

    // License at latest version
    const latestVersionData = latestVersion ? (data.versions?.[latestVersion] || {}) : {};
    const latestLicenseRaw = latestVersionData.license;
    const latestLicense = typeof latestLicenseRaw === 'string' ? latestLicenseRaw :
      (latestLicenseRaw?.type || latestLicenseRaw?.name || null);

    // License at installed version
    const installedLicenseRaw = versionData.license;
    const installedLicense = typeof installedLicenseRaw === 'string' ? installedLicenseRaw :
      (installedLicenseRaw?.type || installedLicenseRaw?.name || null);

    const licenseChanged = !!(latestLicense && installedLicense &&
      latestLicense.toLowerCase() !== installedLicense.toLowerCase());

    // Days since last publish
    const lastModified = time.modified || latestPublishedAt;
    const daysSinceLastPublish = lastModified
      ? Math.floor((Date.now() - new Date(lastModified).getTime()) / (1000 * 60 * 60 * 24))
      : null;

    return {
      name: dep.name,
      version: dep.version,
      ecosystem: dep.ecosystem,
      publishedAt,
      latestPublishedAt,
      latestVersion,
      isLatest: dep.version === latestVersion,
      isDeprecated,
      deprecationMessage,
      daysSinceLastPublish,
      maintenanceRisk: classifyMaintenanceRisk(daysSinceLastPublish, isDeprecated),
      latestLicense,
      licenseChanged,
    };
  } catch {
    return makeUnknownHealth(dep);
  }
}

async function checkPyPIHealth(dep: Dependency): Promise<DependencyHealth> {
  try {
    const response = await fetch(
      `https://pypi.org/pypi/${encodeURIComponent(dep.name)}/json`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) }
    );

    if (!response.ok) return makeUnknownHealth(dep);

    const data = await response.json() as any;
    const info = data.info || {};
    const releases = data.releases || {};

    const latestVersion = info.version || null;

    // Find publish date for latest version
    const latestRelease = latestVersion ? releases[latestVersion] : null;
    const latestPublishedAt = latestRelease && latestRelease.length > 0
      ? latestRelease[0].upload_time_iso_8601 || null
      : null;

    // Check if any classifier indicates deprecated status
    const classifiers: string[] = info.classifiers || [];
    const isDeprecated = classifiers.some((c: string) =>
      c.includes('Inactive') || c.includes('No Longer Maintained')
    );

    const daysSinceLastPublish = latestPublishedAt
      ? Math.floor((Date.now() - new Date(latestPublishedAt).getTime()) / (1000 * 60 * 60 * 24))
      : null;

    const latestLicense = info.license && info.license !== 'UNKNOWN' ? info.license : null;

    return {
      name: dep.name,
      version: dep.version,
      ecosystem: dep.ecosystem,
      publishedAt: null, // PyPI doesn't easily give per-version dates
      latestPublishedAt,
      latestVersion,
      isLatest: dep.version === latestVersion,
      isDeprecated,
      deprecationMessage: isDeprecated ? 'Package marked as inactive or no longer maintained' : null,
      daysSinceLastPublish,
      maintenanceRisk: classifyMaintenanceRisk(daysSinceLastPublish, isDeprecated),
      latestLicense,
      licenseChanged: false, // Would need per-version license data
    };
  } catch {
    return makeUnknownHealth(dep);
  }
}

function classifyMaintenanceRisk(
  daysSinceLastPublish: number | null,
  isDeprecated: boolean
): DependencyHealth['maintenanceRisk'] {
  if (isDeprecated) return 'abandoned';
  if (daysSinceLastPublish === null) return 'unknown';
  if (daysSinceLastPublish <= 90) return 'active';       // Published in last 3 months
  if (daysSinceLastPublish <= 365) return 'stable';       // Published in last year
  if (daysSinceLastPublish <= 730) return 'aging';        // 1-2 years
  if (daysSinceLastPublish <= 1095) return 'stale';       // 2-3 years
  return 'abandoned';                                      // 3+ years
}

function makeUnknownHealth(dep: Dependency): DependencyHealth {
  return {
    name: dep.name,
    version: dep.version,
    ecosystem: dep.ecosystem,
    publishedAt: null,
    latestPublishedAt: null,
    latestVersion: null,
    isLatest: false,
    isDeprecated: false,
    deprecationMessage: null,
    daysSinceLastPublish: null,
    maintenanceRisk: 'unknown',
    latestLicense: null,
    licenseChanged: false,
  };
}

/**
 * Generate a health summary section for the report.
 */
export function renderHealthSection(healthData: DependencyHealth[]): string {
  const lines: string[] = [];

  const deprecated = healthData.filter(h => h.isDeprecated);
  const abandoned = healthData.filter(h => h.maintenanceRisk === 'abandoned' && !h.isDeprecated);
  const stale = healthData.filter(h => h.maintenanceRisk === 'stale');
  const licenseChanged = healthData.filter(h => h.licenseChanged);

  if (deprecated.length === 0 && abandoned.length === 0 && stale.length === 0 && licenseChanged.length === 0) {
    lines.push(`## Dependency Health`);
    lines.push('');
    lines.push(`All dependencies appear actively maintained with no deprecation notices or license changes detected.`);
    lines.push('');
    return lines.join('\n');
  }

  lines.push(`## ⚕️ Dependency Health`);
  lines.push('');

  // Maintenance risk distribution
  const riskCounts: Record<string, number> = {};
  for (const h of healthData) {
    riskCounts[h.maintenanceRisk] = (riskCounts[h.maintenanceRisk] || 0) + 1;
  }

  lines.push(`| Status | Count | Description |`);
  lines.push(`|--------|-------|-------------|`);
  if (riskCounts.active) lines.push(`| 🟢 Active | ${riskCounts.active} | Published within 90 days |`);
  if (riskCounts.stable) lines.push(`| 🔵 Stable | ${riskCounts.stable} | Published within 1 year |`);
  if (riskCounts.aging) lines.push(`| 🟡 Aging | ${riskCounts.aging} | 1–2 years since last publish |`);
  if (riskCounts.stale) lines.push(`| 🟠 Stale | ${riskCounts.stale} | 2–3 years since last publish |`);
  if (riskCounts.abandoned) lines.push(`| 🔴 Abandoned | ${riskCounts.abandoned} | 3+ years or deprecated |`);
  if (riskCounts.unknown) lines.push(`| ❓ Unknown | ${riskCounts.unknown} | Could not determine |`);
  lines.push('');

  // Deprecated packages
  if (deprecated.length > 0) {
    lines.push(`### 🚫 Deprecated Packages (${deprecated.length})`);
    lines.push('');
    for (const d of deprecated) {
      lines.push(`- **${d.name}@${d.version}**: ${d.deprecationMessage || 'Deprecated'}`);
    }
    lines.push('');
  }

  // Abandoned packages (not deprecated but no activity in 3+ years)
  if (abandoned.length > 0) {
    lines.push(`### 🔴 Abandoned Packages (${abandoned.length})`);
    lines.push('');
    lines.push(`These packages have not been updated in over 3 years and may pose maintenance risk.`);
    lines.push('');
    for (const d of abandoned) {
      const years = d.daysSinceLastPublish ? Math.round(d.daysSinceLastPublish / 365) : '?';
      lines.push(`- **${d.name}@${d.version}** — last published ${years} year(s) ago`);
    }
    lines.push('');
  }

  // License changes between installed and latest
  if (licenseChanged.length > 0) {
    lines.push(`### ⚠️ License Changed Since Installed Version (${licenseChanged.length})`);
    lines.push('');
    lines.push(`These packages have changed their license in newer versions. Bumping the version may change your compliance posture.`);
    lines.push('');
    for (const d of licenseChanged) {
      lines.push(`- **${d.name}**: installed version has different license than latest (${d.latestVersion}): ${d.latestLicense}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

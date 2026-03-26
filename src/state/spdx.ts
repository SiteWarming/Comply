// ============================================================================
// SPDX License Database — Static license classifications
// ============================================================================

import type { LicenseInfo, LicenseTier } from '../types.js';

interface LicenseEntry {
  name: string;
  tier: LicenseTier;
  requiresAttribution: boolean;
  requiresSourceDisclosure: boolean;
  copyleft: boolean;
  networkCopyleft: boolean;
  url?: string;
}

/**
 * Comprehensive SPDX license classifications.
 * This covers the most common licenses found in open source.
 * Key: SPDX identifier (lowercase for matching)
 */
const LICENSE_DB: Record<string, LicenseEntry> = {
  // --- Permissive ---
  'mit': { name: 'MIT License', tier: 'permissive', requiresAttribution: true, requiresSourceDisclosure: false, copyleft: false, networkCopyleft: false },
  'isc': { name: 'ISC License', tier: 'permissive', requiresAttribution: true, requiresSourceDisclosure: false, copyleft: false, networkCopyleft: false },
  '0bsd': { name: 'Zero-Clause BSD', tier: 'permissive', requiresAttribution: false, requiresSourceDisclosure: false, copyleft: false, networkCopyleft: false },
  'bsd-2-clause': { name: 'BSD 2-Clause', tier: 'permissive', requiresAttribution: true, requiresSourceDisclosure: false, copyleft: false, networkCopyleft: false },
  'bsd-3-clause': { name: 'BSD 3-Clause', tier: 'permissive', requiresAttribution: true, requiresSourceDisclosure: false, copyleft: false, networkCopyleft: false },
  'apache-2.0': { name: 'Apache License 2.0', tier: 'permissive', requiresAttribution: true, requiresSourceDisclosure: false, copyleft: false, networkCopyleft: false },
  'unlicense': { name: 'The Unlicense', tier: 'permissive', requiresAttribution: false, requiresSourceDisclosure: false, copyleft: false, networkCopyleft: false },
  'cc0-1.0': { name: 'CC0 1.0 Universal', tier: 'permissive', requiresAttribution: false, requiresSourceDisclosure: false, copyleft: false, networkCopyleft: false },
  'wtfpl': { name: 'WTFPL', tier: 'permissive', requiresAttribution: false, requiresSourceDisclosure: false, copyleft: false, networkCopyleft: false },
  'zlib': { name: 'zlib License', tier: 'permissive', requiresAttribution: true, requiresSourceDisclosure: false, copyleft: false, networkCopyleft: false },
  'artistic-2.0': { name: 'Artistic License 2.0', tier: 'permissive', requiresAttribution: true, requiresSourceDisclosure: false, copyleft: false, networkCopyleft: false },
  'bsl-1.0': { name: 'Boost Software License 1.0', tier: 'permissive', requiresAttribution: true, requiresSourceDisclosure: false, copyleft: false, networkCopyleft: false },
  'python-2.0': { name: 'Python License 2.0', tier: 'permissive', requiresAttribution: true, requiresSourceDisclosure: false, copyleft: false, networkCopyleft: false },
  'x11': { name: 'X11 License', tier: 'permissive', requiresAttribution: true, requiresSourceDisclosure: false, copyleft: false, networkCopyleft: false },
  'blueoak-1.0.0': { name: 'Blue Oak Model License 1.0.0', tier: 'permissive', requiresAttribution: false, requiresSourceDisclosure: false, copyleft: false, networkCopyleft: false },
  'mpl-2.0': { name: 'Mozilla Public License 2.0', tier: 'weak_copyleft', requiresAttribution: true, requiresSourceDisclosure: true, copyleft: true, networkCopyleft: false },

  // --- Weak Copyleft ---
  'lgpl-2.0-only': { name: 'LGPL 2.0', tier: 'weak_copyleft', requiresAttribution: true, requiresSourceDisclosure: true, copyleft: true, networkCopyleft: false },
  'lgpl-2.1-only': { name: 'LGPL 2.1', tier: 'weak_copyleft', requiresAttribution: true, requiresSourceDisclosure: true, copyleft: true, networkCopyleft: false },
  'lgpl-2.1': { name: 'LGPL 2.1', tier: 'weak_copyleft', requiresAttribution: true, requiresSourceDisclosure: true, copyleft: true, networkCopyleft: false },
  'lgpl-2.1-or-later': { name: 'LGPL 2.1+', tier: 'weak_copyleft', requiresAttribution: true, requiresSourceDisclosure: true, copyleft: true, networkCopyleft: false },
  'lgpl-3.0-only': { name: 'LGPL 3.0', tier: 'weak_copyleft', requiresAttribution: true, requiresSourceDisclosure: true, copyleft: true, networkCopyleft: false },
  'lgpl-3.0': { name: 'LGPL 3.0', tier: 'weak_copyleft', requiresAttribution: true, requiresSourceDisclosure: true, copyleft: true, networkCopyleft: false },
  'lgpl-3.0-or-later': { name: 'LGPL 3.0+', tier: 'weak_copyleft', requiresAttribution: true, requiresSourceDisclosure: true, copyleft: true, networkCopyleft: false },
  'epl-1.0': { name: 'Eclipse Public License 1.0', tier: 'weak_copyleft', requiresAttribution: true, requiresSourceDisclosure: true, copyleft: true, networkCopyleft: false },
  'epl-2.0': { name: 'Eclipse Public License 2.0', tier: 'weak_copyleft', requiresAttribution: true, requiresSourceDisclosure: true, copyleft: true, networkCopyleft: false },
  'cpl-1.0': { name: 'Common Public License 1.0', tier: 'weak_copyleft', requiresAttribution: true, requiresSourceDisclosure: true, copyleft: true, networkCopyleft: false },
  'cecill-2.1': { name: 'CeCILL 2.1', tier: 'weak_copyleft', requiresAttribution: true, requiresSourceDisclosure: true, copyleft: true, networkCopyleft: false },
  'eupl-1.1': { name: 'European Union Public License 1.1', tier: 'weak_copyleft', requiresAttribution: true, requiresSourceDisclosure: true, copyleft: true, networkCopyleft: false },
  'eupl-1.2': { name: 'European Union Public License 1.2', tier: 'weak_copyleft', requiresAttribution: true, requiresSourceDisclosure: true, copyleft: true, networkCopyleft: false },

  // --- Strong Copyleft ---
  'gpl-2.0-only': { name: 'GPL 2.0', tier: 'strong_copyleft', requiresAttribution: true, requiresSourceDisclosure: true, copyleft: true, networkCopyleft: false },
  'gpl-2.0': { name: 'GPL 2.0', tier: 'strong_copyleft', requiresAttribution: true, requiresSourceDisclosure: true, copyleft: true, networkCopyleft: false },
  'gpl-2.0-or-later': { name: 'GPL 2.0+', tier: 'strong_copyleft', requiresAttribution: true, requiresSourceDisclosure: true, copyleft: true, networkCopyleft: false },
  'gpl-3.0-only': { name: 'GPL 3.0', tier: 'strong_copyleft', requiresAttribution: true, requiresSourceDisclosure: true, copyleft: true, networkCopyleft: false },
  'gpl-3.0': { name: 'GPL 3.0', tier: 'strong_copyleft', requiresAttribution: true, requiresSourceDisclosure: true, copyleft: true, networkCopyleft: false },
  'gpl-3.0-or-later': { name: 'GPL 3.0+', tier: 'strong_copyleft', requiresAttribution: true, requiresSourceDisclosure: true, copyleft: true, networkCopyleft: false },

  // --- Network Copyleft ---
  'agpl-3.0-only': { name: 'AGPL 3.0', tier: 'network_copyleft', requiresAttribution: true, requiresSourceDisclosure: true, copyleft: true, networkCopyleft: true },
  'agpl-3.0': { name: 'AGPL 3.0', tier: 'network_copyleft', requiresAttribution: true, requiresSourceDisclosure: true, copyleft: true, networkCopyleft: true },
  'agpl-3.0-or-later': { name: 'AGPL 3.0+', tier: 'network_copyleft', requiresAttribution: true, requiresSourceDisclosure: true, copyleft: true, networkCopyleft: true },
  'sspl-1.0': { name: 'Server Side Public License 1.0', tier: 'network_copyleft', requiresAttribution: true, requiresSourceDisclosure: true, copyleft: true, networkCopyleft: true },

  // --- Creative Commons ---
  'cc-by-4.0': { name: 'CC BY 4.0', tier: 'permissive', requiresAttribution: true, requiresSourceDisclosure: false, copyleft: false, networkCopyleft: false },
  'cc-by-3.0': { name: 'CC BY 3.0', tier: 'permissive', requiresAttribution: true, requiresSourceDisclosure: false, copyleft: false, networkCopyleft: false },
  'cc-by-sa-4.0': { name: 'CC BY-SA 4.0', tier: 'weak_copyleft', requiresAttribution: true, requiresSourceDisclosure: false, copyleft: true, networkCopyleft: false },
  'cc-by-nc-4.0': { name: 'CC BY-NC 4.0', tier: 'non_commercial', requiresAttribution: true, requiresSourceDisclosure: false, copyleft: false, networkCopyleft: false },
  'cc-by-nc-sa-4.0': { name: 'CC BY-NC-SA 4.0', tier: 'non_commercial', requiresAttribution: true, requiresSourceDisclosure: false, copyleft: true, networkCopyleft: false },
  'cc-by-nc-nd-4.0': { name: 'CC BY-NC-ND 4.0', tier: 'non_commercial', requiresAttribution: true, requiresSourceDisclosure: false, copyleft: false, networkCopyleft: false },

  // --- Proprietary / Restrictive ---
  'busl-1.1': { name: 'Business Source License 1.1', tier: 'proprietary', requiresAttribution: true, requiresSourceDisclosure: false, copyleft: false, networkCopyleft: false },
  'elastic-2.0': { name: 'Elastic License 2.0', tier: 'proprietary', requiresAttribution: true, requiresSourceDisclosure: false, copyleft: false, networkCopyleft: false },
};

// Common aliases and variations
const LICENSE_ALIASES: Record<string, string> = {
  'bsd': 'bsd-2-clause',
  'bsd-2': 'bsd-2-clause',
  'bsd-3': 'bsd-3-clause',
  'new bsd': 'bsd-3-clause',
  'simplified bsd': 'bsd-2-clause',
  'gpl': 'gpl-3.0',
  'gplv2': 'gpl-2.0',
  'gplv3': 'gpl-3.0',
  'gpl-2': 'gpl-2.0',
  'gpl-3': 'gpl-3.0',
  'gpl v2': 'gpl-2.0',
  'gpl v3': 'gpl-3.0',
  'lgpl': 'lgpl-3.0',
  'lgplv2': 'lgpl-2.1',
  'lgplv3': 'lgpl-3.0',
  'lgpl-2': 'lgpl-2.1',
  'agpl': 'agpl-3.0',
  'agplv3': 'agpl-3.0',
  'apache': 'apache-2.0',
  'apache2': 'apache-2.0',
  'apache 2': 'apache-2.0',
  'apache-2': 'apache-2.0',
  'mpl': 'mpl-2.0',
  'mplv2': 'mpl-2.0',
  'epl': 'epl-2.0',
  'cc0': 'cc0-1.0',
  'cc-by': 'cc-by-4.0',
  'public domain': 'unlicense',
  'boost': 'bsl-1.0',
  'mit/x11': 'mit',
  'x11/mit': 'mit',
  'python-2.0': 'python-2.0',
  'python': 'python-2.0',
  'psf-2.0': 'python-2.0',
};

/**
 * Resolve a raw license string to structured LicenseInfo.
 * Handles SPDX identifiers, common aliases, and SPDX expressions.
 */
export function classifyLicense(rawLicense: string): LicenseInfo {
  if (!rawLicense || rawLicense.trim() === '') {
    return makeUnknown('No license specified');
  }

  const trimmed = rawLicense.trim();
  const normalized = trimmed.toLowerCase();

  // Skip non-license markers
  if (isNonLicense(normalized)) {
    return makeUnknown(trimmed);
  }

  // Strip outer parentheses first so "(CC-BY-4.0 AND MIT)" → "CC-BY-4.0 AND MIT"
  if (normalized.startsWith('(') && normalized.endsWith(')')) {
    return classifyLicense(trimmed.slice(1, -1));
  }

  // Handle SPDX expressions BEFORE single-license lookup — these contain spaces
  // that would otherwise not match the DB
  if (normalized.includes(' or ') || normalized.includes(' and ')) {
    return classifySpdxExpression(trimmed);
  }

  // Handle "/" as OR (e.g., "MIT/X11", "Apache-2.0/MIT")
  if (normalized.includes('/')) {
    // Check alias first (e.g., "MIT/X11" is a known alias)
    if (LICENSE_ALIASES[normalized]) {
      const spdxId = LICENSE_ALIASES[normalized];
      if (LICENSE_DB[spdxId]) {
        return toLicenseInfo(spdxId, LICENSE_DB[spdxId]);
      }
    }
    // Otherwise treat as OR expression
    const parts = trimmed.split('/').map(p => p.trim()).filter(Boolean);
    if (parts.length > 1) {
      return classifySpdxExpression(parts.join(' OR '));
    }
  }

  // Direct SPDX lookup
  if (LICENSE_DB[normalized]) {
    return toLicenseInfo(normalized, LICENSE_DB[normalized]);
  }

  // Alias lookup
  if (LICENSE_ALIASES[normalized]) {
    const spdxId = LICENSE_ALIASES[normalized];
    if (LICENSE_DB[spdxId]) {
      return toLicenseInfo(spdxId, LICENSE_DB[spdxId]);
    }
  }

  // Try removing common suffixes/prefixes
  const cleaned = normalized
    .replace(/^the\s+/, '')
    .replace(/\s+license$/i, '')
    .replace(/\s+/g, '-');

  if (LICENSE_DB[cleaned]) {
    return toLicenseInfo(cleaned, LICENSE_DB[cleaned]);
  }
  if (LICENSE_ALIASES[cleaned]) {
    const spdxId = LICENSE_ALIASES[cleaned];
    if (LICENSE_DB[spdxId]) {
      return toLicenseInfo(spdxId, LICENSE_DB[spdxId]);
    }
  }

  return makeUnknown(trimmed);
}

/**
 * Detect non-license strings that registries sometimes return.
 */
function isNonLicense(normalized: string): boolean {
  return normalized === 'none' ||
    normalized === 'unlicensed' ||
    normalized.startsWith('see license in ') ||
    (normalized.startsWith('see ') && normalized.includes('license')) ||
    normalized === 'custom' ||
    normalized === 'proprietary';
}

function classifySpdxExpression(expression: string): LicenseInfo {
  const normalized = expression.toLowerCase();
  const tierOrder: LicenseTier[] = ['permissive', 'weak_copyleft', 'strong_copyleft', 'network_copyleft', 'non_commercial', 'proprietary', 'unknown'];

  // OR expressions: take the most permissive option
  if (normalized.includes(' or ')) {
    const parts = normalized.split(/\s+or\s+/).map(p => p.replace(/[()]/g, '').trim());
    const classified = parts.map(p => classifyLicense(p));
    const known = classified.filter(c => c.tier !== 'unknown');
    const pool = known.length > 0 ? known : classified;
    pool.sort((a, b) => tierOrder.indexOf(a.tier) - tierOrder.indexOf(b.tier));
    const best = pool[0];
    return {
      ...best,
      spdxId: expression,
      name: `${expression} (choosing: ${best.name})`,
    };
  }

  // AND expressions: take the most restrictive (ignoring unknown components)
  if (normalized.includes(' and ')) {
    const parts = normalized.split(/\s+and\s+/).map(p => p.replace(/[()]/g, '').trim());
    const classified = parts.map(p => classifyLicense(p));
    const known = classified.filter(c => c.tier !== 'unknown');
    if (known.length === 0) {
      return makeUnknown(expression);
    }
    known.sort((a, b) => tierOrder.indexOf(b.tier) - tierOrder.indexOf(a.tier));
    const worst = known[0];
    // Merge obligations from all known components
    const requiresAttribution = known.some(c => c.requiresAttribution);
    const requiresSourceDisclosure = known.some(c => c.requiresSourceDisclosure);
    const copyleft = known.some(c => c.copyleft);
    const networkCopyleft = known.some(c => c.networkCopyleft);
    return {
      spdxId: expression,
      name: `${expression} (most restrictive: ${worst.name})`,
      tier: worst.tier,
      requiresAttribution,
      requiresSourceDisclosure,
      copyleft,
      networkCopyleft,
    };
  }

  return makeUnknown(expression);
}

function toLicenseInfo(spdxId: string, entry: LicenseEntry): LicenseInfo {
  return {
    spdxId: spdxId.toUpperCase(),
    name: entry.name,
    tier: entry.tier,
    requiresAttribution: entry.requiresAttribution,
    requiresSourceDisclosure: entry.requiresSourceDisclosure,
    copyleft: entry.copyleft,
    networkCopyleft: entry.networkCopyleft,
    url: entry.url,
  };
}

function makeUnknown(raw: string): LicenseInfo {
  return {
    spdxId: null,
    name: `Unknown (${raw})`,
    tier: 'unknown',
    requiresAttribution: false,
    requiresSourceDisclosure: false,
    copyleft: false,
    networkCopyleft: false,
  };
}

/**
 * Returns the risk tier for a given SPDX ID.
 */
export function getSeverityForLicense(spdxId: string): 'critical' | 'high' | 'medium' | 'low' | 'none' {
  const norm = spdxId.toLowerCase();
  const entry = LICENSE_DB[norm];
  if (!entry) return 'medium'; // unknown = medium risk

  switch (entry.tier) {
    case 'network_copyleft': return 'critical';
    case 'strong_copyleft': return 'high';
    case 'non_commercial': return 'high';
    case 'proprietary': return 'high';
    case 'weak_copyleft': return 'medium';
    case 'permissive': return 'none';
    default: return 'medium';
  }
}

export { LICENSE_DB, LICENSE_ALIASES };

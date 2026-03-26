// ============================================================================
// Resolution — Resolve licenses for dependencies from registries + cache
// ============================================================================

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { classifyLicense } from '../state/spdx.js';
import type { Dependency, ResolvedLicense } from '../types.js';

interface CacheEntry {
  license: string;
  resolvedAt: string;
  source: string;
}

/**
 * Resolve licenses for a list of dependencies.
 * Uses registry APIs with a file-based cache to avoid repeated lookups.
 */
export async function resolveLicenses(
  dependencies: Dependency[],
  cacheDir: string,
  opts?: { verbose?: boolean }
): Promise<ResolvedLicense[]> {
  const results: ResolvedLicense[] = [];
  const batchSize = 10; // Parallel requests

  for (let i = 0; i < dependencies.length; i += batchSize) {
    const batch = dependencies.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(dep => resolveSingleLicense(dep, cacheDir, opts?.verbose))
    );
    results.push(...batchResults);
  }

  return results;
}

async function resolveSingleLicense(
  dep: Dependency,
  cacheDir: string,
  verbose?: boolean
): Promise<ResolvedLicense> {
  // Check cache first
  const cached = await readCache(dep, cacheDir);
  if (cached) {
    const validSources: Set<ResolvedLicense['resolvedVia']> = new Set(['registry', 'github', 'license-file', 'spdx-expression', 'manual', 'unknown']);
    return {
      dependency: dep,
      license: classifyLicense(cached.license),
      resolvedVia: validSources.has(cached.source as ResolvedLicense['resolvedVia']) ? cached.source as ResolvedLicense['resolvedVia'] : 'unknown',
      confidence: 0.9,
      rawLicense: cached.license,
    };
  }

  // Resolve from registry
  let rawLicense = '';
  let resolvedVia: ResolvedLicense['resolvedVia'] = 'unknown';
  let confidence = 0;

  try {
    switch (dep.ecosystem) {
      case 'npm': {
        const result = await resolveFromNpm(dep.name, dep.version);
        rawLicense = result.license;
        resolvedVia = 'registry';
        confidence = result.confidence;
        break;
      }
      case 'python': {
        const result = await resolveFromPyPI(dep.name);
        rawLicense = result.license;
        resolvedVia = 'registry';
        confidence = result.confidence;
        break;
      }
      default:
        rawLicense = '';
        resolvedVia = 'unknown';
        confidence = 0;
    }
  } catch (err) {
    if (verbose) {
      console.warn(`  Warning: Failed to resolve license for ${dep.name}: ${(err as Error).message}`);
    }
  }

  // Cache the result
  if (rawLicense) {
    await writeCache(dep, cacheDir, {
      license: rawLicense,
      resolvedAt: new Date().toISOString(),
      source: resolvedVia,
    });
  }

  return {
    dependency: dep,
    license: classifyLicense(rawLicense),
    resolvedVia,
    confidence,
    rawLicense,
  };
}

// ---- npm Registry ----

async function resolveFromNpm(name: string, version: string): Promise<{ license: string; confidence: number }> {
  // Try specific version first, fall back to latest
  const urls = [
    `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`,
    `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`,
    `https://registry.npmjs.org/${encodeURIComponent(name)}`,
  ];

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) continue;
      const data = await response.json() as any;

      // npm packages can have license as string or object
      if (data.license) {
        const license = typeof data.license === 'string'
          ? data.license
          : data.license.type || data.license.name || '';
        if (license) {
          return { license, confidence: 0.95 };
        }
      }

      // Fall back to licenses array (older format)
      if (data.licenses && Array.isArray(data.licenses) && data.licenses.length > 0) {
        const license = data.licenses.map((l: any) => l.type || l.name || '').filter(Boolean).join(' OR ');
        if (license) {
          return { license, confidence: 0.85 };
        }
      }

      // If this is the full package doc (not a version), check latest version
      if (data['dist-tags']?.latest && data.versions) {
        const latestVersion = data['dist-tags'].latest;
        const latestData = data.versions[latestVersion];
        if (latestData?.license) {
          const license = typeof latestData.license === 'string'
            ? latestData.license
            : latestData.license.type || latestData.license.name || '';
          if (license) {
            return { license, confidence: 0.9 };
          }
        }
      }
    } catch {
      continue;
    }
  }

  return { license: '', confidence: 0 };
}

// ---- PyPI Registry ----

async function resolveFromPyPI(name: string): Promise<{ license: string; confidence: number }> {
  try {
    const response = await fetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return { license: '', confidence: 0 };

    const data = await response.json() as any;
    const info = data.info;

    // Check license field
    if (info?.license && info.license !== 'UNKNOWN' && info.license.length < 100) {
      return { license: info.license, confidence: 0.9 };
    }

    // Check classifiers for license
    if (info?.classifiers) {
      const licenseClassifiers = info.classifiers.filter((c: string) =>
        c.startsWith('License :: OSI Approved ::')
      );
      if (licenseClassifiers.length > 0) {
        const license = licenseClassifiers[0]
          .replace('License :: OSI Approved :: ', '')
          .replace(' License', '');
        return { license, confidence: 0.8 };
      }
    }
  } catch {
    // Silently fail
  }

  return { license: '', confidence: 0 };
}

// ---- Cache Layer ----

function getCachePath(dep: Dependency, cacheDir: string): string {
  const safeEcosystem = dep.ecosystem;
  const safeName = dep.name.replace(/\//g, '__');
  return join(cacheDir, safeEcosystem, `${safeName}.json`);
}

async function readCache(dep: Dependency, cacheDir: string): Promise<CacheEntry | null> {
  try {
    const path = getCachePath(dep, cacheDir);
    const content = await readFile(path, 'utf-8');
    const entry = JSON.parse(content) as CacheEntry;

    // Cache entries expire after 30 days
    const age = Date.now() - new Date(entry.resolvedAt).getTime();
    if (age > 30 * 24 * 60 * 60 * 1000) return null;

    return entry;
  } catch {
    return null;
  }
}

async function writeCache(dep: Dependency, cacheDir: string, entry: CacheEntry): Promise<void> {
  try {
    const path = getCachePath(dep, cacheDir);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(entry, null, 2));
  } catch {
    // Cache write failures are non-fatal
  }
}

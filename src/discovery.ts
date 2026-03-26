// ============================================================================
// Discovery — Find all package manifest and lock files in a repo
// ============================================================================

import { readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { ManifestFile, Ecosystem } from './types.js';

/** Map of filename patterns to ecosystem + type */
const MANIFEST_PATTERNS: Array<{
  filename: string;
  ecosystem: Ecosystem;
  type: 'manifest' | 'lockfile';
}> = [
  // npm / Node.js
  { filename: 'package.json', ecosystem: 'npm', type: 'manifest' },
  { filename: 'package-lock.json', ecosystem: 'npm', type: 'lockfile' },
  { filename: 'yarn.lock', ecosystem: 'npm', type: 'lockfile' },
  { filename: 'pnpm-lock.yaml', ecosystem: 'npm', type: 'lockfile' },
  { filename: 'bun.lockb', ecosystem: 'npm', type: 'lockfile' },

  // Python
  { filename: 'requirements.txt', ecosystem: 'python', type: 'manifest' },
  { filename: 'Pipfile', ecosystem: 'python', type: 'manifest' },
  { filename: 'Pipfile.lock', ecosystem: 'python', type: 'lockfile' },
  { filename: 'pyproject.toml', ecosystem: 'python', type: 'manifest' },
  { filename: 'setup.py', ecosystem: 'python', type: 'manifest' },
  { filename: 'setup.cfg', ecosystem: 'python', type: 'manifest' },
  { filename: 'poetry.lock', ecosystem: 'python', type: 'lockfile' },

  // Go
  { filename: 'go.mod', ecosystem: 'go', type: 'manifest' },
  { filename: 'go.sum', ecosystem: 'go', type: 'lockfile' },

  // Rust
  { filename: 'Cargo.toml', ecosystem: 'rust', type: 'manifest' },
  { filename: 'Cargo.lock', ecosystem: 'rust', type: 'lockfile' },

  // Java
  { filename: 'pom.xml', ecosystem: 'java', type: 'manifest' },
  { filename: 'build.gradle', ecosystem: 'java', type: 'manifest' },
  { filename: 'build.gradle.kts', ecosystem: 'java', type: 'manifest' },

  // Ruby
  { filename: 'Gemfile', ecosystem: 'ruby', type: 'manifest' },
  { filename: 'Gemfile.lock', ecosystem: 'ruby', type: 'lockfile' },

  // .NET
  { filename: 'packages.config', ecosystem: 'dotnet', type: 'manifest' },

  // PHP
  { filename: 'composer.json', ecosystem: 'php', type: 'manifest' },
  { filename: 'composer.lock', ecosystem: 'php', type: 'lockfile' },
];

/** Directories to skip during traversal */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'vendor',
  'dist',
  'build',
  '__pycache__',
  '.tox',
  '.venv',
  'venv',
  'env',
  '.env',
  'target',        // Rust/Java build output
  '.gradle',
  '.idea',
  '.vscode',
  '.license-audit', // Our own audit directory
  '.comply',
]);

/**
 * Recursively discover all manifest and lock files in a repository.
 */
export async function discoverManifests(
  repoPath: string,
  opts?: { ecosystems?: Ecosystem[]; maxDepth?: number }
): Promise<ManifestFile[]> {
  const manifests: ManifestFile[] = [];
  const maxDepth = opts?.maxDepth ?? 10;
  const allowedEcosystems = opts?.ecosystems ? new Set(opts.ecosystems) : null;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // Skip inaccessible directories
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.comply')) {
          await walk(fullPath, depth + 1);
        }
        continue;
      }

      if (entry.isFile()) {
        const match = MANIFEST_PATTERNS.find(p => p.filename === entry.name);
        if (match) {
          if (allowedEcosystems && !allowedEcosystems.has(match.ecosystem)) {
            continue;
          }

          // For .csproj files we need glob matching, handle separately
          manifests.push({
            path: fullPath,
            ecosystem: match.ecosystem,
            type: match.type,
          });
        }

        // Handle .csproj files (glob pattern)
        if (entry.name.endsWith('.csproj')) {
          if (!allowedEcosystems || allowedEcosystems.has('dotnet')) {
            manifests.push({
              path: fullPath,
              ecosystem: 'dotnet',
              type: 'manifest',
            });
          }
        }
      }
    }
  }

  await walk(repoPath, 0);

  return manifests;
}

/**
 * Get a summary of discovered ecosystems.
 */
export function summarizeDiscovery(manifests: ManifestFile[]): Record<Ecosystem, { manifests: number; lockfiles: number }> {
  const summary: Record<string, { manifests: number; lockfiles: number }> = {};

  for (const m of manifests) {
    if (!summary[m.ecosystem]) {
      summary[m.ecosystem] = { manifests: 0, lockfiles: 0 };
    }
    if (m.type === 'manifest') {
      summary[m.ecosystem].manifests++;
    } else {
      summary[m.ecosystem].lockfiles++;
    }
  }

  return summary as Record<Ecosystem, { manifests: number; lockfiles: number }>;
}

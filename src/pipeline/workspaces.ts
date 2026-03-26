// ============================================================================
// Workspaces — Monorepo workspace detection and scoping
// ============================================================================
//
// A monorepo with packages/api + packages/cli + packages/internal-tools
// has three different compliance surfaces. GPL in the CLI is a problem.
// GPL in internal tools is fine. This module detects workspace structure
// and scopes dependencies to their containing workspace.
// ============================================================================

import { readFile, stat } from 'node:fs/promises';
import { join, dirname, relative, basename } from 'node:path';
import type { Dependency, ManifestFile, DistributionModel } from '../types.js';

export interface Workspace {
  name: string;
  path: string;
  /** Relative path from repo root */
  relativePath: string;
  /** Whether this is the root workspace */
  isRoot: boolean;
  /** Distribution model override for this workspace */
  distributionModel?: DistributionModel;
  /** Manifest files belonging to this workspace */
  manifests: ManifestFile[];
  /** Dependencies scoped to this workspace */
  dependencies: Dependency[];
}

export interface WorkspaceConfig {
  /** Whether this is a monorepo */
  isMonorepo: boolean;
  /** What tool manages the workspaces */
  tool: 'npm' | 'yarn' | 'pnpm' | 'lerna' | 'nx' | 'turborepo' | 'none';
  /** Detected workspaces */
  workspaces: Workspace[];
}

/**
 * Detect workspace structure in a repository.
 * Returns a single workspace for non-monorepo projects.
 */
export async function detectWorkspaces(
  repoPath: string,
  manifests: ManifestFile[]
): Promise<WorkspaceConfig> {
  // Try each workspace tool in order of popularity
  const detectors: Array<() => Promise<WorkspaceConfig | null>> = [
    () => detectNpmWorkspaces(repoPath, manifests),
    () => detectPnpmWorkspaces(repoPath, manifests),
    () => detectLernaWorkspaces(repoPath, manifests),
    () => detectNxWorkspaces(repoPath, manifests),
    () => detectTurborepoWorkspaces(repoPath, manifests),
  ];

  for (const detect of detectors) {
    try {
      const result = await detect();
      if (result && result.isMonorepo) {
        return result;
      }
    } catch {
      // Try next detector
    }
  }

  // Not a monorepo — return single workspace
  return {
    isMonorepo: false,
    tool: 'none',
    workspaces: [{
      name: basename(repoPath),
      path: repoPath,
      relativePath: '.',
      isRoot: true,
      manifests,
      dependencies: [],
    }],
  };
}

/**
 * Scope dependencies to their containing workspace.
 */
export function scopeDependenciesToWorkspaces(
  workspaceConfig: WorkspaceConfig,
  allDependencies: Dependency[]
): WorkspaceConfig {
  if (!workspaceConfig.isMonorepo) {
    // Non-monorepo: all deps belong to the single workspace
    workspaceConfig.workspaces[0].dependencies = allDependencies;
    return workspaceConfig;
  }

  for (const workspace of workspaceConfig.workspaces) {
    const workspaceManifestPaths = new Set(workspace.manifests.map(m => m.path));

    workspace.dependencies = allDependencies.filter(dep =>
      workspaceManifestPaths.has(dep.source)
    );
  }

  // Any deps not claimed by a workspace go to root
  const claimedDeps = new Set(
    workspaceConfig.workspaces.flatMap(w => w.dependencies.map(d => `${d.name}@${d.version}`))
  );

  const rootWorkspace = workspaceConfig.workspaces.find(w => w.isRoot);
  if (rootWorkspace) {
    const unclaimed = allDependencies.filter(d => !claimedDeps.has(`${d.name}@${d.version}`));
    rootWorkspace.dependencies.push(...unclaimed);
  }

  return workspaceConfig;
}

/**
 * Render workspace info for the report.
 */
export function renderWorkspaceSection(config: WorkspaceConfig): string {
  if (!config.isMonorepo) return '';

  const lines: string[] = [];
  lines.push(`## 📦 Monorepo Structure`);
  lines.push('');
  lines.push(`**Workspace Tool:** ${config.tool}`);
  lines.push(`**Workspaces:** ${config.workspaces.length}`);
  lines.push('');
  lines.push(`| Workspace | Path | Dependencies | Distribution |`);
  lines.push(`|-----------|------|-------------|-------------|`);

  for (const ws of config.workspaces) {
    const dist = ws.distributionModel || 'default';
    const flag = ws.isRoot ? ' (root)' : '';
    lines.push(`| ${ws.name}${flag} | ${ws.relativePath} | ${ws.dependencies.length} | ${dist} |`);
  }

  lines.push('');
  lines.push(`> Compliance is evaluated per-workspace when distribution model overrides are configured in the policy file.`);
  lines.push('');

  return lines.join('\n');
}

// ---- Workspace Detectors ----

async function detectNpmWorkspaces(
  repoPath: string,
  manifests: ManifestFile[]
): Promise<WorkspaceConfig | null> {
  const rootPkgPath = join(repoPath, 'package.json');
  try {
    const content = await readFile(rootPkgPath, 'utf-8');
    const pkg = JSON.parse(content);

    if (!pkg.workspaces) return null;

    const workspaceGlobs: string[] = Array.isArray(pkg.workspaces)
      ? pkg.workspaces
      : (pkg.workspaces.packages || []);

    if (workspaceGlobs.length === 0) return null;

    const workspaces = await resolveWorkspaceGlobs(repoPath, workspaceGlobs, manifests);

    // Add root workspace
    const rootManifests = manifests.filter(m => dirname(m.path) === repoPath);
    workspaces.unshift({
      name: pkg.name || basename(repoPath),
      path: repoPath,
      relativePath: '.',
      isRoot: true,
      manifests: rootManifests,
      dependencies: [],
    });

    return {
      isMonorepo: true,
      tool: 'npm',
      workspaces,
    };
  } catch {
    return null;
  }
}

async function detectPnpmWorkspaces(
  repoPath: string,
  manifests: ManifestFile[]
): Promise<WorkspaceConfig | null> {
  const pnpmPath = join(repoPath, 'pnpm-workspace.yaml');
  try {
    const content = await readFile(pnpmPath, 'utf-8');
    // Basic YAML parse for packages field
    const match = content.match(/packages:\s*\n((?:\s+-\s+.+\n?)+)/);
    if (!match) return null;

    const globs = match[1]
      .split('\n')
      .map(line => line.replace(/^\s+-\s+['"]?/, '').replace(/['"]?\s*$/, ''))
      .filter(Boolean);

    const workspaces = await resolveWorkspaceGlobs(repoPath, globs, manifests);

    const rootManifests = manifests.filter(m => dirname(m.path) === repoPath);
    workspaces.unshift({
      name: basename(repoPath),
      path: repoPath,
      relativePath: '.',
      isRoot: true,
      manifests: rootManifests,
      dependencies: [],
    });

    return {
      isMonorepo: true,
      tool: 'pnpm',
      workspaces,
    };
  } catch {
    return null;
  }
}

async function detectLernaWorkspaces(
  repoPath: string,
  manifests: ManifestFile[]
): Promise<WorkspaceConfig | null> {
  const lernaPath = join(repoPath, 'lerna.json');
  try {
    const content = await readFile(lernaPath, 'utf-8');
    const lerna = JSON.parse(content);
    const globs: string[] = lerna.packages || ['packages/*'];

    const workspaces = await resolveWorkspaceGlobs(repoPath, globs, manifests);

    const rootManifests = manifests.filter(m => dirname(m.path) === repoPath);
    workspaces.unshift({
      name: basename(repoPath),
      path: repoPath,
      relativePath: '.',
      isRoot: true,
      manifests: rootManifests,
      dependencies: [],
    });

    return {
      isMonorepo: true,
      tool: 'lerna',
      workspaces,
    };
  } catch {
    return null;
  }
}

async function detectNxWorkspaces(
  repoPath: string,
  manifests: ManifestFile[]
): Promise<WorkspaceConfig | null> {
  const nxPath = join(repoPath, 'nx.json');
  try {
    await stat(nxPath);
    // Nx exists — workspace dirs are typically apps/ and libs/
    const workspaces = await resolveWorkspaceGlobs(repoPath, ['apps/*', 'libs/*', 'packages/*'], manifests);

    if (workspaces.length === 0) return null;

    const rootManifests = manifests.filter(m => dirname(m.path) === repoPath);
    workspaces.unshift({
      name: basename(repoPath),
      path: repoPath,
      relativePath: '.',
      isRoot: true,
      manifests: rootManifests,
      dependencies: [],
    });

    return {
      isMonorepo: true,
      tool: 'nx',
      workspaces,
    };
  } catch {
    return null;
  }
}

async function detectTurborepoWorkspaces(
  repoPath: string,
  manifests: ManifestFile[]
): Promise<WorkspaceConfig | null> {
  const turboPath = join(repoPath, 'turbo.json');
  try {
    await stat(turboPath);
    // Turborepo uses npm/pnpm/yarn workspaces under the hood
    // Try npm workspaces detection
    return detectNpmWorkspaces(repoPath, manifests);
  } catch {
    return null;
  }
}

// ---- Workspace Resolution ----

async function resolveWorkspaceGlobs(
  repoPath: string,
  globs: string[],
  manifests: ManifestFile[]
): Promise<Workspace[]> {
  const workspaces: Workspace[] = [];

  // For each manifest that isn't in the root, check if it matches a workspace glob
  for (const manifest of manifests) {
    const manifestDir = dirname(manifest.path);
    if (manifestDir === repoPath) continue; // Skip root

    const relPath = relative(repoPath, manifestDir);

    // Check if this path matches any workspace glob
    const matches = globs.some(glob => {
      // Convert simple globs to regex: packages/* → packages/[^/]+
      const pattern = glob
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]+');
      return new RegExp(`^${pattern}$`).test(relPath);
    });

    if (!matches) continue;

    // Check if we already have this workspace
    const existing = workspaces.find(w => w.path === manifestDir);
    if (existing) {
      existing.manifests.push(manifest);
      continue;
    }

    // Try to get workspace name from its package.json
    let wsName = basename(manifestDir);
    if (manifest.ecosystem === 'npm' && manifest.type === 'manifest') {
      try {
        const content = await readFile(manifest.path, 'utf-8');
        const pkg = JSON.parse(content);
        if (pkg.name) wsName = pkg.name;
      } catch {
        // Use directory name
      }
    }

    workspaces.push({
      name: wsName,
      path: manifestDir,
      relativePath: relPath,
      isRoot: false,
      manifests: [manifest],
      dependencies: [],
    });
  }

  return workspaces;
}

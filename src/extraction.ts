// ============================================================================
// Extraction — Parse manifest files and extract dependency lists
// ============================================================================

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Dependency, Ecosystem, ManifestFile } from './types.js';

/**
 * Extract all dependencies from discovered manifest files.
 * Currently fully supports npm. Other ecosystems have basic support.
 */
export async function extractDependencies(manifests: ManifestFile[]): Promise<Dependency[]> {
  const allDeps: Dependency[] = [];
  const seen = new Set<string>();

  for (const manifest of manifests) {
    try {
      const deps = await parseManifest(manifest);
      for (const dep of deps) {
        const key = `${dep.ecosystem}:${dep.name}@${dep.version}`;
        if (!seen.has(key)) {
          seen.add(key);
          allDeps.push(dep);
        }
      }
    } catch (err) {
      // Log but don't fail on individual parse errors
      console.warn(`  Warning: Failed to parse ${manifest.path}: ${(err as Error).message}`);
    }
  }

  return allDeps;
}

async function parseManifest(manifest: ManifestFile): Promise<Dependency[]> {
  switch (manifest.ecosystem) {
    case 'npm':
      return parseNpm(manifest);
    case 'python':
      return parsePython(manifest);
    case 'go':
      return parseGo(manifest);
    case 'rust':
      return parseRust(manifest);
    default:
      return [];
  }
}

// ---- npm Parser ----

async function parseNpm(manifest: ManifestFile): Promise<Dependency[]> {
  const filename = basename(manifest.path);

  if (filename === 'package.json') {
    return parsePackageJson(manifest.path);
  }
  if (filename === 'package-lock.json') {
    return parsePackageLockJson(manifest.path);
  }

  return [];
}

async function parsePackageJson(filePath: string): Promise<Dependency[]> {
  const content = await readFile(filePath, 'utf-8');
  const pkg = JSON.parse(content);
  const deps: Dependency[] = [];

  const addDeps = (section: Record<string, string> | undefined, isDirect: boolean) => {
    if (!section) return;
    for (const [name, version] of Object.entries(section)) {
      deps.push({
        name,
        version: cleanVersion(version),
        ecosystem: 'npm',
        isDirect,
        source: filePath,
      });
    }
  };

  addDeps(pkg.dependencies, true);
  addDeps(pkg.devDependencies, true);
  // Note: we include devDeps because they can still pose license issues
  // (e.g., if bundled, or in some interpretations of distribution)
  // The policy engine can filter them out if configured to

  return deps;
}

async function parsePackageLockJson(filePath: string): Promise<Dependency[]> {
  const content = await readFile(filePath, 'utf-8');
  const lockfile = JSON.parse(content);
  const deps: Dependency[] = [];

  // v2/v3 lockfile format (packages field)
  if (lockfile.packages) {
    for (const [pkgPath, info] of Object.entries(lockfile.packages as Record<string, any>)) {
      // Skip the root package (empty string key)
      if (!pkgPath || pkgPath === '') continue;

      // Extract package name from path (node_modules/foo or node_modules/@scope/foo)
      const parts = pkgPath.replace(/^node_modules\//, '').split('node_modules/');
      const name = parts[parts.length - 1];

      if (name && info.version) {
        deps.push({
          name,
          version: info.version,
          ecosystem: 'npm',
          isDirect: !pkgPath.includes('node_modules/node_modules/'),
          source: filePath,
        });
      }
    }
  }
  // v1 lockfile format (dependencies field)
  else if (lockfile.dependencies) {
    const walkV1 = (depsObj: Record<string, any>, isDirect: boolean) => {
      for (const [name, info] of Object.entries(depsObj)) {
        if ((info as any).version) {
          deps.push({
            name,
            version: (info as any).version,
            ecosystem: 'npm',
            isDirect,
            source: filePath,
          });
        }
        if ((info as any).dependencies) {
          walkV1((info as any).dependencies, false);
        }
      }
    };
    walkV1(lockfile.dependencies, true);
  }

  return deps;
}

// ---- Python Parser ----

async function parsePython(manifest: ManifestFile): Promise<Dependency[]> {
  const filename = basename(manifest.path);

  if (filename === 'requirements.txt') {
    return parseRequirementsTxt(manifest.path);
  }
  if (filename === 'pyproject.toml') {
    return parsePyprojectToml(manifest.path);
  }

  return [];
}

async function parseRequirementsTxt(filePath: string): Promise<Dependency[]> {
  const content = await readFile(filePath, 'utf-8');
  const deps: Dependency[] = [];

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;

    // Handle: package==version, package>=version, package~=version, package
    const match = line.match(/^([a-zA-Z0-9_.-]+)\s*(?:[=~!<>]=?\s*([^\s,;#]+))?/);
    if (match) {
      deps.push({
        name: match[1],
        version: match[2] || '*',
        ecosystem: 'python',
        isDirect: true,
        source: filePath,
      });
    }
  }

  return deps;
}

async function parsePyprojectToml(filePath: string): Promise<Dependency[]> {
  const content = await readFile(filePath, 'utf-8');
  const deps: Dependency[] = [];

  // Basic TOML parsing for dependencies section
  // (A full TOML parser would be better but this handles common cases)
  const depSection = content.match(/\[project\]\s*[\s\S]*?dependencies\s*=\s*\[([\s\S]*?)\]/);
  if (depSection) {
    const depsStr = depSection[1];
    const matches = depsStr.matchAll(/"([^"]+)"/g);
    for (const m of matches) {
      const spec = m[1];
      const nameMatch = spec.match(/^([a-zA-Z0-9_.-]+)/);
      const versionMatch = spec.match(/[=~!<>]=?\s*([^\s,;]+)/);
      if (nameMatch) {
        deps.push({
          name: nameMatch[1],
          version: versionMatch?.[1] || '*',
          ecosystem: 'python',
          isDirect: true,
          source: filePath,
        });
      }
    }
  }

  return deps;
}

// ---- Go Parser ----

async function parseGo(manifest: ManifestFile): Promise<Dependency[]> {
  const filename = basename(manifest.path);
  if (filename !== 'go.mod') return [];

  const content = await readFile(manifest.path, 'utf-8');
  const deps: Dependency[] = [];

  // Parse require block
  const requireBlock = content.match(/require\s*\(([\s\S]*?)\)/);
  if (requireBlock) {
    for (const line of requireBlock[1].split('\n')) {
      const match = line.trim().match(/^(\S+)\s+(v\S+)/);
      if (match && !match[0].startsWith('//')) {
        deps.push({
          name: match[1],
          version: match[2],
          ecosystem: 'go',
          isDirect: true,
          source: manifest.path,
        });
      }
    }
  }

  // Parse single-line requires
  const singleRequires = content.matchAll(/^require\s+(\S+)\s+(v\S+)/gm);
  for (const match of singleRequires) {
    deps.push({
      name: match[1],
      version: match[2],
      ecosystem: 'go',
      isDirect: true,
      source: manifest.path,
    });
  }

  return deps;
}

// ---- Rust Parser ----

async function parseRust(manifest: ManifestFile): Promise<Dependency[]> {
  const filename = basename(manifest.path);
  if (filename !== 'Cargo.toml') return [];

  const content = await readFile(manifest.path, 'utf-8');
  const deps: Dependency[] = [];

  // Parse [dependencies] section
  const depSections = content.matchAll(/\[(dev-)?dependencies\]\s*\n([\s\S]*?)(?=\n\[|$)/g);
  for (const section of depSections) {
    const isDev = !!section[1];
    for (const line of section[2].split('\n')) {
      // name = "version" or name = { version = "...", ... }
      const simpleMatch = line.match(/^(\w[\w-]*)\s*=\s*"([^"]+)"/);
      const complexMatch = line.match(/^(\w[\w-]*)\s*=\s*\{.*version\s*=\s*"([^"]+)"/);

      const match = simpleMatch || complexMatch;
      if (match) {
        deps.push({
          name: match[1],
          version: match[2],
          ecosystem: 'rust',
          isDirect: true,
          source: manifest.path,
        });
      }
    }
  }

  return deps;
}

// ---- Utilities ----

function cleanVersion(version: string): string {
  // Strip semver range operators: ^, ~, >=, etc.
  return version.replace(/^[\^~>=<]+/, '').trim();
}

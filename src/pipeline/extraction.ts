// ============================================================================
// Extraction — Parse manifest files and extract dependency lists
// ============================================================================

import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Dependency, Ecosystem, ManifestFile } from '../types.js';

/**
 * Extract all dependencies from discovered manifest files.
 * Currently fully supports npm. Other ecosystems have basic support.
 */
export async function extractDependencies(manifests: ManifestFile[]): Promise<Dependency[]> {
  const depMap = new Map<string, Dependency>();

  for (const manifest of manifests) {
    try {
      const deps = await parseManifest(manifest);
      for (const dep of deps) {
        const key = `${dep.ecosystem}:${dep.name}@${dep.version}`;
        const existing = depMap.get(key);
        if (!existing) {
          depMap.set(key, dep);
        } else {
          // Merge: if either source says isDirect, it's direct.
          // isDev only if BOTH sources agree it's dev (or only one source has it).
          if (dep.isDirect) existing.isDirect = true;
          if (dep.isDev === false) existing.isDev = false;
        }
      }
    } catch (err) {
      console.warn(`  Warning: Failed to parse ${manifest.path}: ${(err as Error).message}`);
    }
  }

  return Array.from(depMap.values());
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

  const addDeps = (section: Record<string, string> | undefined, isDev: boolean) => {
    if (!section) return;
    for (const [name, version] of Object.entries(section)) {
      deps.push({
        name,
        version: cleanVersion(version),
        ecosystem: 'npm',
        isDirect: true,
        isDev,
        source: filePath,
      });
    }
  };

  addDeps(pkg.dependencies, false);
  addDeps(pkg.devDependencies, true);

  return deps;
}

async function parsePackageLockJson(filePath: string): Promise<Dependency[]> {
  const content = await readFile(filePath, 'utf-8');
  const lockfile = JSON.parse(content);
  const deps: Dependency[] = [];

  // Cross-reference the sibling package.json to determine true direct deps
  const dir = filePath.replace(/\/package-lock\.json$/, '');
  let directProdDeps = new Set<string>();
  let directDevDeps = new Set<string>();
  try {
    const pkgContent = await readFile(join(dir, 'package.json'), 'utf-8');
    const pkg = JSON.parse(pkgContent);
    directProdDeps = new Set(Object.keys(pkg.dependencies ?? {}));
    directDevDeps = new Set(Object.keys(pkg.devDependencies ?? {}));
  } catch {
    // If no sibling package.json, fall back to lockfile-only heuristics
  }

  const hasRootRef = directProdDeps.size > 0 || directDevDeps.size > 0;

  // v2/v3 lockfile format (packages field)
  if (lockfile.packages) {
    for (const [pkgPath, info] of Object.entries(lockfile.packages as Record<string, any>)) {
      if (!pkgPath || pkgPath === '') continue;

      const parts = pkgPath.replace(/^node_modules\//, '').split('node_modules/');
      const name = parts[parts.length - 1];

      if (name && info.version) {
        const isDirect = hasRootRef
          ? directProdDeps.has(name) || directDevDeps.has(name)
          : !pkgPath.includes('node_modules/node_modules/');

        // isDev: lockfile v2/v3 has a `dev` boolean field, or infer from package.json
        const isDev = info.dev === true || (hasRootRef && directDevDeps.has(name) && !directProdDeps.has(name));

        deps.push({
          name,
          version: info.version,
          ecosystem: 'npm',
          isDirect,
          isDev,
          source: filePath,
        });
      }
    }
  }
  // v1 lockfile format (dependencies field)
  else if (lockfile.dependencies) {
    const walkV1 = (depsObj: Record<string, any>, parentIsDirect: boolean) => {
      for (const [name, info] of Object.entries(depsObj)) {
        if ((info as any).version) {
          const isDirect = hasRootRef
            ? directProdDeps.has(name) || directDevDeps.has(name)
            : parentIsDirect;
          const isDev = (info as any).dev === true || (hasRootRef && directDevDeps.has(name) && !directProdDeps.has(name));

          deps.push({
            name,
            version: (info as any).version,
            ecosystem: 'npm',
            isDirect,
            isDev,
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

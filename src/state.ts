// ============================================================================
// State — Snapshot management and diff/drift tracking
// ============================================================================

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Snapshot, SnapshotDiff, DiffEntry, AuditReport,
  Dependency, ResolvedLicense, PolicyEvaluation,
} from './types.js';

/**
 * Create a new snapshot from audit results.
 */
export function createSnapshot(
  repoPath: string,
  dependencies: Dependency[],
  licenses: ResolvedLicense[],
  evaluations: PolicyEvaluation[],
  report: AuditReport
): Snapshot {
  return {
    id: generateSnapshotId(),
    timestamp: new Date().toISOString(),
    repoPath,
    dependencies,
    licenses,
    evaluations,
    report,
  };
}

/**
 * Save a snapshot to the audit directory.
 */
export async function saveSnapshot(snapshot: Snapshot, auditDir: string, repoName: string): Promise<string> {
  const snapshotDir = join(auditDir, 'repos', repoName, 'snapshots', snapshot.id);
  await mkdir(snapshotDir, { recursive: true });

  // Save individual components for easy access
  await writeFile(
    join(snapshotDir, 'manifest.json'),
    JSON.stringify(snapshot.dependencies, null, 2)
  );

  await writeFile(
    join(snapshotDir, 'licenses.json'),
    JSON.stringify(snapshot.licenses.map(l => ({
      name: l.dependency.name,
      version: l.dependency.version,
      license: l.license.spdxId || l.rawLicense,
      tier: l.license.tier,
      resolvedVia: l.resolvedVia,
      confidence: l.confidence,
    })), null, 2)
  );

  await writeFile(
    join(snapshotDir, 'policy-eval.json'),
    JSON.stringify(snapshot.evaluations.map(e => ({
      name: e.dependency.name,
      version: e.dependency.version,
      license: e.license.license.spdxId || e.license.rawLicense,
      status: e.status,
      severity: e.severity,
      reason: e.reason,
      rule: e.matchedRule,
      remediation: e.remediation,
    })), null, 2)
  );

  await writeFile(
    join(snapshotDir, 'report.json'),
    JSON.stringify(snapshot.report, null, 2)
  );

  // Save the full snapshot for programmatic access
  await writeFile(
    join(snapshotDir, 'snapshot.json'),
    JSON.stringify({ id: snapshot.id, timestamp: snapshot.timestamp, repoPath: snapshot.repoPath }, null, 2)
  );

  // Update the meta.json for this repo
  const metaPath = join(auditDir, 'repos', repoName, 'meta.json');
  const meta = {
    repoName,
    repoPath: snapshot.repoPath,
    lastSnapshot: snapshot.id,
    lastRun: snapshot.timestamp,
    snapshotCount: await countSnapshots(auditDir, repoName),
  };
  await writeFile(metaPath, JSON.stringify(meta, null, 2));

  return snapshotDir;
}

/**
 * Load the most recent snapshot for a repo.
 */
export async function loadLatestSnapshot(auditDir: string, repoName: string): Promise<Snapshot | null> {
  try {
    const metaPath = join(auditDir, 'repos', repoName, 'meta.json');
    const meta = JSON.parse(await readFile(metaPath, 'utf-8'));

    if (!meta.lastSnapshot) return null;

    const snapshotDir = join(auditDir, 'repos', repoName, 'snapshots', meta.lastSnapshot);
    const manifest = JSON.parse(await readFile(join(snapshotDir, 'manifest.json'), 'utf-8'));
    const evalData = JSON.parse(await readFile(join(snapshotDir, 'policy-eval.json'), 'utf-8'));
    const report = JSON.parse(await readFile(join(snapshotDir, 'report.json'), 'utf-8'));
    const snapshotMeta = JSON.parse(await readFile(join(snapshotDir, 'snapshot.json'), 'utf-8'));

    return {
      id: snapshotMeta.id,
      timestamp: snapshotMeta.timestamp,
      repoPath: snapshotMeta.repoPath,
      dependencies: manifest,
      licenses: [], // Simplified — full licenses aren't reloaded
      evaluations: evalData,
      report,
    };
  } catch {
    return null;
  }
}

/**
 * Compute the diff between two sets of evaluations.
 */
export function computeDiff(
  prevDeps: Dependency[],
  prevEvals: PolicyEvaluation[],
  currDeps: Dependency[],
  currEvals: PolicyEvaluation[],
  prevSnapshotId: string,
  currSnapshotId: string
): SnapshotDiff {
  const entries: DiffEntry[] = [];

  const prevMap = new Map(prevDeps.map(d => [d.name, d]));
  const currMap = new Map(currDeps.map(d => [d.name, d]));
  const getEvalName = (e: PolicyEvaluation | Record<string, any>): string =>
    (e as PolicyEvaluation).dependency?.name ?? (e as Record<string, string>).name ?? '';
  const getEvalLicense = (e: PolicyEvaluation | Record<string, any>): string | undefined =>
    (e as PolicyEvaluation).license?.license?.spdxId ?? (e as Record<string, string>).license;
  const prevEvalMap = new Map(prevEvals.map(e => [getEvalName(e), e]));
  const currEvalMap = new Map(currEvals.map(e => [getEvalName(e), e]));

  // Find added dependencies
  for (const [name, dep] of currMap) {
    if (!prevMap.has(name)) {
      entries.push({
        type: 'added',
        dependency: name,
        after: {
          version: dep.version,
          license: getEvalLicense(currEvalMap.get(name)!),
          status: currEvalMap.get(name)?.status,
        },
      });
    }
  }

  // Find removed dependencies
  for (const [name, dep] of prevMap) {
    if (!currMap.has(name)) {
      entries.push({
        type: 'removed',
        dependency: name,
        before: {
          version: dep.version,
          license: getEvalLicense(prevEvalMap.get(name)!),
          status: prevEvalMap.get(name)?.status,
        },
      });
    }
  }

  // Find changed dependencies
  for (const [name, currDep] of currMap) {
    const prevDep = prevMap.get(name);
    if (!prevDep) continue;

    const prevEval = prevEvalMap.get(name);
    const currEval = currEvalMap.get(name);

    if (prevDep.version !== currDep.version) {
      entries.push({
        type: 'version_changed',
        dependency: name,
        before: { version: prevDep.version },
        after: { version: currDep.version },
      });
    }

    const prevStatus = prevEval?.status;
    const currStatus = currEval?.status;
    if (prevStatus && currStatus && prevStatus !== currStatus) {
      entries.push({
        type: 'status_changed',
        dependency: name,
        before: { status: prevStatus },
        after: { status: currStatus },
      });
    }
  }

  const newViolations = entries.filter(e =>
    e.type === 'added' && e.after?.status === 'non_compliant' ||
    e.type === 'status_changed' && e.after?.status === 'non_compliant'
  ).length;

  const resolvedViolations = entries.filter(e =>
    e.type === 'removed' && e.before?.status === 'non_compliant' ||
    e.type === 'status_changed' && e.before?.status === 'non_compliant' && e.after?.status !== 'non_compliant'
  ).length;

  return {
    fromSnapshot: prevSnapshotId,
    toSnapshot: currSnapshotId,
    timestamp: new Date().toISOString(),
    entries,
    summary: {
      added: entries.filter(e => e.type === 'added').length,
      removed: entries.filter(e => e.type === 'removed').length,
      changed: entries.filter(e => e.type === 'version_changed' || e.type === 'status_changed').length,
      newViolations,
      resolvedViolations,
    },
  };
}

/**
 * Save a diff to the audit directory.
 */
export async function saveDiff(diff: SnapshotDiff, auditDir: string, repoName: string): Promise<void> {
  const diffDir = join(auditDir, 'repos', repoName, 'diffs');
  await mkdir(diffDir, { recursive: true });

  const filename = `${diff.fromSnapshot}_to_${diff.toSnapshot}.json`;
  await writeFile(join(diffDir, filename), JSON.stringify(diff, null, 2));
}

// ---- Utilities ----

function generateSnapshotId(): string {
  const now = new Date();
  const date = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').split('Z')[0];
  const rand = Math.random().toString(36).slice(2, 6);
  return `${date}_${rand}`;
}

async function countSnapshots(auditDir: string, repoName: string): Promise<number> {
  try {
    const snapshotDir = join(auditDir, 'repos', repoName, 'snapshots');
    const entries = await readdir(snapshotDir);
    return entries.length;
  } catch {
    return 1;
  }
}

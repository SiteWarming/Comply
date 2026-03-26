// ============================================================================
// Pipeline — Main orchestration for the comply audit workflow
// ============================================================================

import { basename, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { discoverManifests, summarizeDiscovery } from './discovery.js';
import { extractDependencies } from './extraction.js';
import { resolveLicenses } from './resolution.js';
import { createAIProvider, analyzeUsage, findUsageLocations, extractCodeSnippets } from './analysis.js';
import { runAIOrchestrator } from '../ai/orchestrator.js';
import { createProvider } from '../ai/provider.js';
import { loadPolicy, evaluateLicense } from './policy.js';
import { buildReport, renderMarkdownReport, saveReport } from '../output/reporting.js';
import { generateNoticesFile, saveNoticesFile } from '../output/notices.js';
import { checkDependencyHealth, renderHealthSection } from './health.js';
import { detectWorkspaces, scopeDependenciesToWorkspaces, applyDistributionOverrides, renderWorkspaceSection } from './workspaces.js';
import { createSnapshot, saveSnapshot, loadLatestSnapshot, computeDiff, saveDiff } from '../state/state.js';
import type { ComplyConfig, PolicyEvaluation, Ecosystem, SnapshotDiff, Dependency, DistributionModel } from '../types.js';
import type { DependencyHealth } from './health.js';
import type { WorkspaceConfig } from './workspaces.js';

interface PipelineCallbacks {
  onPhase?(phase: string, detail?: string): void;
  onProgress?(current: number, total: number, item?: string): void;
}

export interface PipelineResult {
  reportPath: string;
  jsonPath: string;
  snapshotDir: string;
  noticesPath?: string;
  summary: {
    total: number;
    compliant: number;
    nonCompliant: number;
    needsReview: number;
    riskScore: number;
  };
  diff?: SnapshotDiff;
  workspaceConfig?: WorkspaceConfig;
  healthData?: DependencyHealth[];
  /** For CI mode: structured annotations */
  ciAnnotations?: CIAnnotation[];
  /** Full evaluations for assistant mode */
  evaluations?: PolicyEvaluation[];
  /** Ecosystems discovered during scan */
  ecosystems?: Ecosystem[];
}

export interface CIAnnotation {
  level: 'error' | 'warning' | 'notice';
  message: string;
  file?: string;
  package: string;
  license: string;
  severity: string;
}

/**
 * Run the full compliance audit pipeline.
 */
export async function runPipeline(
  config: ComplyConfig,
  callbacks?: PipelineCallbacks
): Promise<PipelineResult> {
  const startTime = Date.now();
  const repoName = basename(config.repoPath);

  // ---- Phase 1: Discovery ----
  callbacks?.onPhase?.('discovery', 'Scanning for package manifests...');

  const manifests = await discoverManifests(config.repoPath, {
    ecosystems: config.ecosystems,
  });

  if (manifests.length === 0) {
    throw new Error(`No package manifests found in ${config.repoPath}. Supported: package.json, requirements.txt, go.mod, Cargo.toml`);
  }

  const discovery = summarizeDiscovery(manifests);
  const ecosystems = Object.keys(discovery) as Ecosystem[];

  if (config.verbose) {
    console.log(`  Found ${manifests.length} manifest files across ${ecosystems.length} ecosystem(s)`);
    for (const [eco, counts] of Object.entries(discovery)) {
      console.log(`    ${eco}: ${counts.manifests} manifest(s), ${counts.lockfiles} lockfile(s)`);
    }
  }

  // ---- Phase 1b: Workspace Detection ----
  callbacks?.onPhase?.('workspaces', 'Detecting workspace structure...');
  const workspaceConfig = await detectWorkspaces(config.repoPath, manifests);

  if (workspaceConfig.isMonorepo && config.verbose) {
    console.log(`  Monorepo detected (${workspaceConfig.tool}): ${workspaceConfig.workspaces.length} workspaces`);
    for (const ws of workspaceConfig.workspaces) {
      console.log(`    ${ws.isRoot ? '(root)' : ws.relativePath}: ${ws.name}`);
    }
  }

  // ---- Phase 2: Extraction ----
  callbacks?.onPhase?.('extraction', 'Extracting dependencies...');

  const dependencies = await extractDependencies(manifests);

  if (dependencies.length === 0) {
    throw new Error('No dependencies found in manifest files.');
  }

  // Scope dependencies to workspaces
  scopeDependenciesToWorkspaces(workspaceConfig, dependencies);

  if (config.verbose) {
    const direct = dependencies.filter(d => d.isDirect).length;
    console.log(`  Found ${dependencies.length} dependencies (${direct} direct, ${dependencies.length - direct} transitive)`);
  }

  // ---- Phase 3: License Resolution ----
  callbacks?.onPhase?.('resolution', `Resolving licenses for ${dependencies.length} packages...`);

  const cacheDir = `${config.auditDir}/cache/licenses`;
  const licenses = await resolveLicenses(dependencies, cacheDir, { verbose: config.verbose });

  const resolved = licenses.filter(l => l.license.spdxId);
  const unresolved = licenses.filter(l => !l.license.spdxId);

  if (config.verbose) {
    console.log(`  Resolved ${resolved.length}/${licenses.length} licenses (${unresolved.length} unknown)`);
  }

  // ---- Phase 3b: Dependency Health Check ----
  let healthData: DependencyHealth[] | undefined;
  if (!config.diffOnly) {
    callbacks?.onPhase?.('health', `Checking dependency health for ${dependencies.length} packages...`);
    healthData = await checkDependencyHealth(dependencies, { verbose: config.verbose });

    if (config.verbose) {
      const deprecated = healthData.filter(h => h.isDeprecated).length;
      const stale = healthData.filter(h => h.maintenanceRisk === 'stale' || h.maintenanceRisk === 'abandoned').length;
      const licenseChanged = healthData.filter(h => h.licenseChanged).length;
      if (deprecated > 0) console.log(`  ⚠️  ${deprecated} deprecated package(s)`);
      if (stale > 0) console.log(`  ⚠️  ${stale} stale/abandoned package(s)`);
      if (licenseChanged > 0) console.log(`  ⚠️  ${licenseChanged} package(s) with license changes in newer versions`);
    }
  }

  // ---- Phase 4: Policy Evaluation ----
  callbacks?.onPhase?.('evaluation', 'Evaluating against policy...');

  const policy = await loadPolicy(config.policyPath);

  // Apply per-workspace distribution model overrides
  applyDistributionOverrides(workspaceConfig, policy.distributionModel.overrides ?? {});

  // Build workspace→distribution model lookup for per-dep evaluation
  const wsDistModels = new Map<string, DistributionModel>();
  for (const ws of workspaceConfig.workspaces) {
    if (ws.distributionModel) {
      wsDistModels.set(ws.name, ws.distributionModel);
    }
  }

  // Propagate workspace stamps from scoped deps to resolved licenses
  // (scoping creates new objects, but resolution used the original deps)
  if (workspaceConfig.isMonorepo) {
    const wsLookup = new Map<string, string>();
    for (const ws of workspaceConfig.workspaces) {
      for (const d of ws.dependencies) {
        wsLookup.set(`${d.name}@${d.version}@${d.source}`, ws.name);
      }
    }
    for (const l of licenses) {
      const key = `${l.dependency.name}@${l.dependency.version}@${l.dependency.source}`;
      const wsName = wsLookup.get(key);
      if (wsName) {
        l.dependency.workspace = wsName;
      }
    }
  }

  const getDistModel = (dep: Dependency): DistributionModel | undefined =>
    dep.workspace ? wsDistModels.get(dep.workspace) : undefined;

  let evaluations: PolicyEvaluation[] = licenses.map(l =>
    evaluateLicense(l, policy, undefined, getDistModel(l.dependency))
  );

  // ---- Phase 5: AI Usage Analysis (optional) ----
  if (config.enableAIAnalysis) {
    const flagged = evaluations.filter(e =>
      e.status === 'non_compliant' ||
      e.status === 'conditionally_compliant' ||
      e.status === 'needs_review'
    );

    if (flagged.length > 0) {
      callbacks?.onPhase?.('analysis', `Running AI analysis on ${flagged.length} flagged packages...`);

      const aiConfig = config.ai || { provider: 'anthropic' as const };
      const provider = createProvider({
        provider: aiConfig.provider,
        apiKey: aiConfig.apiKey,
      });

      evaluations = await runAIOrchestrator(evaluations, {
        provider,
        repoPath: config.repoPath,
        auditDir: config.auditDir,
        distributionModel: wsDistModels.size > 0
          ? (dep: Dependency) => (dep.workspace ? wsDistModels.get(dep.workspace) : undefined) ?? policy.distributionModel.default
          : policy.distributionModel.default,
        tierCeiling: config.aiTier === 'budget' ? 'free' : config.aiTier === 'premium' ? 'premium' : 'mid',
        analysisLimit: config.aiAnalysisLimit || 20,
        verbose: config.verbose,
        findUsageLocations,
        extractCodeSnippets,
      }, {
        onProgress: callbacks?.onProgress,
        onAgentStart: config.verbose
          ? (agent, pkg) => console.log(`    [${agent}] ${pkg}...`)
          : undefined,
      });

      const limit = config.aiAnalysisLimit || 20;
      if (flagged.length > limit) {
        console.log(`  Note: AI analysis limited to ${limit} packages. ${flagged.length - limit} remaining. Use --ai-limit to increase.`);
      }
    }
  }

  // ---- Phase 6: Report Generation ----
  callbacks?.onPhase?.('reporting', 'Generating report...');

  const duration = Date.now() - startTime;
  const report = buildReport(config.repoPath, ecosystems, dependencies, evaluations, duration);

  // ---- Phase 7: Diff / Drift Detection ----
  let diff: SnapshotDiff | undefined;

  const prevSnapshot = await loadLatestSnapshot(config.auditDir, repoName);
  if (prevSnapshot) {
    callbacks?.onPhase?.('drift', 'Computing drift from last scan...');
    diff = computeDiff(
      prevSnapshot.dependencies,
      prevSnapshot.evaluations,
      dependencies,
      evaluations,
      prevSnapshot.id,
      'current'
    );
  }

  // Build the full markdown with all sections (health data drives remediation plan)
  let markdown = renderMarkdownReport(report, diff, healthData);

  // Inject workspace section after executive summary
  if (workspaceConfig.isMonorepo) {
    const wsSection = renderWorkspaceSection(workspaceConfig);
    markdown = markdown.replace('## Detailed Summary', wsSection + '\n## Detailed Summary');
  }

  // Inject health section before the compliant packages list
  if (healthData && healthData.length > 0) {
    const healthSection = renderHealthSection(healthData);
    const insertPoint = markdown.indexOf('## ✅ Compliant Packages');
    if (insertPoint > -1) {
      markdown = markdown.slice(0, insertPoint) + healthSection + '\n' + markdown.slice(insertPoint);
    } else {
      const footerIdx = markdown.lastIndexOf('---');
      if (footerIdx > -1) {
        markdown = markdown.slice(0, footerIdx) + healthSection + '\n' + markdown.slice(footerIdx);
      }
    }
  }

  // ---- Phase 8: Save State ----
  callbacks?.onPhase?.('saving', 'Saving audit state...');

  const snapshot = createSnapshot(config.repoPath, dependencies, licenses, evaluations, report);
  const snapshotDir = await saveSnapshot(snapshot, config.auditDir, repoName);

  if (diff) {
    diff.toSnapshot = snapshot.id;
    await saveDiff(diff, config.auditDir, repoName);
  }

  const { mdPath, jsonPath } = await saveReport(report, markdown, snapshotDir);

  // ---- Phase 9: Generate NOTICES File ----
  let noticesPath: string | undefined;
  callbacks?.onPhase?.('notices', 'Generating NOTICES file...');
  const noticesContent = generateNoticesFile(repoName, evaluations, { format: 'text' });
  noticesPath = join(snapshotDir, 'NOTICES');
  await saveNoticesFile(noticesContent, noticesPath);

  const noticesMd = generateNoticesFile(repoName, evaluations, { format: 'markdown' });
  await saveNoticesFile(noticesMd, join(snapshotDir, 'NOTICES.md'));

  // Save health data if available
  if (healthData) {
    await writeFile(join(snapshotDir, 'health.json'), JSON.stringify(healthData, null, 2));
  }

  // Save workspace config if monorepo
  if (workspaceConfig.isMonorepo) {
    await writeFile(join(snapshotDir, 'workspaces.json'), JSON.stringify({
      tool: workspaceConfig.tool,
      workspaces: workspaceConfig.workspaces.map(ws => ({
        name: ws.name,
        path: ws.relativePath,
        isRoot: ws.isRoot,
        dependencyCount: ws.dependencies.length,
      })),
    }, null, 2));
  }

  const ciAnnotations = generateCIAnnotations(evaluations);

  return {
    reportPath: mdPath,
    jsonPath,
    snapshotDir,
    noticesPath,
    summary: {
      total: report.summary.totalDependencies,
      compliant: report.summary.compliant,
      nonCompliant: report.summary.nonCompliant,
      needsReview: report.summary.needsReview,
      riskScore: report.summary.riskScore,
    },
    diff,
    workspaceConfig: workspaceConfig.isMonorepo ? workspaceConfig : undefined,
    healthData,
    ciAnnotations,
    evaluations,
    ecosystems,
  };
}

function generateCIAnnotations(evaluations: PolicyEvaluation[]): CIAnnotation[] {
  return evaluations
    .filter(e => e.status === 'non_compliant' || e.status === 'needs_review')
    .map(e => {
      let level: CIAnnotation['level'] = 'warning';
      if (e.status === 'non_compliant') {
        level = (e.severity === 'critical' || e.severity === 'high') ? 'error' : 'warning';
      }

      return {
        level,
        message: `${e.dependency.name}@${e.dependency.version}: ${e.reason}`,
        file: e.dependency.source || undefined,
        package: e.dependency.name,
        license: e.license.license.spdxId || e.license.rawLicense || 'Unknown',
        severity: e.severity,
      };
    });
}

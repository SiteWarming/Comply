// ============================================================================
// Orchestrator — Multi-agent pipeline router for AI analysis
// ============================================================================

import type { AIProvider, ModelTier, AIConfig } from './types.js';
import type { PolicyEvaluation, ResolvedLicense, DistributionModel, UsageAnalysis, UsageType, Dependency, RemediationStep } from '../types.js';
import { PromptLoader } from './prompts.js';
import { AICache } from './cache.js';
import { ClassifierAgent, type ClassifierContext } from './agents/classifier.js';
import { UsageAnalyzerAgent, type UsageAnalyzerContext } from './agents/usage-analyzer.js';
import { ObligationReasonerAgent, type ObligationReasonerContext } from './agents/obligation-reasoner.js';
import { ConflictDetectorAgent, type ConflictDetectorContext } from './agents/conflict-detector.js';
import { RemediationAdvisorAgent, type RemediationAdvisorContext } from './agents/remediation-advisor.js';
import type { ClassifierOutput, UsageAnalyzerOutput, ObligationReasonerOutput, RemediationAdvisorOutput } from './schemas.js';

export interface OrchestratorConfig {
  provider: AIProvider;
  repoPath: string;
  auditDir: string;
  distributionModel: DistributionModel | ((dep: Dependency) => DistributionModel);
  tierCeiling: ModelTier;
  promptsDir?: string;
  cacheTtlDays?: number;
  analysisLimit?: number;
  verbose?: boolean;
  findUsageLocations: (packageName: string, repoPath: string, ecosystem: string) => Promise<string[]>;
  extractCodeSnippets: (filePaths: string[], packageName: string) => Promise<string[]>;
}

export interface OrchestratorCallbacks {
  onProgress?(current: number, total: number, item?: string): void;
  onAgentStart?(agent: string, packageName: string): void;
  onAgentComplete?(agent: string, packageName: string, cached: boolean): void;
}

interface AgentSuite {
  classifier: ClassifierAgent;
  usageAnalyzer: UsageAnalyzerAgent;
  obligationReasoner: ObligationReasonerAgent;
  conflictDetector: ConflictDetectorAgent;
  remediationAdvisor: RemediationAdvisorAgent;
}

const TIER_ORDER: Record<ModelTier, number> = { free: 0, mid: 1, premium: 2 };

function tierAllowed(required: ModelTier, ceiling: ModelTier): boolean {
  return TIER_ORDER[required] <= TIER_ORDER[ceiling];
}

function resolveDistModel(
  config: OrchestratorConfig,
  dep: Dependency
): DistributionModel {
  if (typeof config.distributionModel === 'function') {
    return config.distributionModel(dep);
  }
  return config.distributionModel;
}

/**
 * Run the multi-agent AI analysis pipeline.
 * Returns updated evaluations with AI-enriched data.
 */
export async function runAIOrchestrator(
  evaluations: PolicyEvaluation[],
  config: OrchestratorConfig,
  callbacks?: OrchestratorCallbacks
): Promise<PolicyEvaluation[]> {
  const promptLoader = new PromptLoader(config.promptsDir);
  const cache = new AICache(config.auditDir, config.cacheTtlDays);

  const agents: AgentSuite = {
    classifier: new ClassifierAgent(config.provider, promptLoader),
    usageAnalyzer: new UsageAnalyzerAgent(config.provider, promptLoader),
    obligationReasoner: new ObligationReasonerAgent(config.provider, promptLoader),
    conflictDetector: new ConflictDetectorAgent(config.provider, promptLoader),
    remediationAdvisor: new RemediationAdvisorAgent(config.provider, promptLoader),
  };

  // Filter to flagged evaluations
  const flagged = evaluations.filter(e =>
    e.status === 'non_compliant' ||
    e.status === 'conditionally_compliant' ||
    e.status === 'needs_review'
  );

  if (flagged.length === 0) return evaluations;

  const limit = config.analysisLimit ?? 20;
  const toAnalyze = flagged.slice(0, limit);
  const results = new Map<string, Partial<AnalysisAccumulator>>();

  // ---- Stage 1: Classifier (free tier) ----
  if (tierAllowed('free', config.tierCeiling)) {
    await runClassifierStage(toAnalyze, agents.classifier, cache, config, results, callbacks);
  }

  // ---- Stage 2: Usage Analyzer (mid tier) ----
  if (tierAllowed('mid', config.tierCeiling)) {
    const runtimePackages = toAnalyze.filter(e => {
      const acc = results.get(depKey(e.dependency));
      return !acc?.classification || acc.classification === 'runtime';
    });

    await runUsageAnalyzerStage(runtimePackages, agents.usageAnalyzer, cache, config, results, callbacks);
  }

  // ---- Stage 3: Obligation Reasoner (mid tier) ----
  if (tierAllowed('mid', config.tierCeiling)) {
    const needsObligation = toAnalyze.filter(e => {
      const acc = results.get(depKey(e.dependency));
      return acc?.usageAnalysis && !acc.classification?.match(/dev_only|test_only|build_tool/);
    });

    await runObligationStage(needsObligation, agents.obligationReasoner, cache, config, results, callbacks);
  }

  // ---- Stage 4: Conflict Detector (premium tier) ----
  if (tierAllowed('premium', config.tierCeiling)) {
    const copyleftRuntime = toAnalyze.filter(e => {
      const tier = e.license.license.tier;
      const acc = results.get(depKey(e.dependency));
      return (tier === 'strong_copyleft' || tier === 'network_copyleft' || tier === 'weak_copyleft') &&
        acc?.classification === 'runtime';
    });

    if (copyleftRuntime.length >= 2) {
      await runConflictStage(copyleftRuntime, agents.conflictDetector, config, callbacks);
    }
  }

  // ---- Stage 5: Remediation Advisor (mid tier) ----
  // Run for non-compliant, needs-review, and packages where obligations are triggered.
  // needs_review packages benefit from AI suggestions (alternative packages, license clarification).
  if (tierAllowed('mid', config.tierCeiling)) {
    const needsRemediation = toAnalyze.filter(e => {
      const acc = results.get(depKey(e.dependency));
      return acc?.triggersObligations === true ||
        e.status === 'non_compliant' ||
        e.status === 'needs_review';
    });

    await runRemediationStage(needsRemediation, agents.remediationAdvisor, cache, config, results, callbacks);
  }

  // ---- Apply results back to evaluations ----
  return applyResults(evaluations, results);
}

// ---- Stage Runners ----

async function runClassifierStage(
  evaluations: PolicyEvaluation[],
  agent: ClassifierAgent,
  cache: AICache,
  config: OrchestratorConfig,
  results: Map<string, Partial<AnalysisAccumulator>>,
  callbacks?: OrchestratorCallbacks
): Promise<void> {
  const batchSize = 5;

  for (let i = 0; i < evaluations.length; i += batchSize) {
    const batch = evaluations.slice(i, i + batchSize);

    await Promise.all(batch.map(async (evaluation) => {
      const dep = evaluation.dependency;
      const key = depKey(dep);
      callbacks?.onAgentStart?.('classifier', dep.name);

      // Check cache
      const cacheKey = AICache.makeKey(dep.name, dep.version, '1.0.0', 'classifier');
      const cached = await cache.get<ClassifierOutput>('classifier', cacheKey);
      if (cached) {
        results.set(key, { ...results.get(key), classification: cached.classification });
        callbacks?.onAgentComplete?.('classifier', dep.name, true);
        return;
      }

      try {
        // Determine manifest context (is it devDependency?)
        const manifestContext = dep.isDirect
          ? `Declared as a direct dependency in ${dep.source}`
          : `Transitive dependency (indirect, pulled in by another package)`;

        // Get code snippets
        const locations = await config.findUsageLocations(dep.name, config.repoPath, dep.ecosystem);
        const snippets = await config.extractCodeSnippets(locations, dep.name);

        const context: ClassifierContext = {
          packageName: dep.name,
          ecosystem: dep.ecosystem,
          manifestContext,
          codeSnippets: snippets.join('\n\n') || 'No code usage found.',
        };

        const result = await agent.execute(context);
        results.set(key, { ...results.get(key), classification: result.data.classification });

        await cache.set('classifier', cacheKey, result.data, {
          packageName: dep.name,
          packageVersion: dep.version,
          promptVersion: '1.0.0',
          model: result.model,
        });

        callbacks?.onAgentComplete?.('classifier', dep.name, false);
      } catch (err) {
        if (config.verbose) {
          console.warn(`  Warning: Classifier failed for ${dep.name}: ${(err as Error).message}`);
        }
        // Default to runtime (conservative)
        results.set(key, { ...results.get(key), classification: 'runtime' });
        callbacks?.onAgentComplete?.('classifier', dep.name, false);
      }
    }));
  }
}

async function runUsageAnalyzerStage(
  evaluations: PolicyEvaluation[],
  agent: UsageAnalyzerAgent,
  cache: AICache,
  config: OrchestratorConfig,
  results: Map<string, Partial<AnalysisAccumulator>>,
  callbacks?: OrchestratorCallbacks
): Promise<void> {
  for (const evaluation of evaluations) {
    const dep = evaluation.dependency;
    const key = depKey(dep);
    callbacks?.onAgentStart?.('usage-analyzer', dep.name);

    const cacheKey = AICache.makeKey(dep.name, dep.version, '1.0.0', 'usage-analyzer');
    const cached = await cache.get<UsageAnalyzerOutput>('usage-analyzer', cacheKey);
    if (cached) {
      results.set(key, {
        ...results.get(key),
        usageAnalysis: cached,
        triggersObligations: cached.triggersObligations,
      });
      callbacks?.onAgentComplete?.('usage-analyzer', dep.name, true);
      continue;
    }

    try {
      const locations = await config.findUsageLocations(dep.name, config.repoPath, dep.ecosystem);
      const snippets = await config.extractCodeSnippets(locations, dep.name);

      const context: UsageAnalyzerContext = {
        packageName: dep.name,
        licenseId: evaluation.license.license.spdxId || evaluation.license.rawLicense,
        licenseTier: evaluation.license.license.tier,
        codeSnippets: snippets.join('\n\n') || 'No code usage found.',
        distributionModel: resolveDistModel(config, dep),
      };

      const result = await agent.execute(context);
      results.set(key, {
        ...results.get(key),
        usageAnalysis: result.data,
        triggersObligations: result.data.triggersObligations,
        usageLocations: locations.map(l => l.replace(config.repoPath + '/', '')),
      });

      await cache.set('usage-analyzer', cacheKey, result.data, {
        packageName: dep.name,
        packageVersion: dep.version,
        promptVersion: '1.0.0',
        model: result.model,
      });

      callbacks?.onAgentComplete?.('usage-analyzer', dep.name, false);
    } catch (err) {
      if (config.verbose) {
        console.warn(`  Warning: Usage analyzer failed for ${dep.name}: ${(err as Error).message}`);
      }
      callbacks?.onAgentComplete?.('usage-analyzer', dep.name, false);
    }
  }
}

async function runObligationStage(
  evaluations: PolicyEvaluation[],
  agent: ObligationReasonerAgent,
  cache: AICache,
  config: OrchestratorConfig,
  results: Map<string, Partial<AnalysisAccumulator>>,
  callbacks?: OrchestratorCallbacks
): Promise<void> {
  for (const evaluation of evaluations) {
    const dep = evaluation.dependency;
    const key = depKey(dep);
    const acc = results.get(key);
    if (!acc?.usageAnalysis) continue;

    callbacks?.onAgentStart?.('obligation-reasoner', dep.name);

    const cacheKey = AICache.makeKey(dep.name, dep.version, '1.0.0', 'obligation-reasoner');
    const cached = await cache.get<ObligationReasonerOutput>('obligation-reasoner', cacheKey);
    if (cached) {
      results.set(key, { ...acc, triggersObligations: cached.triggersObligations, obligationReasoning: cached.reasoning });
      callbacks?.onAgentComplete?.('obligation-reasoner', dep.name, true);
      continue;
    }

    try {
      const context: ObligationReasonerContext = {
        packageName: dep.name,
        licenseId: evaluation.license.license.spdxId || evaluation.license.rawLicense,
        licenseTier: evaluation.license.license.tier,
        usageTypes: acc.usageAnalysis.usageTypes.join(', '),
        isModified: String(acc.usageAnalysis.isModified),
        distributionModel: resolveDistModel(config, dep),
      };

      const result = await agent.execute(context);
      results.set(key, {
        ...acc,
        triggersObligations: result.data.triggersObligations,
        obligationReasoning: result.data.reasoning,
      });

      await cache.set('obligation-reasoner', cacheKey, result.data, {
        packageName: dep.name,
        packageVersion: dep.version,
        promptVersion: '1.0.0',
        model: result.model,
      });

      callbacks?.onAgentComplete?.('obligation-reasoner', dep.name, false);
    } catch (err) {
      if (config.verbose) {
        console.warn(`  Warning: Obligation reasoner failed for ${dep.name}: ${(err as Error).message}`);
      }
      // Default to cautious
      results.set(key, { ...acc, triggersObligations: true });
      callbacks?.onAgentComplete?.('obligation-reasoner', dep.name, false);
    }
  }
}

async function runConflictStage(
  copyleftEvals: PolicyEvaluation[],
  agent: ConflictDetectorAgent,
  config: OrchestratorConfig,
  callbacks?: OrchestratorCallbacks
): Promise<void> {
  callbacks?.onAgentStart?.('conflict-detector', 'cross-project');

  try {
    const packagesDesc = copyleftEvals.map(e =>
      `- ${e.dependency.name}@${e.dependency.version} (${e.license.license.spdxId || e.license.rawLicense})`
    ).join('\n');

    // Conflict detection is cross-project; use the first dep's model or fallback to string value
    const fallbackModel = typeof config.distributionModel === 'function'
      ? (copyleftEvals[0] ? config.distributionModel(copyleftEvals[0].dependency) : 'saas')
      : config.distributionModel;
    const context: ConflictDetectorContext = {
      packages: packagesDesc,
      distributionModel: fallbackModel,
    };

    await agent.execute(context);
    // TODO: integrate conflict results into evaluations
    callbacks?.onAgentComplete?.('conflict-detector', 'cross-project', false);
  } catch (err) {
    if (config.verbose) {
      console.warn(`  Warning: Conflict detector failed: ${(err as Error).message}`);
    }
    callbacks?.onAgentComplete?.('conflict-detector', 'cross-project', false);
  }
}

async function runRemediationStage(
  evaluations: PolicyEvaluation[],
  agent: RemediationAdvisorAgent,
  cache: AICache,
  config: OrchestratorConfig,
  results: Map<string, Partial<AnalysisAccumulator>>,
  callbacks?: OrchestratorCallbacks
): Promise<void> {
  for (const evaluation of evaluations) {
    const dep = evaluation.dependency;
    const key = depKey(dep);
    const acc = results.get(key) ?? {};

    callbacks?.onAgentStart?.('remediation-advisor', dep.name);

    const cacheKey = AICache.makeKey(dep.name, dep.version, '1.0.0', 'remediation-advisor');
    const cached = await cache.get<RemediationAdvisorOutput>('remediation-advisor', cacheKey);
    if (cached) {
      results.set(key, { ...acc, remediation: cached });
      callbacks?.onAgentComplete?.('remediation-advisor', dep.name, true);
      continue;
    }

    try {
      const usageContext = acc.usageAnalysis
        ? `Usage types: ${acc.usageAnalysis.usageTypes.join(', ')}. ${acc.usageAnalysis.reasoning}`
        : `Package is used as a ${dep.isDirect ? 'direct' : 'transitive'} dependency.`;

      const context: RemediationAdvisorContext = {
        packageName: dep.name,
        ecosystem: dep.ecosystem,
        licenseId: evaluation.license.license.spdxId || evaluation.license.rawLicense,
        usageContext,
      };

      const result = await agent.execute(context);
      results.set(key, { ...acc, remediation: result.data });

      await cache.set('remediation-advisor', cacheKey, result.data, {
        packageName: dep.name,
        packageVersion: dep.version,
        promptVersion: '1.0.0',
        model: result.model,
      });

      callbacks?.onAgentComplete?.('remediation-advisor', dep.name, false);
    } catch (err) {
      if (config.verbose) {
        console.warn(`  Warning: Remediation advisor failed for ${dep.name}: ${(err as Error).message}`);
      }
      callbacks?.onAgentComplete?.('remediation-advisor', dep.name, false);
    }
  }
}

// ---- Helpers ----

interface AnalysisAccumulator {
  classification: string;
  usageAnalysis: UsageAnalyzerOutput;
  usageLocations: string[];
  triggersObligations: boolean;
  obligationReasoning: string;
  remediation: RemediationAdvisorOutput;
}

function depKey(dep: Dependency): string {
  return `${dep.ecosystem}:${dep.name}@${dep.version}`;
}

function applyResults(
  evaluations: PolicyEvaluation[],
  results: Map<string, Partial<AnalysisAccumulator>>
): PolicyEvaluation[] {
  return evaluations.map(evaluation => {
    const key = depKey(evaluation.dependency);
    const acc = results.get(key);
    if (!acc) return evaluation;

    // If classified as dev/test/build with no obligation triggers → downgrade to compliant
    if (acc.classification && acc.classification !== 'runtime') {
      return {
        ...evaluation,
        usageAnalysis: buildUsageAnalysis(evaluation, acc),
        status: 'compliant' as const,
        severity: 'none' as const,
        reason: `AI classified as ${acc.classification} — license obligations not triggered for non-runtime usage`,
        matchedRule: evaluation.matchedRule,
      };
    }

    // If we have obligation analysis and it says no obligations triggered
    if (acc.triggersObligations === false && acc.usageAnalysis) {
      return {
        ...evaluation,
        usageAnalysis: buildUsageAnalysis(evaluation, acc),
        status: 'compliant' as const,
        severity: 'none' as const,
        reason: acc.obligationReasoning || `AI determined obligations not triggered: ${acc.usageAnalysis.reasoning}`,
        matchedRule: evaluation.matchedRule,
      };
    }

    // If we have usage analysis but obligations ARE triggered, enrich with AI data
    if (acc.usageAnalysis) {
      const remediation: RemediationStep[] | undefined = acc.remediation
        ? acc.remediation.alternatives.map(alt => ({
            action: 'replace' as const,
            description: `Replace with ${alt.name} (${alt.license}): ${alt.description}`,
            effort: acc.remediation!.effort,
            alternative: alt.name,
          }))
        : evaluation.remediation;

      return {
        ...evaluation,
        usageAnalysis: buildUsageAnalysis(evaluation, acc),
        reason: acc.obligationReasoning || acc.usageAnalysis.reasoning,
        remediation,
      };
    }

    return evaluation;
  });
}

function buildUsageAnalysis(
  evaluation: PolicyEvaluation,
  acc: Partial<AnalysisAccumulator>
): UsageAnalysis | undefined {
  if (!acc.usageAnalysis) return undefined;

  return {
    dependency: evaluation.dependency,
    license: evaluation.license,
    usageTypes: acc.usageAnalysis.usageTypes as UsageType[],
    usageLocations: acc.usageLocations ?? [],
    isModified: acc.usageAnalysis.isModified,
    reasoning: acc.usageAnalysis.reasoning,
    triggersObligations: acc.triggersObligations ?? true,
  };
}

// ============================================================================
// Eval Harness — Score AI agent accuracy against ground truth
// ============================================================================

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AIProvider, ModelTier } from './types.js';
import { PromptLoader } from './prompts.js';
import { ClassifierAgent } from './agents/classifier.js';
import { UsageAnalyzerAgent } from './agents/usage-analyzer.js';
import { ObligationReasonerAgent } from './agents/obligation-reasoner.js';

export interface GroundTruth {
  package: string;
  version: string;
  ecosystem: string;
  license: string;
  distributionModel?: string;
  expected: {
    classification: string;
    usageTypes: string[];
    triggersObligations: boolean;
  };
  notes?: string;
}

export interface EvalResult {
  agent: string;
  model: string;
  total: number;
  correct: number;
  accuracy: number;
  details: EvalDetail[];
}

export interface EvalDetail {
  package: string;
  field: string;
  expected: unknown;
  actual: unknown;
  correct: boolean;
  error?: string;
}

export interface EvalRunResult {
  runId: string;
  timestamp: string;
  results: EvalResult[];
}

/**
 * Load all ground truth files from the eval directory.
 */
export async function loadGroundTruth(evalDir: string): Promise<GroundTruth[]> {
  const gtDir = join(evalDir, 'ground-truth');
  let files: string[];
  try {
    files = await readdir(gtDir);
  } catch {
    throw new Error(`Ground truth directory not found: ${gtDir}`);
  }

  const jsonFiles = files.filter(f => f.endsWith('.json'));
  const results: GroundTruth[] = [];

  for (const file of jsonFiles) {
    const raw = await readFile(join(gtDir, file), 'utf-8');
    results.push(JSON.parse(raw) as GroundTruth);
  }

  return results;
}

/**
 * Run the eval harness for a specific agent or all agents.
 */
export async function runEval(options: {
  provider: AIProvider;
  evalDir: string;
  promptsDir?: string;
  agentFilter?: string;
  modelOverride?: string;
  verbose?: boolean;
}): Promise<EvalRunResult> {
  const groundTruth = await loadGroundTruth(options.evalDir);
  const promptLoader = new PromptLoader(options.promptsDir);
  const results: EvalResult[] = [];

  const agents = options.agentFilter
    ? [options.agentFilter]
    : ['classifier'];

  for (const agentName of agents) {
    const result = await evalAgent(agentName, groundTruth, options.provider, promptLoader, options.verbose);
    results.push(result);
  }

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runResult: EvalRunResult = {
    runId,
    timestamp: new Date().toISOString(),
    results,
  };

  // Save results
  const resultsDir = join(options.evalDir, 'results');
  await mkdir(resultsDir, { recursive: true });
  await writeFile(
    join(resultsDir, `${runId}.json`),
    JSON.stringify(runResult, null, 2)
  );

  return runResult;
}

async function evalAgent(
  agentName: string,
  groundTruth: GroundTruth[],
  provider: AIProvider,
  promptLoader: PromptLoader,
  verbose?: boolean
): Promise<EvalResult> {
  const details: EvalDetail[] = [];

  for (const gt of groundTruth) {
    try {
      switch (agentName) {
        case 'classifier': {
          const agent = new ClassifierAgent(provider, promptLoader);
          const result = await agent.execute({
            packageName: gt.package,
            ecosystem: gt.ecosystem,
            manifestContext: `Package ${gt.package} (${gt.license})`,
            codeSnippets: `import ${gt.package} from '${gt.package}';`,
          });

          const correct = result.data.classification === gt.expected.classification;
          details.push({
            package: gt.package,
            field: 'classification',
            expected: gt.expected.classification,
            actual: result.data.classification,
            correct,
          });

          if (verbose) {
            const mark = correct ? '✓' : '✗';
            console.log(`  ${mark} ${gt.package}: expected=${gt.expected.classification}, got=${result.data.classification}`);
          }
          break;
        }

        default:
          details.push({
            package: gt.package,
            field: agentName,
            expected: 'N/A',
            actual: 'Agent not implemented in eval',
            correct: false,
            error: `Eval not implemented for agent: ${agentName}`,
          });
      }
    } catch (err) {
      details.push({
        package: gt.package,
        field: agentName,
        expected: gt.expected.classification,
        actual: null,
        correct: false,
        error: (err as Error).message,
      });

      if (verbose) {
        console.log(`  ✗ ${gt.package}: ERROR — ${(err as Error).message}`);
      }
    }
  }

  const correct = details.filter(d => d.correct).length;
  return {
    agent: agentName,
    model: provider.name,
    total: details.length,
    correct,
    accuracy: details.length > 0 ? Math.round((correct / details.length) * 100) : 0,
    details,
  };
}

/**
 * Format eval results as a readable scorecard.
 */
export function formatScorecard(runResult: EvalRunResult): string {
  const lines: string[] = [];

  lines.push(`Eval Run: ${runResult.runId}`);
  lines.push(`Date: ${new Date(runResult.timestamp).toLocaleString()}`);
  lines.push('');
  lines.push('Agent                Model                    Accuracy  Correct/Total');
  lines.push('─────────────────────────────────────────────────────────────────────');

  for (const result of runResult.results) {
    const agent = result.agent.padEnd(20);
    const model = result.model.padEnd(24);
    const accuracy = `${result.accuracy}%`.padEnd(9);
    const ratio = `${result.correct}/${result.total}`;
    lines.push(`${agent} ${model} ${accuracy} ${ratio}`);
  }

  lines.push('');

  // Show failures
  for (const result of runResult.results) {
    const failures = result.details.filter(d => !d.correct);
    if (failures.length > 0) {
      lines.push(`Failures for ${result.agent}:`);
      for (const f of failures) {
        if (f.error) {
          lines.push(`  ✗ ${f.package}: ERROR — ${f.error}`);
        } else {
          lines.push(`  ✗ ${f.package}: expected=${JSON.stringify(f.expected)}, got=${JSON.stringify(f.actual)}`);
        }
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

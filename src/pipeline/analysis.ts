// ============================================================================
// Analysis — AI-powered usage analysis for flagged dependencies
// ============================================================================

import { readFile, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type { ResolvedLicense, UsageAnalysis, UsageType, DistributionModel } from '../types.js';
import { createProvider } from '../ai/provider.js';
import type { AIProvider as NewAIProvider, AIConfig, ModelTier } from '../ai/types.js';
import { PromptLoader } from '../ai/prompts.js';
import { UsageAnalyzerOutputSchema } from '../ai/schemas.js';
import { parseAndValidate } from '../ai/schemas.js';

const CODE_EXTENSIONS = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
  '.py', '.pyx',
  '.go',
  '.rs',
  '.java', '.kt', '.scala',
  '.rb',
  '.php',
  '.cs',
  '.c', '.h', '.cpp', '.hpp',
]);

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '__pycache__',
  '.tox', '.venv', 'venv', 'target', '.gradle', 'vendor',
  '.comply', '.license-audit',
]);

interface AIProvider {
  analyze(prompt: string): Promise<string>;
}

/**
 * Create an AI provider for usage analysis.
 * Delegates to the new multi-provider system while keeping the legacy interface.
 */
export function createAIProvider(config: {
  provider: 'anthropic' | 'openrouter';
  model?: string;
  apiKey?: string;
}): AIProvider {
  const newProvider = createProvider({
    provider: config.provider,
    apiKey: config.apiKey,
  } satisfies Partial<AIConfig>);

  return {
    async analyze(prompt: string): Promise<string> {
      const response = await newProvider.complete({
        messages: [{ role: 'user', content: prompt }],
        tier: 'mid' as ModelTier,
        model: config.model,
        maxTokens: 2000,
      });
      return response.content;
    },
  };
}

/**
 * Analyze how a flagged dependency is used in the codebase.
 * Only called for non-permissive licenses that need deeper analysis.
 */
export async function analyzeUsage(
  resolved: ResolvedLicense,
  repoPath: string,
  distributionModel: DistributionModel,
  aiProvider: AIProvider
): Promise<UsageAnalysis> {
  const dep = resolved.dependency;

  // 1. Find all files that reference this dependency
  const usageLocations = await findUsageLocations(dep.name, repoPath, dep.ecosystem);

  // 2. Read the source code around usage points
  const codeSnippets = await extractCodeSnippets(usageLocations, dep.name);

  // 3. Use AI to analyze the usage context
  const aiResult = await performAIAnalysis(
    dep.name,
    resolved.license.spdxId || resolved.rawLicense,
    resolved.license.tier,
    codeSnippets,
    distributionModel,
    aiProvider
  );

  return {
    dependency: dep,
    license: resolved,
    usageTypes: aiResult.usageTypes,
    usageLocations: usageLocations.map(l => l.replace(repoPath + '/', '')),
    isModified: aiResult.isModified,
    reasoning: aiResult.reasoning,
    triggersObligations: aiResult.triggersObligations,
  };
}

/**
 * Find all files that import or reference a given package.
 */
export async function findUsageLocations(
  packageName: string,
  repoPath: string,
  ecosystem: string
): Promise<string[]> {
  const locations: string[] = [];
  const maxFiles = 200; // Limit to prevent runaway scanning

  async function walk(dir: string): Promise<void> {
    if (locations.length >= maxFiles) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (locations.length >= maxFiles) return;

      const fullPath = join(dir, entry.name);

      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
        await walk(fullPath);
      } else if (entry.isFile() && CODE_EXTENSIONS.has(extname(entry.name))) {
        try {
          const content = await readFile(fullPath, 'utf-8');
          if (containsImport(content, packageName, ecosystem)) {
            locations.push(fullPath);
          }
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  await walk(repoPath);
  return locations;
}

function containsImport(content: string, packageName: string, ecosystem: string): boolean {
  switch (ecosystem) {
    case 'npm':
      // require('package') or import ... from 'package'
      return content.includes(`'${packageName}'`) ||
             content.includes(`"${packageName}"`) ||
             content.includes(`'${packageName}/`) ||
             content.includes(`"${packageName}/`);
    case 'python':
      return content.includes(`import ${packageName}`) ||
             content.includes(`from ${packageName}`);
    case 'go':
      return content.includes(`"${packageName}"`);
    case 'rust':
      return content.includes(`use ${packageName}`) ||
             content.includes(`extern crate ${packageName}`);
    default:
      return content.includes(packageName);
  }
}

/**
 * Extract relevant code snippets around import/usage points.
 */
export async function extractCodeSnippets(
  filePaths: string[],
  packageName: string
): Promise<string[]> {
  const snippets: string[] = [];
  const maxSnippets = 10;
  const contextLines = 5;

  for (const filePath of filePaths.slice(0, maxSnippets)) {
    try {
      const content = await readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      const relevant: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(packageName)) {
          const start = Math.max(0, i - contextLines);
          const end = Math.min(lines.length, i + contextLines + 1);
          relevant.push(
            `--- ${filePath} (line ${i + 1}) ---`,
            ...lines.slice(start, end)
          );
        }
      }

      if (relevant.length > 0) {
        snippets.push(relevant.join('\n'));
      }
    } catch {
      // Skip
    }
  }

  return snippets;
}

interface AIAnalysisResult {
  usageTypes: UsageType[];
  isModified: boolean;
  reasoning: string;
  triggersObligations: boolean;
}

// Shared prompt loader instance
let promptLoader: PromptLoader | null = null;

function getPromptLoader(): PromptLoader {
  if (!promptLoader) {
    promptLoader = new PromptLoader();
  }
  return promptLoader;
}

async function performAIAnalysis(
  packageName: string,
  licenseId: string,
  licenseTier: string,
  codeSnippets: string[],
  distributionModel: DistributionModel,
  aiProvider: AIProvider
): Promise<AIAnalysisResult> {
  if (codeSnippets.length === 0) {
    return {
      usageTypes: ['unknown'],
      isModified: false,
      reasoning: `No code usage found for ${packageName}. It may be an indirect/transitive dependency or only used at build time.`,
      triggersObligations: false,
    };
  }

  const rendered = await getPromptLoader().getPrompt('usage-analyzer', {
    packageName,
    licenseId,
    licenseTier,
    codeSnippets: codeSnippets.join('\n\n'),
    distributionModel,
  });

  try {
    const response = await aiProvider.analyze(rendered.content);
    return parseAIResponse(response);
  } catch (err) {
    return {
      usageTypes: ['unknown'],
      isModified: false,
      reasoning: `AI analysis failed: ${(err as Error).message}. Manual review recommended.`,
      triggersObligations: true, // Err on the side of caution
    };
  }
}

function parseAIResponse(response: string): AIAnalysisResult {
  const result = parseAndValidate(response, UsageAnalyzerOutputSchema);

  if (result.success) {
    return {
      usageTypes: result.data.usageTypes,
      isModified: result.data.isModified,
      reasoning: result.data.reasoning,
      triggersObligations: result.data.triggersObligations,
    };
  }

  // Validation failed — fall back to cautious defaults
  // Try raw JSON extraction as last resort
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        usageTypes: parsed.usageTypes || ['unknown'],
        isModified: parsed.isModified || false,
        reasoning: parsed.reasoning || 'No reasoning provided',
        triggersObligations: parsed.triggersObligations ?? true,
      };
    }
  } catch {
    // JSON parse failed
  }

  return {
    usageTypes: ['unknown'],
    isModified: false,
    reasoning: response.slice(0, 500),
    triggersObligations: true, // Cautious default
  };
}

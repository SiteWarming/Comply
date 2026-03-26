// ============================================================================
// Usage Analyzer Agent — Determine how a dependency is used (link type, vendored, etc.)
// ============================================================================

import { UsageAnalyzerOutputSchema, type UsageAnalyzerOutput } from '../schemas.js';
import { BaseAgent } from './base.js';

export interface UsageAnalyzerContext {
  packageName: string;
  licenseId: string;
  licenseTier: string;
  codeSnippets: string;
  distributionModel: string;
}

export class UsageAnalyzerAgent extends BaseAgent<UsageAnalyzerOutput> {
  readonly name = 'usage-analyzer';
  readonly promptName = 'usage-analyzer';
  readonly outputSchema = UsageAnalyzerOutputSchema;

  protected buildVariables(context: unknown): Record<string, string> {
    const ctx = context as UsageAnalyzerContext;
    return {
      packageName: ctx.packageName,
      licenseId: ctx.licenseId,
      licenseTier: ctx.licenseTier,
      codeSnippets: ctx.codeSnippets || 'No code snippets found.',
      distributionModel: ctx.distributionModel,
    };
  }
}

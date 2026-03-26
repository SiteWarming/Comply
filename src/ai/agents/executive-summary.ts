// ============================================================================
// Executive Summary Agent — Polish executive summary with AI
// ============================================================================

import { ExecutiveSummaryOutputSchema, type ExecutiveSummaryOutput } from '../schemas.js';
import { BaseAgent } from './base.js';

export interface ExecutiveSummaryContext {
  repoName: string;
  riskScore: string;
  totalDeps: string;
  violations: string;
  needsReview: string;
  keyFindings: string;
  tierDistribution: string;
}

export class ExecutiveSummaryAgent extends BaseAgent<ExecutiveSummaryOutput> {
  readonly name = 'executive-summary';
  readonly promptName = 'executive-summary';
  readonly outputSchema = ExecutiveSummaryOutputSchema;

  protected buildVariables(context: unknown): Record<string, string> {
    const ctx = context as ExecutiveSummaryContext;
    return {
      repoName: ctx.repoName,
      riskScore: ctx.riskScore,
      totalDeps: ctx.totalDeps,
      violations: ctx.violations,
      needsReview: ctx.needsReview,
      keyFindings: ctx.keyFindings,
      tierDistribution: ctx.tierDistribution,
    };
  }
}

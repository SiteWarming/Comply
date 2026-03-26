// ============================================================================
// Obligation Reasoner Agent — Determine if usage triggers license obligations
// ============================================================================

import { ObligationReasonerOutputSchema, type ObligationReasonerOutput } from '../schemas.js';
import { BaseAgent } from './base.js';

export interface ObligationReasonerContext {
  packageName: string;
  licenseId: string;
  licenseTier: string;
  usageTypes: string;
  isModified: string;
  distributionModel: string;
}

export class ObligationReasonerAgent extends BaseAgent<ObligationReasonerOutput> {
  readonly name = 'obligation-reasoner';
  readonly promptName = 'obligation-reasoner';
  readonly outputSchema = ObligationReasonerOutputSchema;

  protected buildVariables(context: unknown): Record<string, string> {
    const ctx = context as ObligationReasonerContext;
    return {
      packageName: ctx.packageName,
      licenseId: ctx.licenseId,
      licenseTier: ctx.licenseTier,
      usageTypes: ctx.usageTypes,
      isModified: ctx.isModified,
      distributionModel: ctx.distributionModel,
    };
  }
}

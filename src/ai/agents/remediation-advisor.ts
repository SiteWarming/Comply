// ============================================================================
// Remediation Advisor Agent — Suggest alternatives for non-compliant dependencies
// ============================================================================

import { RemediationAdvisorOutputSchema, type RemediationAdvisorOutput } from '../schemas.js';
import { BaseAgent } from './base.js';

export interface RemediationAdvisorContext {
  packageName: string;
  ecosystem: string;
  licenseId: string;
  usageContext: string;
}

export class RemediationAdvisorAgent extends BaseAgent<RemediationAdvisorOutput> {
  readonly name = 'remediation-advisor';
  readonly promptName = 'remediation-advisor';
  readonly outputSchema = RemediationAdvisorOutputSchema;

  protected buildVariables(context: unknown): Record<string, string> {
    const ctx = context as RemediationAdvisorContext;
    return {
      packageName: ctx.packageName,
      ecosystem: ctx.ecosystem,
      licenseId: ctx.licenseId,
      usageContext: ctx.usageContext,
    };
  }
}

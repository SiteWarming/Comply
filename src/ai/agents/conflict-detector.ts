// ============================================================================
// Conflict Detector Agent — Detect license compatibility conflicts
// ============================================================================

import { ConflictDetectorOutputSchema, type ConflictDetectorOutput } from '../schemas.js';
import { BaseAgent } from './base.js';

export interface ConflictDetectorContext {
  packages: string;
  distributionModel: string;
}

export class ConflictDetectorAgent extends BaseAgent<ConflictDetectorOutput> {
  readonly name = 'conflict-detector';
  readonly promptName = 'conflict-detector';
  readonly outputSchema = ConflictDetectorOutputSchema;

  protected buildVariables(context: unknown): Record<string, string> {
    const ctx = context as ConflictDetectorContext;
    return {
      packages: ctx.packages,
      distributionModel: ctx.distributionModel,
    };
  }
}

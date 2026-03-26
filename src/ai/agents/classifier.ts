// ============================================================================
// Classifier Agent — Triage dependencies as dev-only, test-only, build-tool, or runtime
// ============================================================================

import { ClassifierOutputSchema, type ClassifierOutput } from '../schemas.js';
import { BaseAgent } from './base.js';

export interface ClassifierContext {
  packageName: string;
  ecosystem: string;
  manifestContext: string;
  codeSnippets: string;
}

export class ClassifierAgent extends BaseAgent<ClassifierOutput> {
  readonly name = 'classifier';
  readonly promptName = 'classifier';
  readonly outputSchema = ClassifierOutputSchema;

  protected buildVariables(context: unknown): Record<string, string> {
    const ctx = context as ClassifierContext;
    return {
      packageName: ctx.packageName,
      ecosystem: ctx.ecosystem,
      manifestContext: ctx.manifestContext,
      codeSnippets: ctx.codeSnippets || 'No code snippets found.',
    };
  }
}

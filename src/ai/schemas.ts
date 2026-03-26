// ============================================================================
// Schemas — Zod output schemas for all AI agents
// ============================================================================

import { z } from 'zod';

// --- Classifier Agent ---

export const ClassifierOutputSchema = z.object({
  classification: z.enum(['dev_only', 'test_only', 'build_tool', 'runtime']),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

export type ClassifierOutput = z.infer<typeof ClassifierOutputSchema>;

// --- Usage Analyzer Agent ---

export const UsageAnalyzerOutputSchema = z.object({
  usageTypes: z.array(z.enum([
    'import', 'static_link', 'dynamic_link', 'dev_only',
    'test_only', 'build_tool', 'vendored', 'modified', 'unknown',
  ])),
  isModified: z.boolean(),
  triggersObligations: z.boolean(),
  reasoning: z.string(),
});

export type UsageAnalyzerOutput = z.infer<typeof UsageAnalyzerOutputSchema>;

// --- Obligation Reasoner Agent ---

export const ObligationReasonerOutputSchema = z.object({
  triggersObligations: z.boolean(),
  obligations: z.array(z.string()),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});

export type ObligationReasonerOutput = z.infer<typeof ObligationReasonerOutputSchema>;

// --- Conflict Detector Agent ---

export const ConflictDetectorOutputSchema = z.object({
  conflicts: z.array(z.object({
    packages: z.array(z.string()),
    licenses: z.array(z.string()),
    reason: z.string(),
    severity: z.enum(['critical', 'high', 'medium', 'low']),
  })),
  reasoning: z.string(),
});

export type ConflictDetectorOutput = z.infer<typeof ConflictDetectorOutputSchema>;

// --- Remediation Advisor Agent ---

export const RemediationAdvisorOutputSchema = z.object({
  alternatives: z.array(z.object({
    name: z.string(),
    license: z.string(),
    description: z.string(),
  })),
  migrationSteps: z.array(z.string()),
  effort: z.enum(['trivial', 'low', 'medium', 'high']),
  reasoning: z.string(),
});

export type RemediationAdvisorOutput = z.infer<typeof RemediationAdvisorOutputSchema>;

// --- Executive Summary Agent ---

export const ExecutiveSummaryOutputSchema = z.object({
  summary: z.string(),
});

export type ExecutiveSummaryOutput = z.infer<typeof ExecutiveSummaryOutputSchema>;

// --- Schema Registry ---

export const SCHEMA_REGISTRY: Record<string, z.ZodSchema> = {
  ClassifierOutput: ClassifierOutputSchema,
  UsageAnalyzerOutput: UsageAnalyzerOutputSchema,
  ObligationReasonerOutput: ObligationReasonerOutputSchema,
  ConflictDetectorOutput: ConflictDetectorOutputSchema,
  RemediationAdvisorOutput: RemediationAdvisorOutputSchema,
  ExecutiveSummaryOutput: ExecutiveSummaryOutputSchema,
};

/**
 * Parse and validate a JSON response against a named schema.
 * Attempts JSON.parse first, falls back to regex extraction of JSON block.
 */
export function parseAndValidate<T>(
  response: string,
  schema: z.ZodSchema<T>
): { success: true; data: T } | { success: false; error: string } {
  let parsed: unknown;

  // Try direct JSON parse
  try {
    parsed = JSON.parse(response);
  } catch {
    // Fall back to extracting JSON from response text
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { success: false, error: 'No JSON found in response' };
    }
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      return { success: false, error: 'Failed to parse extracted JSON' };
    }
  }

  // Validate against schema
  const result = schema.safeParse(parsed);
  if (result.success) {
    return { success: true, data: result.data };
  }

  return {
    success: false,
    error: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
  };
}

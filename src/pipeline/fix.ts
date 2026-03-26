// ============================================================================
// Fix — Auto-resolve obvious compliance issues
// ============================================================================

import YAML from 'yaml';
import type { PolicyEvaluation, Policy } from '../types.js';
import { classifyLicense } from '../state/spdx.js';

export type FixType = 'policy_addition' | 'allowlist' | 'override';

export interface Fix {
  type: FixType;
  package: string;
  version: string;
  license: string;
  action: string;
  reason: string;
}

export interface FixResult {
  fixes: Fix[];
  remaining: PolicyEvaluation[];
  updatedPolicy: Policy;
}

/**
 * Analyze flagged evaluations and generate auto-fixes for obvious safe cases.
 */
export function generateFixes(
  evaluations: PolicyEvaluation[],
  policy: Policy,
): FixResult {
  const fixes: Fix[] = [];
  const remaining: PolicyEvaluation[] = [];

  const flagged = evaluations.filter(e =>
    e.status === 'non_compliant' ||
    e.status === 'needs_review' ||
    e.status === 'conditionally_compliant'
  );

  const licensesToAdd = new Set<string>();

  for (const evaluation of flagged) {
    const dep = evaluation.dependency;
    const spdxId = evaluation.license.license.spdxId;
    const tier = evaluation.license.license.tier;
    const raw = evaluation.license.rawLicense || '';

    // Case 1: Known permissive license not in policy
    if (evaluation.matchedRule === 'no_match' && tier === 'permissive' && spdxId) {
      licensesToAdd.add(spdxId);
      fixes.push({
        type: 'policy_addition',
        package: dep.name,
        version: dep.version,
        license: spdxId,
        action: `Add ${spdxId} to permissive rule in policy`,
        reason: `${spdxId} is a permissive license — safe for all distribution models`,
      });
      continue;
    }

    // Case 2: Conditionally compliant LGPL/MPL in npm (dynamic linking default)
    if (evaluation.status === 'conditionally_compliant' && dep.ecosystem === 'npm') {
      const conditions = evaluation.reason.match(/Conditions: (.+?)[.!]/)?.[1] ?? '';
      const isDynamicLinkCondition = conditions.includes('dynamic_linking_only');
      if (isDynamicLinkCondition) {
        fixes.push({
          type: 'allowlist',
          package: dep.name,
          version: dep.version,
          license: spdxId ?? raw,
          action: `Add ${dep.name} to allowlist`,
          reason: `npm uses dynamic linking by default. ${spdxId ?? raw} conditions are met.`,
        });
        continue;
      }
    }

    // Case 3: Dev dependency in SaaS context
    if (dep.isDev && (policy.distributionModel.default === 'saas' || policy.distributionModel.default === 'internal')) {
      fixes.push({
        type: 'allowlist',
        package: dep.name,
        version: dep.version,
        license: spdxId ?? raw,
        action: `Add ${dep.name} to allowlist`,
        reason: `Dev dependency in ${policy.distributionModel.default} context — not distributed`,
      });
      continue;
    }

    // Not auto-fixable
    remaining.push(evaluation);
  }

  // Build updated policy
  const updatedPolicy = applyPolicyFixes(policy, licensesToAdd, fixes);

  return { fixes, remaining, updatedPolicy };
}

function applyPolicyFixes(
  policy: Policy,
  licensesToAdd: Set<string>,
  fixes: Fix[],
): Policy {
  const updatedRules = { ...policy.licenseRules };

  // Expand permissive rule with new licenses
  if (licensesToAdd.size > 0 && updatedRules.permissive) {
    updatedRules.permissive = {
      ...updatedRules.permissive,
      licenses: [...updatedRules.permissive.licenses, ...licensesToAdd],
    };
  }

  // Expand allowlist with fixed packages
  const allowlistAdditions = fixes
    .filter(f => f.type === 'allowlist')
    .map(f => f.package);

  return {
    ...policy,
    licenseRules: updatedRules,
    allowlist: [...(policy.allowlist ?? []), ...allowlistAdditions],
  };
}

/**
 * Serialize a Policy back to YAML for writing to comply-policy.yaml.
 */
export function serializePolicy(policy: Policy): string {
  const yamlObj: Record<string, any> = {
    version: policy.version,
    distribution_model: {
      default: policy.distributionModel.default,
    },
    license_rules: {} as Record<string, any>,
    severity_levels: policy.severityLevels,
  };

  if (policy.distributionModel.overrides) {
    yamlObj.distribution_model.overrides = policy.distributionModel.overrides;
  }

  for (const [name, rule] of Object.entries(policy.licenseRules)) {
    const entry: Record<string, any> = {
      licenses: rule.licenses,
      action: rule.action,
    };
    if (rule.conditions) entry.conditions = rule.conditions;
    if (rule.reason) entry.reason = rule.reason;
    yamlObj.license_rules[name] = entry;
  }

  if (policy.allowlist && policy.allowlist.length > 0) {
    yamlObj.allowlist = policy.allowlist;
  }
  if (policy.denylist && policy.denylist.length > 0) {
    yamlObj.denylist = policy.denylist;
  }

  return `# Comply OSS — License Policy Configuration\n# Generated/updated by \`comply fix\`\n\n${YAML.stringify(yamlObj)}`;
}

/**
 * Format fix results as a human-readable summary.
 */
export function formatFixSummary(result: FixResult): string {
  const lines: string[] = [];

  if (result.fixes.length === 0) {
    lines.push('No auto-fixable issues found.');
    if (result.remaining.length > 0) {
      lines.push(`${result.remaining.length} item(s) require manual review.`);
    }
    return lines.join('\n');
  }

  lines.push(`Auto-resolved ${result.fixes.length} issue(s):\n`);

  const byType = {
    policy_addition: result.fixes.filter(f => f.type === 'policy_addition'),
    allowlist: result.fixes.filter(f => f.type === 'allowlist'),
    override: result.fixes.filter(f => f.type === 'override'),
  };

  if (byType.policy_addition.length > 0) {
    const licenses = [...new Set(byType.policy_addition.map(f => f.license))];
    lines.push(`  Policy expanded: Added ${licenses.join(', ')} to permissive rule`);
  }

  if (byType.allowlist.length > 0) {
    lines.push(`  Allowlisted: ${byType.allowlist.map(f => f.package).join(', ')}`);
  }

  if (result.remaining.length > 0) {
    lines.push(`\n${result.remaining.length} item(s) still need manual review:`);
    for (const e of result.remaining) {
      lines.push(`  - ${e.dependency.name}: ${e.reason}`);
    }
  }

  return lines.join('\n');
}

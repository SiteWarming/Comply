// ============================================================================
// Policy — Load policy files and evaluate dependencies against rules
// ============================================================================

import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import type {
  Policy, PolicyRule, PolicyAction, DistributionModel, Dependency,
  ResolvedLicense, PolicyEvaluation, ComplianceStatus, Severity,
  RemediationStep, UsageAnalysis, LicenseTier,
} from '../types.js';
import { classifyLicense } from '../state/spdx.js';

/**
 * Load a policy from a YAML file, or return the default policy.
 */
export async function loadPolicy(policyPath?: string): Promise<Policy> {
  if (policyPath) {
    try {
      const content = await readFile(policyPath, 'utf-8');
      const raw = YAML.parse(content);
      return normalizePolicy(raw);
    } catch (err) {
      console.warn(`Warning: Failed to load policy from ${policyPath}, using defaults: ${(err as Error).message}`);
    }
  }
  return getDefaultPolicy();
}

function normalizePolicy(raw: any): Policy {
  return {
    version: raw.version || 1,
    distributionModel: {
      default: raw.distribution_model?.default || 'saas',
      overrides: raw.distribution_model?.overrides,
    },
    licenseRules: raw.license_rules || {},
    severityLevels: raw.severity_levels || getDefaultPolicy().severityLevels,
    allowlist: raw.allowlist || [],
    denylist: raw.denylist || [],
  };
}

export function getDefaultPolicy(): Policy {
  return {
    version: 1,
    distributionModel: {
      default: 'saas',
    },
    licenseRules: {
      permissive: {
        licenses: [
          'MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'ISC', '0BSD',
          'Unlicense', 'CC0-1.0', 'WTFPL', 'Zlib', 'BSL-1.0', 'BlueOak-1.0.0',
          'Artistic-2.0', 'Python-2.0', 'X11', 'CC-BY-4.0', 'CC-BY-3.0',
        ],
        action: 'allow',
      },
      weak_copyleft: {
        licenses: ['LGPL-2.0', 'LGPL-2.1', 'LGPL-3.0', 'MPL-2.0', 'EPL-1.0', 'EPL-2.0', 'EUPL-1.2', 'CC-BY-SA-4.0'],
        action: 'allow_if',
        conditions: ['dynamic_linking_only', 'no_modifications'],
      },
      strong_copyleft: {
        licenses: ['GPL-2.0', 'GPL-3.0'],
        action: 'allow_if',
        conditions: ['internal_use_only'],
      },
      network_copyleft: {
        licenses: ['AGPL-3.0', 'SSPL-1.0'],
        action: 'deny',
        reason: 'Network copyleft licenses require source disclosure for SaaS use',
      },
      non_commercial: {
        licenses: ['CC-BY-NC-4.0', 'CC-BY-NC-SA-4.0', 'CC-BY-NC-ND-4.0'],
        action: 'deny',
        reason: 'Incompatible with commercial use',
      },
    },
    severityLevels: {
      critical: ['AGPL-3.0', 'SSPL-1.0'],
      high: ['GPL-2.0', 'GPL-3.0', 'CC-BY-NC-4.0'],
      medium: ['LGPL-2.0', 'LGPL-2.1', 'LGPL-3.0', 'MPL-2.0', 'EPL-1.0', 'EPL-2.0', 'CC-BY-SA-4.0'],
      low: ['Apache-2.0', 'CC-BY-4.0', 'CC-BY-3.0'],
      none: ['MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'Unlicense', 'BlueOak-1.0.0', 'Artistic-2.0', 'Python-2.0', 'X11', 'CC0-1.0', 'WTFPL', 'Zlib', 'BSL-1.0'],
    },
    allowlist: [],
    denylist: [],
  };
}

/**
 * Evaluate a resolved license against the policy.
 */
export function evaluateLicense(
  resolved: ResolvedLicense,
  policy: Policy,
  usageAnalysis?: UsageAnalysis
): PolicyEvaluation {
  const dep = resolved.dependency;
  const license = resolved.license;

  // Check allowlist
  if (policy.allowlist?.includes(dep.name)) {
    return {
      dependency: dep,
      license: resolved,
      usageAnalysis,
      status: 'compliant',
      severity: 'none',
      reason: `Package ${dep.name} is explicitly allowlisted`,
      matchedRule: 'allowlist',
    };
  }

  // Dev dependencies in SaaS/internal models don't trigger obligations
  // (they are never distributed), except for network copyleft (AGPL)
  const distModel = policy.distributionModel.default;
  if (dep.isDev && (distModel === 'saas' || distModel === 'internal') && license.tier !== 'network_copyleft') {
    return {
      dependency: dep,
      license: resolved,
      usageAnalysis,
      status: 'compliant',
      severity: 'none',
      reason: `Dev dependency in ${distModel} context — license obligations do not apply (no distribution)`,
      matchedRule: 'dev_dependency',
    };
  }

  // Check denylist
  if (policy.denylist?.includes(dep.name)) {
    return {
      dependency: dep,
      license: resolved,
      usageAnalysis,
      status: 'non_compliant',
      severity: 'critical',
      reason: `Package ${dep.name} is explicitly denylisted`,
      matchedRule: 'denylist',
      remediation: [{
        action: 'remove',
        description: `Remove ${dep.name} and find an alternative. This package is on the organization deny list.`,
        effort: 'medium',
      }],
    };
  }

  // Unknown license
  if (license.tier === 'unknown' || !license.spdxId) {
    const raw = (resolved.rawLicense || 'none').toLowerCase();
    const isSeeFile = raw.startsWith('see license in ') || raw.startsWith('see ') && raw.includes('license');
    const isNone = raw === 'none' || raw === 'unlicensed' || raw === '';

    let reason: string;
    let remediation: RemediationStep[];

    if (isSeeFile) {
      reason = `License declared via file reference: "${resolved.rawLicense}". Check the package's LICENSE file — this is usually a standard permissive license (MIT, Apache-2.0).`;
      remediation = [{
        action: 'seek_approval',
        description: `Read the LICENSE file in ${dep.name}'s repository. If it's MIT/Apache-2.0/BSD, add the package to your policy allowlist or run \`comply fix\`.`,
        effort: 'trivial',
      }];
    } else if (isNone) {
      reason = `No license declared for ${dep.name}. This package has no license metadata in the registry.`;
      remediation = [{
        action: 'seek_approval',
        description: `Check ${dep.name}'s repository for a LICENSE file. If no license exists, this package is technically "all rights reserved" and should be replaced or the author contacted.`,
        effort: 'low',
      }];
    } else {
      reason = `License could not be classified: "${resolved.rawLicense}". The SPDX identifier is not recognized.`;
      remediation = [{
        action: 'seek_approval',
        description: `Manually identify the license for ${dep.name}. Check the package repository, then add to your policy file or comply-overrides.yaml.`,
        effort: 'low',
      }];
    }

    return {
      dependency: dep,
      license: resolved,
      usageAnalysis,
      status: 'needs_review',
      severity: 'medium',
      reason,
      matchedRule: 'unknown_license',
      remediation,
    };
  }

  // Find matching rule
  const matchedRuleName = findMatchingRule(license.spdxId, policy);
  if (!matchedRuleName) {
    // No rule matches — treat as needs review
    return {
      dependency: dep,
      license: resolved,
      usageAnalysis,
      status: 'needs_review',
      severity: 'medium',
      reason: `No policy rule matches license ${license.spdxId}`,
      matchedRule: 'no_match',
    };
  }

  const rule = policy.licenseRules[matchedRuleName];
  const severity = determineSeverity(license.spdxId, policy);

  switch (rule.action) {
    case 'allow':
      return {
        dependency: dep,
        license: resolved,
        usageAnalysis,
        status: 'compliant',
        severity,
        reason: `License ${license.spdxId} is allowed under rule "${matchedRuleName}"`,
        matchedRule: matchedRuleName,
        remediation: license.requiresAttribution ? [{
          action: 'add_notice',
          description: `Ensure ${license.spdxId} attribution notice is included in your NOTICES or LICENSE file`,
          effort: 'trivial',
        }] : undefined,
      };

    case 'allow_if':
      return evaluateConditional(dep, resolved, rule, matchedRuleName, severity, policy, usageAnalysis);

    case 'deny':
      return {
        dependency: dep,
        license: resolved,
        usageAnalysis,
        status: 'non_compliant',
        severity,
        reason: rule.reason || `License ${license.spdxId} is denied under rule "${matchedRuleName}"`,
        matchedRule: matchedRuleName,
        remediation: generateDenyRemediation(dep, license.spdxId),
      };

    case 'review':
      return {
        dependency: dep,
        license: resolved,
        usageAnalysis,
        status: 'needs_review',
        severity,
        reason: `License ${license.spdxId} requires manual review under rule "${matchedRuleName}"`,
        matchedRule: matchedRuleName,
        remediation: [{
          action: 'seek_approval',
          description: `Get legal/compliance team approval for use of ${dep.name} under ${license.spdxId}`,
          effort: 'low',
        }],
      };

    default:
      return {
        dependency: dep,
        license: resolved,
        usageAnalysis,
        status: 'needs_review',
        severity: 'medium',
        reason: `Unrecognized policy action: ${rule.action}`,
        matchedRule: matchedRuleName,
      };
  }
}

function evaluateConditional(
  dep: Dependency,
  resolved: ResolvedLicense,
  rule: PolicyRule,
  ruleName: string,
  severity: Severity,
  policy: Policy,
  usageAnalysis?: UsageAnalysis
): PolicyEvaluation {
  const conditions = rule.conditions || [];
  const spdxId = resolved.license.spdxId;

  // Without usage analysis, we can't fully evaluate conditions
  if (!usageAnalysis) {
    // For npm packages, dynamic linking is the default (require/import).
    // LGPL/MPL conditions are typically met without any special action.
    const isNpmDynamic = dep.ecosystem === 'npm' &&
      conditions.includes('dynamic_linking_only') &&
      !conditions.some(c => c !== 'dynamic_linking_only' && c !== 'no_modifications');

    const contextHint = isNpmDynamic
      ? ` In Node.js, packages are dynamically linked via require/import — LGPL conditions are typically met by default unless you vendored or modified the source.`
      : '';

    return {
      dependency: dep,
      license: resolved,
      status: 'conditionally_compliant',
      severity,
      reason: `License ${spdxId} is conditionally allowed under rule "${ruleName}". Conditions: ${conditions.join(', ')}.${contextHint}`,
      matchedRule: ruleName,
      remediation: [{
        action: 'seek_approval',
        description: isNpmDynamic
          ? `Likely compliant — Node.js uses dynamic linking by default. Verify you haven't vendored or patched ${dep.name}'s source. Run \`comply fix\` to auto-approve.`
          : `Verify that usage of ${dep.name} meets conditions: ${conditions.join(', ')}`,
        effort: 'trivial',
      }],
    };
  }

  // With usage analysis, check conditions
  const failedConditions: string[] = [];

  for (const condition of conditions) {
    switch (condition) {
      case 'internal_use_only':
        if (policy.distributionModel.default !== 'internal' && usageAnalysis.triggersObligations) {
          failedConditions.push('internal_use_only');
        }
        break;
      case 'dynamic_linking_only':
        if (usageAnalysis.usageTypes.includes('static_link') || usageAnalysis.usageTypes.includes('vendored')) {
          failedConditions.push('dynamic_linking_only');
        }
        break;
      case 'no_modifications':
        if (usageAnalysis.isModified) {
          failedConditions.push('no_modifications');
        }
        break;
    }
  }

  if (failedConditions.length === 0) {
    return {
      dependency: dep,
      license: resolved,
      usageAnalysis,
      status: 'compliant',
      severity: 'none',
      reason: `License ${spdxId} conditions are met: ${conditions.join(', ')}`,
      matchedRule: ruleName,
    };
  }

  return {
    dependency: dep,
    license: resolved,
    usageAnalysis,
    status: 'non_compliant',
    severity,
    reason: `License ${spdxId} conditions not met: ${failedConditions.join(', ')}`,
    matchedRule: ruleName,
    remediation: failedConditions.map(c => conditionToRemediation(c, dep, spdxId!)),
  };
}

function findMatchingRule(spdxId: string, policy: Policy): string | null {
  const normalized = spdxId.toUpperCase();

  // For compound SPDX expressions (AND/OR), strip to base IDs first
  if (normalized.includes(' AND ') || normalized.includes(' OR ')) {
    // Try each component individually, return the most restrictive match
    const parts = normalized.split(/\s+(?:AND|OR)\s+/).map(p => p.replace(/[()]/g, '').trim());
    const tierOrder = ['permissive', 'weak_copyleft', 'strong_copyleft', 'network_copyleft', 'non_commercial'];
    const isAnd = normalized.includes(' AND ');

    let bestMatch: string | null = null;
    let bestTierIdx = isAnd ? -1 : tierOrder.length;

    for (const part of parts) {
      const match = findMatchingRule(part, policy);
      if (match) {
        const idx = tierOrder.indexOf(match);
        if (isAnd ? idx > bestTierIdx : idx < bestTierIdx) {
          bestTierIdx = idx;
          bestMatch = match;
        }
      }
    }
    return bestMatch;
  }

  for (const [name, rule] of Object.entries(policy.licenseRules)) {
    const ruleIds = rule.licenses.map(l => l.toUpperCase());
    if (ruleIds.includes(normalized)) {
      return name;
    }
    // Handle -only and -or-later suffixes
    for (const ruleId of ruleIds) {
      if (normalized === `${ruleId}-ONLY` || normalized === `${ruleId}-OR-LATER`) {
        return name;
      }
    }
  }

  // Tier-based fallback: if the SPDX DB knows this license's tier,
  // match it to the corresponding policy rule by tier name
  const licenseInfo = classifyLicense(spdxId);
  if (licenseInfo.tier !== 'unknown') {
    const tierToRule: Record<string, string> = {
      permissive: 'permissive',
      weak_copyleft: 'weak_copyleft',
      strong_copyleft: 'strong_copyleft',
      network_copyleft: 'network_copyleft',
      non_commercial: 'non_commercial',
      proprietary: 'non_commercial',
    };
    const fallbackRule = tierToRule[licenseInfo.tier];
    if (fallbackRule && policy.licenseRules[fallbackRule]) {
      return fallbackRule;
    }
  }

  return null;
}

function determineSeverity(spdxId: string, policy: Policy): Severity {
  const normalized = spdxId.toUpperCase();

  // For compound SPDX expressions, check each component and return worst severity
  if (normalized.includes(' AND ') || normalized.includes(' OR ')) {
    const parts = normalized.split(/\s+(?:AND|OR)\s+/).map(p => p.replace(/[()]/g, '').trim());
    const isAnd = normalized.includes(' AND ');
    const severityOrder: Severity[] = ['none', 'low', 'medium', 'high', 'critical'];
    let worstIdx = isAnd ? -1 : severityOrder.length;

    for (const part of parts) {
      const sev = determineSeverity(part, policy);
      const idx = severityOrder.indexOf(sev);
      if (isAnd ? idx > worstIdx : idx < worstIdx) {
        worstIdx = idx;
      }
    }
    return worstIdx >= 0 && worstIdx < severityOrder.length ? severityOrder[worstIdx] : 'medium';
  }

  for (const [severity, licenses] of Object.entries(policy.severityLevels)) {
    if (licenses.map(l => l.toUpperCase()).some(l =>
      normalized === l || normalized === `${l}-ONLY` || normalized === `${l}-OR-LATER`
    )) {
      return severity as Severity;
    }
  }
  return 'medium';
}

function generateDenyRemediation(dep: Dependency, spdxId: string): RemediationStep[] {
  return [
    {
      action: 'replace',
      description: `Find an alternative to ${dep.name} that uses a permissive license (MIT, BSD, Apache-2.0)`,
      effort: 'medium',
    },
    {
      action: 'contact_vendor',
      description: `Contact the maintainer of ${dep.name} about obtaining a commercial license or dual-licensing arrangement`,
      effort: 'high',
    },
  ];
}

function conditionToRemediation(condition: string, dep: Dependency, spdxId: string): RemediationStep {
  switch (condition) {
    case 'internal_use_only':
      return {
        action: 'refactor',
        description: `${dep.name} (${spdxId}) is only allowed for internal use. Either restrict this package to internal tools or find a permissive alternative.`,
        effort: 'high',
      };
    case 'dynamic_linking_only':
      return {
        action: 'refactor',
        description: `${dep.name} (${spdxId}) must be dynamically linked. Refactor to avoid static linking or vendoring.`,
        effort: 'medium',
      };
    case 'no_modifications':
      return {
        action: 'refactor',
        description: `${dep.name} (${spdxId}) must not be modified. Revert modifications or contribute changes upstream.`,
        effort: 'medium',
      };
    default:
      return {
        action: 'seek_approval',
        description: `Condition "${condition}" not met for ${dep.name}. Seek compliance team guidance.`,
        effort: 'low',
      };
  }
}

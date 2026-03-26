// ============================================================================
// Comply OSS — Type Definitions
// ============================================================================

// --- Ecosystem & Dependency Types ---

export type Ecosystem = 'npm' | 'python' | 'go' | 'rust' | 'java' | 'ruby' | 'dotnet' | 'php';

export interface ManifestFile {
  path: string;
  ecosystem: Ecosystem;
  type: 'manifest' | 'lockfile';
}

export interface Dependency {
  name: string;
  version: string;
  ecosystem: Ecosystem;
  isDirect: boolean;
  /** The manifest file that declared this dependency */
  source: string;
}

// --- License Types ---

export type LicenseTier = 'permissive' | 'weak_copyleft' | 'strong_copyleft' | 'network_copyleft' | 'non_commercial' | 'proprietary' | 'unknown';

export interface LicenseInfo {
  spdxId: string | null;
  name: string;
  tier: LicenseTier;
  /** URL to the license text */
  url?: string;
  /** Whether this requires attribution/notice */
  requiresAttribution: boolean;
  /** Whether this requires source disclosure */
  requiresSourceDisclosure: boolean;
  /** Whether this has copyleft obligations */
  copyleft: boolean;
  /** Whether this applies to network use (AGPL) */
  networkCopyleft: boolean;
}

export interface ResolvedLicense {
  dependency: Dependency;
  license: LicenseInfo;
  /** How the license was determined */
  resolvedVia: 'registry' | 'github' | 'license-file' | 'spdx-expression' | 'manual' | 'unknown';
  /** Confidence in the resolution (0-1) */
  confidence: number;
  /** Raw license string from the registry */
  rawLicense: string;
}

// --- Usage Analysis Types ---

export type UsageType = 'static_link' | 'dynamic_link' | 'import' | 'dev_only' | 'test_only' | 'build_tool' | 'vendored' | 'modified' | 'unknown';

export type DistributionModel = 'saas' | 'distributed' | 'internal' | 'library' | 'cli';

export interface UsageAnalysis {
  dependency: Dependency;
  license: ResolvedLicense;
  /** How the dependency is used in the codebase */
  usageTypes: UsageType[];
  /** Files that import/use this dependency */
  usageLocations: string[];
  /** Whether the dependency code has been modified */
  isModified: boolean;
  /** AI-generated reasoning about the usage context */
  reasoning: string;
  /** Whether this specific usage triggers license obligations */
  triggersObligations: boolean;
}

// --- Policy Types ---

export type PolicyAction = 'allow' | 'allow_if' | 'deny' | 'review';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'none';

export interface PolicyRule {
  licenses: string[];
  action: PolicyAction;
  conditions?: string[];
  reason?: string;
}

export interface Policy {
  version: number;
  distributionModel: {
    default: DistributionModel;
    overrides?: Record<string, DistributionModel>;
  };
  licenseRules: Record<string, PolicyRule>;
  severityLevels: Record<Severity, string[]>;
  /** Packages explicitly approved regardless of license */
  allowlist?: string[];
  /** Packages explicitly denied regardless of license */
  denylist?: string[];
}

// --- Evaluation Types ---

export type ComplianceStatus = 'compliant' | 'non_compliant' | 'needs_review' | 'conditionally_compliant';

export interface PolicyEvaluation {
  dependency: Dependency;
  license: ResolvedLicense;
  usageAnalysis?: UsageAnalysis;
  status: ComplianceStatus;
  severity: Severity;
  /** Why this status was determined */
  reason: string;
  /** What rule matched */
  matchedRule: string;
  /** Remediation steps if non-compliant */
  remediation?: RemediationStep[];
}

export interface RemediationStep {
  action: 'replace' | 'add_notice' | 'refactor' | 'remove' | 'add_license_file' | 'seek_approval' | 'contact_vendor';
  description: string;
  /** Effort estimate */
  effort: 'trivial' | 'low' | 'medium' | 'high';
  /** Alternative package suggestion if action is 'replace' */
  alternative?: string;
}

// --- Report Types ---

export interface AuditReport {
  metadata: {
    repoPath: string;
    repoName: string;
    timestamp: string;
    duration: number;
    complyVersion: string;
    ecosystems: Ecosystem[];
  };
  summary: {
    totalDependencies: number;
    directDependencies: number;
    transitiveDependencies: number;
    compliant: number;
    nonCompliant: number;
    needsReview: number;
    conditionallyCompliant: number;
    riskScore: number; // 0-100, 0 = clean
  };
  /** Plain-English executive summary for non-technical stakeholders */
  executiveSummary: string;
  evaluations: PolicyEvaluation[];
  /** License distribution breakdown */
  licenseDistribution: Record<string, number>;
  /** Tier distribution breakdown */
  tierDistribution: Record<LicenseTier, number>;
}

// --- State / Snapshot Types ---

export interface Snapshot {
  id: string;
  timestamp: string;
  repoPath: string;
  dependencies: Dependency[];
  licenses: ResolvedLicense[];
  evaluations: PolicyEvaluation[];
  report: AuditReport;
}

export interface DiffEntry {
  type: 'added' | 'removed' | 'version_changed' | 'license_changed' | 'status_changed';
  dependency: string;
  before?: {
    version?: string;
    license?: string;
    status?: ComplianceStatus;
  };
  after?: {
    version?: string;
    license?: string;
    status?: ComplianceStatus;
  };
}

export interface SnapshotDiff {
  fromSnapshot: string;
  toSnapshot: string;
  timestamp: string;
  entries: DiffEntry[];
  summary: {
    added: number;
    removed: number;
    changed: number;
    newViolations: number;
    resolvedViolations: number;
  };
}

// --- Pipeline Configuration ---

export interface ComplyConfig {
  /** Path to the repo to audit */
  repoPath: string;
  /** Path to the audit state directory */
  auditDir: string;
  /** Path to the policy file */
  policyPath?: string;
  /** Whether to run AI-powered usage analysis */
  enableAIAnalysis: boolean;
  /** AI provider configuration */
  ai?: {
    provider: 'anthropic' | 'openrouter';
    model?: string;
    apiKey?: string;
  };
  /** Only analyze these ecosystems */
  ecosystems?: Ecosystem[];
  /** Maximum number of dependencies to analyze with AI */
  aiAnalysisLimit?: number;
  /** AI analysis tier ceiling: budget (free only), balanced (free+mid), premium (all) */
  aiTier?: 'budget' | 'balanced' | 'premium';
  /** Whether to run in diff-only mode (only analyze changes since last snapshot) */
  diffOnly: boolean;
  /** Verbosity level */
  verbose: boolean;
}

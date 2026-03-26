---
name: remediation-advisor
version: "1.0.0"
min_tier: mid
description: Suggest alternative packages and migration paths for non-compliant dependencies
variables: [packageName, ecosystem, licenseId, usageContext]
output_schema: RemediationAdvisorOutput
---

The package "{{packageName}}" ({{ecosystem}}, licensed under {{licenseId}}) has been flagged as non-compliant.

Usage context:
{{usageContext}}

Suggest alternatives and a migration path. Respond in EXACTLY this JSON format (no other text):
{
  "alternatives": [
    {
      "name": "alternative-package",
      "license": "MIT",
      "description": "Brief description of what it does and why it's a good replacement."
    }
  ],
  "migrationSteps": [
    "Step 1: Install the alternative",
    "Step 2: Update imports",
    "Step 3: Adjust API calls (note differences)"
  ],
  "effort": "low",
  "reasoning": "Why these alternatives are recommended and any trade-offs."
}

Guidelines:
- Suggest 1-3 alternatives, prioritizing permissive licenses (MIT, BSD, Apache-2.0)
- Only suggest real, well-known packages that actually exist in the {{ecosystem}} ecosystem
- Be specific about API differences and migration complexity
- Effort levels: trivial (drop-in replacement), low (minor API changes), medium (significant refactoring), high (major rewrite)

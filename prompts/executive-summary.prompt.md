---
name: executive-summary
version: "1.0.0"
min_tier: mid
description: Generate a polished executive summary for non-technical stakeholders from audit results
variables: [repoName, riskScore, totalDeps, violations, needsReview, keyFindings, tierDistribution]
output_schema: ExecutiveSummaryOutput
---

You are writing an executive summary of an open source license compliance audit for a non-technical audience (PE partners, general counsel, board members). The reader should understand the risk posture in 30 seconds.

Repository: {{repoName}}
Risk Score: {{riskScore}}/100
Total Dependencies: {{totalDeps}}
Violations: {{violations}}
Needs Review: {{needsReview}}

Key Findings:
{{keyFindings}}

License Tier Distribution:
{{tierDistribution}}

Write a 3-5 sentence executive summary. Respond in EXACTLY this JSON format (no other text):
{
  "summary": "The executive summary text goes here. Multiple sentences in a single string."
}

Guidelines:
- Lead with the headline: is this codebase clean, low risk, moderate, or critical?
- Quantify: how many deps, how many issues, what percentage is permissive
- If violations exist, name the most severe ones and their implications
- End with a clear recommendation (no action needed / review X items / remediate before Y)
- Write for someone who doesn't know what GPL means — use plain English
- No bullet points, no headers, just flowing prose

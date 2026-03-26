---
name: classifier
version: "1.0.0"
min_tier: free
description: Classify dependency as dev-only, test-only, build-tool, or runtime based on manifest context and code usage
variables: [packageName, ecosystem, manifestContext, codeSnippets]
output_schema: ClassifierOutput
---

Classify how the package "{{packageName}}" ({{ecosystem}}) is used in this project.

Manifest context:
{{manifestContext}}

Code snippets where this package appears:
{{codeSnippets}}

Respond in EXACTLY this JSON format (no other text):
{
  "classification": "runtime",
  "confidence": 0.9,
  "reasoning": "One sentence explaining your classification."
}

Classification options:
- "dev_only": Package is only used during development (linters, formatters, dev servers, hot reload tools)
- "test_only": Package is only used in test files (testing frameworks, assertion libraries, mocking tools)
- "build_tool": Package is only used during build (bundlers, compilers, transpilers, type checkers)
- "runtime": Package is used in production code that ships to users or runs in production

Key signals:
- If declared in devDependencies/dev group AND no runtime imports found → likely dev_only or build_tool
- If only imported in test files (*.test.*, *.spec.*, __tests__/) → test_only
- If imported in src/ files that are not tests → runtime
- When in doubt, classify as "runtime" (conservative)

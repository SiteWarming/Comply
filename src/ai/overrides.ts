// ============================================================================
// Overrides — Load and apply user corrections to AI decisions
// ============================================================================

import { readFile } from 'node:fs/promises';
import YAML from 'yaml';

export interface Override {
  package: string;
  version?: string;
  field: 'classification' | 'triggersObligations' | 'usageTypes' | 'isModified';
  value: unknown;
  reason: string;
}

export interface OverrideFile {
  overrides: Override[];
}

/**
 * Load overrides from a YAML file.
 * Returns empty array if file doesn't exist.
 */
export async function loadOverrides(path?: string): Promise<Override[]> {
  if (!path) return [];

  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = YAML.parse(raw) as OverrideFile;
    return parsed?.overrides ?? [];
  } catch {
    return [];
  }
}

/**
 * Find an override for a specific package + field combo.
 */
export function findOverride(
  overrides: Override[],
  packageName: string,
  packageVersion: string,
  field: Override['field']
): Override | undefined {
  return overrides.find(o =>
    o.package === packageName &&
    o.field === field &&
    (!o.version || o.version === packageVersion)
  );
}

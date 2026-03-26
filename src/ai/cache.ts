// ============================================================================
// AI Cache — File-based caching for AI analysis results
// ============================================================================

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

interface AICacheEntry {
  key: string;
  agentName: string;
  packageName: string;
  packageVersion: string;
  promptVersion: string;
  model: string;
  result: unknown;
  cachedAt: string;
  expiresAt: string;
}

export class AICache {
  private readonly cacheDir: string;
  private readonly ttlMs: number;

  constructor(auditDir: string, ttlDays = 30) {
    this.cacheDir = join(auditDir, 'cache', 'ai');
    this.ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  }

  /**
   * Generate a cache key from the inputs that affect the result.
   */
  static makeKey(
    packageName: string,
    packageVersion: string,
    promptVersion: string,
    model: string
  ): string {
    const input = `${packageName}@${packageVersion}:${promptVersion}:${model}`;
    return createHash('sha256').update(input).digest('hex');
  }

  /**
   * Get a cached result for a given agent and key.
   */
  async get<T>(agentName: string, key: string): Promise<T | null> {
    try {
      const path = this.getPath(agentName, key);
      const raw = await readFile(path, 'utf-8');
      const entry = JSON.parse(raw) as AICacheEntry;

      // Check expiry
      if (new Date(entry.expiresAt).getTime() < Date.now()) {
        return null;
      }

      return entry.result as T;
    } catch {
      return null;
    }
  }

  /**
   * Store a result in the cache.
   */
  async set(
    agentName: string,
    key: string,
    result: unknown,
    meta: {
      packageName: string;
      packageVersion: string;
      promptVersion: string;
      model: string;
    }
  ): Promise<void> {
    const now = new Date();
    const entry: AICacheEntry = {
      key,
      agentName,
      packageName: meta.packageName,
      packageVersion: meta.packageVersion,
      promptVersion: meta.promptVersion,
      model: meta.model,
      result,
      cachedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
    };

    try {
      const path = this.getPath(agentName, key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(entry, null, 2));
    } catch {
      // Cache write failures are non-fatal
    }
  }

  private getPath(agentName: string, key: string): string {
    return join(this.cacheDir, agentName, `${key}.json`);
  }
}

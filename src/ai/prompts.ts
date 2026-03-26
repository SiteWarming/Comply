// ============================================================================
// Prompt Loader — Load and render prompt files from the prompts/ directory
// ============================================================================

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import type { ModelTier } from './types.js';

export interface PromptMetadata {
  name: string;
  version: string;
  minTier: ModelTier;
  description: string;
  variables: string[];
  outputSchema: string;
}

export interface LoadedPrompt {
  metadata: PromptMetadata;
  body: string;
}

export interface RenderedPrompt {
  content: string;
  version: string;
  minTier: ModelTier;
  outputSchemaName: string;
}

const FRONT_MATTER_REGEX = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

function parseFrontMatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const match = raw.match(FRONT_MATTER_REGEX);
  if (!match) {
    throw new Error('Prompt file missing YAML front-matter (---\\n...\\n---)');
  }
  return {
    meta: YAML.parse(match[1]),
    body: match[2].trim(),
  };
}

function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in variables)) {
      throw new Error(`Missing prompt variable: {{${key}}}`);
    }
    return variables[key];
  });
}

export class PromptLoader {
  private readonly promptsDir: string;
  private cache: Map<string, LoadedPrompt> = new Map();
  private loaded = false;

  constructor(promptsDir?: string) {
    this.promptsDir = promptsDir ?? resolve(process.cwd(), 'prompts');
  }

  /**
   * Load all prompt files from the prompts directory.
   * Called lazily on first getPrompt() call.
   */
  private async loadAll(): Promise<void> {
    if (this.loaded) return;

    let files: string[];
    try {
      files = await readdir(this.promptsDir);
    } catch {
      throw new Error(`Prompts directory not found: ${this.promptsDir}`);
    }

    const promptFiles = files.filter(f => f.endsWith('.prompt.md'));

    for (const file of promptFiles) {
      const raw = await readFile(join(this.promptsDir, file), 'utf-8');
      const { meta, body } = parseFrontMatter(raw);

      const metadata: PromptMetadata = {
        name: meta.name as string,
        version: meta.version as string,
        minTier: meta.min_tier as ModelTier,
        description: meta.description as string,
        variables: (meta.variables as string[]) ?? [],
        outputSchema: meta.output_schema as string,
      };

      this.cache.set(metadata.name, { metadata, body });
    }

    this.loaded = true;
  }

  /**
   * Get a prompt by name and render it with the given variables.
   */
  async getPrompt(name: string, variables: Record<string, string>): Promise<RenderedPrompt> {
    await this.loadAll();

    const loaded = this.cache.get(name);
    if (!loaded) {
      const available = [...this.cache.keys()].join(', ');
      throw new Error(`Prompt not found: "${name}". Available: ${available}`);
    }

    const content = renderTemplate(loaded.body, variables);

    return {
      content,
      version: loaded.metadata.version,
      minTier: loaded.metadata.minTier,
      outputSchemaName: loaded.metadata.outputSchema,
    };
  }

  /**
   * Get raw metadata for a prompt without rendering.
   */
  async getMetadata(name: string): Promise<PromptMetadata> {
    await this.loadAll();

    const loaded = this.cache.get(name);
    if (!loaded) {
      throw new Error(`Prompt not found: "${name}"`);
    }

    return loaded.metadata;
  }

  /**
   * List all available prompt names.
   */
  async listPrompts(): Promise<string[]> {
    await this.loadAll();
    return [...this.cache.keys()];
  }
}

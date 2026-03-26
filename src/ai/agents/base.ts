// ============================================================================
// Base Agent — Abstract base for all AI agents
// ============================================================================

import type { z } from 'zod';
import type { AIProvider, ModelTier, CompletionRequest } from '../types.js';
import { PromptLoader, type RenderedPrompt } from '../prompts.js';
import { parseAndValidate } from '../schemas.js';

const SYSTEM_PROMPT = `You are a precise, technical AI assistant specializing in open source license compliance analysis. Always respond with valid JSON matching the exact schema requested. Do not include any text outside the JSON object.`;

export interface AgentResult<T> {
  data: T;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cached: boolean;
}

export abstract class BaseAgent<TOutput> {
  abstract readonly name: string;
  abstract readonly promptName: string;
  abstract readonly outputSchema: z.ZodSchema<TOutput>;

  protected readonly provider: AIProvider;
  protected readonly promptLoader: PromptLoader;

  constructor(provider: AIProvider, promptLoader: PromptLoader) {
    this.provider = provider;
    this.promptLoader = promptLoader;
  }

  /**
   * Build the prompt variables from the agent-specific context.
   * Subclasses implement this to map their domain data to prompt variables.
   */
  protected abstract buildVariables(context: unknown): Record<string, string>;

  /**
   * Execute the agent: render prompt, call provider, validate output.
   */
  async execute(context: unknown): Promise<AgentResult<TOutput>> {
    const variables = this.buildVariables(context);
    const rendered = await this.promptLoader.getPrompt(this.promptName, variables);

    const response = await this.callProvider(rendered);
    const parsed = parseAndValidate(response.content, this.outputSchema);

    if (parsed.success) {
      return {
        data: parsed.data,
        model: response.model,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        cached: false,
      };
    }

    // Retry once with error feedback
    const retryResponse = await this.callProviderWithRetry(rendered, response.content, parsed.error);
    const retryParsed = parseAndValidate(retryResponse.content, this.outputSchema);

    if (retryParsed.success) {
      return {
        data: retryParsed.data,
        model: retryResponse.model,
        inputTokens: response.inputTokens + retryResponse.inputTokens,
        outputTokens: response.outputTokens + retryResponse.outputTokens,
        cached: false,
      };
    }

    throw new Error(
      `Agent "${this.name}" failed to produce valid output after retry. ` +
      `Validation error: ${retryParsed.error}`
    );
  }

  private async callProvider(rendered: RenderedPrompt): Promise<{
    content: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
  }> {
    const request: CompletionRequest = {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: rendered.content },
      ],
      tier: rendered.minTier,
      responseFormat: this.provider.supportsJsonMode ? 'json' : 'text',
      maxTokens: 2000,
      temperature: 0,
    };

    const response = await this.provider.complete(request);

    return {
      content: response.content,
      model: response.model,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
    };
  }

  private async callProviderWithRetry(
    originalPrompt: RenderedPrompt,
    previousResponse: string,
    validationError: string
  ): Promise<{
    content: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
  }> {
    const request: CompletionRequest = {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: originalPrompt.content },
        { role: 'assistant', content: previousResponse },
        {
          role: 'user',
          content: `Your response had invalid JSON. Validation error: ${validationError}. Please respond again with ONLY valid JSON matching the exact schema requested.`,
        },
      ],
      tier: originalPrompt.minTier,
      responseFormat: this.provider.supportsJsonMode ? 'json' : 'text',
      maxTokens: 2000,
      temperature: 0,
    };

    const response = await this.provider.complete(request);

    return {
      content: response.content,
      model: response.model,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
    };
  }
}

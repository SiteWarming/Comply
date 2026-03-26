// ============================================================================
// OpenRouter Provider — OpenAI-compatible REST API via native fetch
// ============================================================================

import type { AIProvider, AIProviderName, CompletionRequest, CompletionResponse } from '../types.js';
import { ModelRouter } from '../router.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export class OpenRouterProvider implements AIProvider {
  readonly name: AIProviderName = 'openrouter';
  readonly supportsJsonMode = true;

  private readonly apiKey: string;
  private readonly router: ModelRouter;

  constructor(apiKey: string, router: ModelRouter) {
    this.apiKey = apiKey;
    this.router = router;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const model = request.model ?? this.router.selectModel(request.tier);

    const body: Record<string, unknown> = {
      model,
      messages: request.messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
      max_tokens: request.maxTokens ?? 2000,
      temperature: request.temperature ?? 0,
    };

    if (request.responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
    }

    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/comply-oss/comply',
        'X-Title': 'Comply OSS',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'unknown error');
      throw new Error(`OpenRouter API error (${response.status}): ${errorBody}`);
    }

    const data = await response.json() as OpenRouterResponse;

    const choice = data.choices?.[0];
    if (!choice?.message?.content) {
      throw new Error('OpenRouter returned empty response');
    }

    return {
      content: choice.message.content,
      model: data.model ?? model,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
    };
  }
}

interface OpenRouterResponse {
  id: string;
  model?: string;
  choices?: Array<{
    message?: {
      role: string;
      content: string;
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

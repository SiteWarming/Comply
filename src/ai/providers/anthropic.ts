// ============================================================================
// Anthropic Provider — Direct Anthropic SDK for users with Anthropic API keys
// ============================================================================

import type { AIProvider, AIProviderName, CompletionRequest, CompletionResponse } from '../types.js';
import { ModelRouter } from '../router.js';

export class AnthropicProvider implements AIProvider {
  readonly name: AIProviderName = 'anthropic';
  readonly supportsJsonMode = false;

  private readonly apiKey: string;
  private readonly router: ModelRouter;
  private clientPromise: Promise<InstanceType<any>> | null = null;

  constructor(apiKey: string, router: ModelRouter) {
    this.apiKey = apiKey;
    this.router = router;
  }

  private async getClient(): Promise<InstanceType<any>> {
    if (!this.clientPromise) {
      this.clientPromise = import('@anthropic-ai/sdk').then(
        ({ default: Anthropic }) => new Anthropic({ apiKey: this.apiKey })
      );
    }
    return this.clientPromise;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const client = await this.getClient();
    const model = request.model ?? this.router.selectModel(request.tier);

    // Separate system message from conversation messages
    const systemMessage = request.messages.find(m => m.role === 'system');
    const conversationMessages = request.messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const params: Record<string, unknown> = {
      model,
      max_tokens: request.maxTokens ?? 2000,
      messages: conversationMessages,
    };

    if (systemMessage) {
      params.system = systemMessage.content;
    }

    const response = await client.messages.create(params);

    const content = response.content
      .filter((block: { type: string }) => block.type === 'text')
      .map((block: { type: string; text: string }) => block.text)
      .join('\n');

    return {
      content,
      model: response.model ?? model,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      },
    };
  }
}

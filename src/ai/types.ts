// ============================================================================
// AI Types — Shared type definitions for the AI subsystem
// ============================================================================

export type ModelTier = 'free' | 'mid' | 'premium';

export type AIProviderName = 'openrouter' | 'anthropic';

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  messages: Message[];
  /** Specific model override (bypasses tier routing) */
  model?: string;
  /** Minimum capability tier for model selection */
  tier: ModelTier;
  /** Request JSON-formatted response */
  responseFormat?: 'json' | 'text';
  maxTokens?: number;
  temperature?: number;
}

export interface CompletionResponse {
  content: string;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface AIProvider {
  readonly name: AIProviderName;
  readonly supportsJsonMode: boolean;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}

export interface ModelConfig {
  free: string[];
  mid: string[];
  premium: string[];
}

export interface AIConfig {
  provider: AIProviderName;
  tier: ModelTier;
  apiKey?: string;
  models?: Partial<ModelConfig>;
  cacheTtlDays?: number;
  overridesFile?: string;
}

export const DEFAULT_MODEL_CONFIG: Record<AIProviderName, ModelConfig> = {
  openrouter: {
    free: ['google/gemini-flash-1.5', 'deepseek/deepseek-chat'],
    mid: ['anthropic/claude-sonnet-4-20250514', 'openai/gpt-4o-mini'],
    premium: ['anthropic/claude-opus-4-20250514', 'openai/gpt-4o'],
  },
  anthropic: {
    free: ['claude-haiku-4-5-20251001'],
    mid: ['claude-sonnet-4-20250514'],
    premium: ['claude-opus-4-20250514'],
  },
};

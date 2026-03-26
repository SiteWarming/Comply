// ============================================================================
// Provider Factory — Create the appropriate AI provider from config
// ============================================================================

import type { AIProvider, AIConfig, AIProviderName } from './types.js';
import { ModelRouter } from './router.js';
import { OpenRouterProvider } from './providers/openrouter.js';
import { AnthropicProvider } from './providers/anthropic.js';

/**
 * Detect which provider to use based on available API keys.
 * Prefers OpenRouter (broader model access). Falls back to Anthropic.
 */
function detectProvider(config: Partial<AIConfig>): { provider: AIProviderName; apiKey: string } {
  // Explicit config takes priority
  if (config.provider && config.apiKey) {
    return { provider: config.provider, apiKey: config.apiKey };
  }

  // Check environment variables
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (config.provider === 'openrouter') {
    const key = config.apiKey ?? openrouterKey;
    if (!key) throw new Error('OpenRouter API key required. Set OPENROUTER_API_KEY or use --ai-key.');
    return { provider: 'openrouter', apiKey: key };
  }

  if (config.provider === 'anthropic') {
    const key = config.apiKey ?? anthropicKey;
    if (!key) throw new Error('Anthropic API key required. Set ANTHROPIC_API_KEY or use --ai-key.');
    return { provider: 'anthropic', apiKey: key };
  }

  // Auto-detect: prefer OpenRouter
  if (openrouterKey) {
    return { provider: 'openrouter', apiKey: openrouterKey };
  }
  if (anthropicKey) {
    return { provider: 'anthropic', apiKey: anthropicKey };
  }

  throw new Error(
    'No AI API key found. Set OPENROUTER_API_KEY (recommended) or ANTHROPIC_API_KEY, or use --ai-key.'
  );
}

/**
 * Create an AI provider from configuration.
 */
export function createProvider(config: Partial<AIConfig> = {}): AIProvider {
  const { provider, apiKey } = detectProvider(config);
  const router = new ModelRouter(provider, config.models);

  switch (provider) {
    case 'openrouter':
      return new OpenRouterProvider(apiKey, router);
    case 'anthropic':
      return new AnthropicProvider(apiKey, router);
    default:
      throw new Error(`Unsupported AI provider: ${provider}`);
  }
}

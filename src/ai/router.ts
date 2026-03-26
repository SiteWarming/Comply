// ============================================================================
// Router — Maps model tiers to specific model IDs
// ============================================================================

import type { ModelTier, ModelConfig, AIProviderName } from './types.js';
import { DEFAULT_MODEL_CONFIG } from './types.js';

export class ModelRouter {
  private readonly config: ModelConfig;

  constructor(provider: AIProviderName, overrides?: Partial<ModelConfig>) {
    const defaults = DEFAULT_MODEL_CONFIG[provider];
    this.config = {
      free: overrides?.free ?? defaults.free,
      mid: overrides?.mid ?? defaults.mid,
      premium: overrides?.premium ?? defaults.premium,
    };
  }

  /**
   * Select the best available model for a given tier.
   * Returns the first model in the tier's list (primary preference).
   */
  selectModel(tier: ModelTier): string {
    const models = this.config[tier];
    if (models.length === 0) {
      throw new Error(`No models configured for tier: ${tier}`);
    }
    return models[0];
  }

  /**
   * Get all models configured for a tier.
   */
  getModels(tier: ModelTier): readonly string[] {
    return this.config[tier];
  }
}

import type { ModelPriceRates } from './ModelPriceCatalog';

/** The token counts one call spent, as `usage_calls` records them. */
export interface CallTokenCounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationTokens: number;
  readonly cacheReadTokens: number;
}

/** What one call cost, and what running it locally avoided. */
export interface CallCost {
  /** Real money spent upstream. Always zero for a call served locally. */
  readonly spendUsd: number;
  /** What a cloud model would have charged for the same tokens. Zero for a cloud call. */
  readonly savedUsd: number;
}

const NO_COST: CallCost = { spendUsd: 0, savedUsd: 0 };

/**
 * Prices one model call.
 *
 * The four kinds of token are charged at four different rates - on `gpt-5.6-terra` a
 * cache-read token costs a tenth of an input token - so a cost is only ever computed
 * from the split, never from a total. Collapsing 19,924 mixed tokens onto the input rate
 * overstates a real row by about 17%.
 *
 * Spend and saved are the same arithmetic at different rates. A cloud call is priced at
 * its own model's rates and saved nothing; a local call spent nothing and is priced at
 * the rates of the cloud model it stood in for.
 */
export class CallCostCalculator {
  /** What a cloud call cost, charged at the rates of the model that served it. */
  static cloudCall(tokens: CallTokenCounts, rates: ModelPriceRates | null): CallCost {
    return { spendUsd: CallCostCalculator.priceAt(tokens, rates), savedUsd: 0 };
  }

  /**
   * What a local call avoided: the same tokens, charged at the cloud model's rates.
   * `null` rates mean nothing prices the alternative, so nothing is claimed as saved.
   */
  static localCall(tokens: CallTokenCounts, cloudRates: ModelPriceRates | null): CallCost {
    return { spendUsd: 0, savedUsd: CallCostCalculator.priceAt(tokens, cloudRates) };
  }

  /** Neither priced nor free: a call whose model nothing knows the rates for. */
  static unpriced(): CallCost {
    return NO_COST;
  }

  /**
   * The one cost formula, bucket by bucket.
   *
   * Cache rates fall back to the input rate: a model that publishes no cache price
   * charges for those tokens as ordinary input, which is nearer the truth than free.
   */
  private static priceAt(tokens: CallTokenCounts, rates: ModelPriceRates | null): number {
    if (!rates) return 0;

    const inputRate = CallCostCalculator.rate(rates.input_cost_per_token);
    const total =
      tokens.inputTokens * inputRate +
      tokens.outputTokens * CallCostCalculator.rate(rates.output_cost_per_token) +
      tokens.cacheCreationTokens *
        CallCostCalculator.rate(rates.cache_creation_input_token_cost, inputRate) +
      tokens.cacheReadTokens *
        CallCostCalculator.rate(rates.cache_read_input_token_cost, inputRate);

    // A negative or non-finite rate in a published file must not reach a money figure.
    return Number.isFinite(total) && total > 0 ? total : 0;
  }

  private static rate(published: number | undefined, fallback = 0): number {
    return typeof published === 'number' && Number.isFinite(published) && published >= 0
      ? published
      : fallback;
  }
}

export default CallCostCalculator;

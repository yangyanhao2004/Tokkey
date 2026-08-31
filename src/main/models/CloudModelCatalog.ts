import type { CloudModelCard } from '../../shared/types';

/** The variable holding the key the cloud cards authenticate with. */
const CLOUD_API_KEY_VARIABLE = 'TOK_API_KEY';

/**
 * The cloud offerings this build can connect to.
 *
 * These are hardcoded on purpose: the card is a product decision shipped with
 * the app, not user input and not (yet) a remote catalog. The renderer receives
 * the same objects and draws one connect card per entry.
 *
 * Each `id` is a fixed UUID that becomes the id of the model profile created
 * when the card is connected. Because it is stable, reconnecting a card resolves
 * its existing profile by primary key instead of matching on mutable fields,
 * and can never produce a second profile for the same card.
 *
 * The cards carry no `apiKey`: the credential is not a product decision, so it
 * is read from the environment when a card is served.
 */
const CLOUD_MODEL_CARDS: readonly Omit<CloudModelCard, 'apiKey'>[] = [
  {
    id: 'c0544234-d84a-4764-99eb-f39fdefa8add',
    provider: 'custom',
    modelName: 'gpt-5.6-terra',
    url: 'https://api.onetokens.net',
    prefix: 'openai'
  }
];

/** Serves the in-memory cloud model cards and resolves them by id. */
export class CloudModelCatalog {
  private readonly cards: readonly Omit<CloudModelCard, 'apiKey'>[];

  constructor(cards: readonly Omit<CloudModelCard, 'apiKey'>[] = CLOUD_MODEL_CARDS) {
    // Copied so no caller can mutate the shipped catalog through a returned card.
    this.cards = cards.map((card) => ({ ...card }));
  }

  /** Every connectable card, in display order. */
  list(): CloudModelCard[] {
    const apiKey = this.apiKey();
    return this.cards.map((card) => ({ ...card, apiKey }));
  }

  /** Resolves one card by id, failing loudly for an unknown one. */
  require(cardId: string): CloudModelCard {
    const card = this.cards.find((candidate) => candidate.id === cardId);
    if (!card) {
      throw new Error(`Cloud model card not found: ${cardId}`);
    }
    return { ...card, apiKey: this.apiKey() };
  }

  /**
   * The key every card authenticates with.
   *
   * Read per call rather than cached so a process-level override is reflected
   * immediately. An absent key stays empty, allowing the gateway to use the
   * caller's request credential instead of a credential read from disk.
   */
  private apiKey(): string {
    return process.env[CLOUD_API_KEY_VARIABLE] ?? '';
  }
}

export default CloudModelCatalog;

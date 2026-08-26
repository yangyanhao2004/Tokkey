import type { CloudModelCard } from '../../shared/types';

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
 * `apiKey` is intentionally empty. The card is served by the Amis cloud gateway,
 * which will trade a router key for a cloud key once that exchange exists; until
 * then the route carries no credential.
 */
const CLOUD_MODEL_CARDS: readonly CloudModelCard[] = [
  {
    id: 'c0544234-d84a-4764-99eb-f39fdefa8add',
    provider: 'custom',
    modelName: 'gpt-5.6-terra',
    url: 'https://api.onetokens.net',
    prefix: 'openai',
    apiKey: ''
  }
];

/** Serves the in-memory cloud model cards and resolves them by id. */
export class CloudModelCatalog {
  private readonly cards: CloudModelCard[];

  constructor(cards: readonly CloudModelCard[] = CLOUD_MODEL_CARDS) {
    // Copied so no caller can mutate the shipped catalog through a returned card.
    this.cards = cards.map((card) => ({ ...card }));
  }

  /** Every connectable card, in display order. */
  list(): CloudModelCard[] {
    return this.cards.map((card) => ({ ...card }));
  }

  /** Resolves one card by id, failing loudly for an unknown one. */
  require(cardId: string): CloudModelCard {
    const card = this.cards.find((candidate) => candidate.id === cardId);
    if (!card) {
      throw new Error(`Cloud model card not found: ${cardId}`);
    }
    return { ...card };
  }
}

export default CloudModelCatalog;

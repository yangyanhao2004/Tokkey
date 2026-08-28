import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CloudModelCard } from '../../shared/types';

/** The variable holding the key the cloud cards authenticate with. */
const CLOUD_API_KEY_VARIABLE = 'TOK_API_KEY';

/**
 * Reads `KEY=value` lines out of a dotenv file.
 *
 * The app is normally launched from Finder, which gives it none of the shell's
 * environment, so the key has to come off disk. A missing file or missing
 * variable reads as empty rather than throwing: an unconfigured machine should
 * still show its cards.
 */
export class EnvFile {
  private readonly filePath: string;

  constructor(filePath: string = path.join(os.homedir(), '.env')) {
    this.filePath = filePath;
  }

  /** The value of one variable, or an empty string when it is not set. */
  read(name: string): string {
    for (const line of this.lines()) {
      const separatorIndex = line.indexOf('=');
      if (separatorIndex === -1) continue;
      if (line.slice(0, separatorIndex).trim() !== name) continue;
      return this.unquote(line.slice(separatorIndex + 1).trim());
    }
    return '';
  }

  /** The file's assignment lines, skipping blanks and `#` comments. */
  private lines(): string[] {
    try {
      return fs
        .readFileSync(this.filePath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'));
    } catch {
      return [];
    }
  }

  /** Drops the matching quotes a dotenv value may be wrapped in. */
  private unquote(value: string): string {
    const isQuoted =
      value.length >= 2 &&
      (value.startsWith('"') || value.startsWith("'")) &&
      value.endsWith(value.charAt(0));
    return isQuoted ? value.slice(1, -1) : value;
  }
}

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
  private readonly envFile: EnvFile;

  constructor(
    cards: readonly Omit<CloudModelCard, 'apiKey'>[] = CLOUD_MODEL_CARDS,
    envFile: EnvFile = new EnvFile()
  ) {
    // Copied so no caller can mutate the shipped catalog through a returned card.
    this.cards = cards.map((card) => ({ ...card }));
    this.envFile = envFile;
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
   * Read per call rather than cached, so a key written to `~/.env` after launch
   * takes effect on the next connect instead of requiring a restart. A real
   * environment variable wins, which is what makes the key overridable when the
   * app is started from a shell.
   */
  private apiKey(): string {
    return process.env[CLOUD_API_KEY_VARIABLE] ?? this.envFile.read(CLOUD_API_KEY_VARIABLE);
  }
}

export default CloudModelCatalog;

/** One Claude model the gateway can offer, as its picker entry needs it. */
export interface ClaudeNativeModel {
  /** The model id Anthropic accepts on the wire, e.g. `claude-opus-5`. */
  slug: string;
  displayName: string;
}

/**
 * The Claude models Tokkey's gateway advertises.
 *
 * Unlike the Codex catalog, this list is static. Codex ships a bundled catalog
 * its CLI will print, so `CodexNativeModelCatalog` derives the truth from the
 * machine; Claude Code has no equivalent command, and Anthropic's `/v1/models`
 * needs a credential this process does not hold — the caller brings it per
 * request. Hard-coding is the only honest option left.
 *
 * Being stale is therefore expected, and deliberately not fatal. The gateway's
 * `UnregisteredClaudeRoute` serves any `claude-`prefixed alias it holds no route
 * for by synthesizing the same keyless Anthropic route this list would have
 * seeded, so a model released after this build still works. What this list
 * controls is only what `/v1/models` *advertises* to a client building its
 * picker — not what the gateway will *serve*. Adding a new model here is a
 * cosmetic improvement, never a fix for a model that would otherwise be refused.
 *
 * Every slug was verified end-to-end against `api.anthropic.com` through this
 * gateway on 2026-08-31. `claude-fable-5` answered `credits_required` rather
 * than an unknown-model error, so it is a real id that some accounts cannot
 * spend; it is listed because that refusal belongs to the user's billing, not to
 * routing, and hiding the model would misreport why it is unavailable.
 */
const CLAUDE_NATIVE_MODELS: readonly ClaudeNativeModel[] = Object.freeze([
  { slug: 'claude-opus-5', displayName: 'Claude Opus 5' },
  { slug: 'claude-sonnet-5', displayName: 'Claude Sonnet 5' },
  { slug: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5' },
  { slug: 'claude-opus-4-6', displayName: 'Claude Opus 4.6' },
  { slug: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6' },
  { slug: 'claude-fable-5', displayName: 'Fable 5' }
]);

/**
 * The Claude models the gateway can route, in picker order.
 *
 * A class rather than a bare constant so the registrar depends on the same kind
 * of collaborator it already takes for Codex, and a test can substitute a
 * shorter list without reaching into module state.
 */
export class ClaudeNativeModelCatalog {
  private readonly models: readonly ClaudeNativeModel[];

  constructor(options: { models?: readonly ClaudeNativeModel[] } = {}) {
    this.models = options.models ?? CLAUDE_NATIVE_MODELS;
  }

  /** The Claude models this build knows how to route. */
  list(): ClaudeNativeModel[] {
    return [...this.models];
  }
}

export default ClaudeNativeModelCatalog;

/**
 * One side of a routed pair: the gateway route that serves it, and the name a
 * person should see for it.
 */
export interface RouterModelTier {
  /**
   * The gateway route name. This is the half the router resolves against the
   * gateway's catalog, so it must be a name the gateway actually serves.
   */
  routeName: string;
  /** The model's own name, used wherever the pair is described to a reader. */
  displayName: string;
}

/**
 * The single model Tokkey publishes to Codex and Claude Code while the router
 * is on.
 *
 * The router takes no `--local` / `--cloud` flags, but it no longer learns the
 * pairing from the model name either: every routed pair is now published under
 * the same fixed slug, `DISPLAY_NAME`, and the router reads the actual pairing
 * out of the `router_profiles` table in `~/.tokkey/dbs/tokkey.db` (see
 * `RouterProfileStore`) rather than parsing anything a client sent. That split
 * is what lets the slug carry no route names at all — Claude Code and Claude
 * Desktop's pickers both reject names built from a vendor's own route ids, and
 * a fixed slug has no such fragment to trip on.
 *
 * `RouterAgentIntegration` still builds one of these on every `turnOn`, and
 * still writes it to all three parties that never talk to each other — the
 * Codex catalog, Claude's settings, and now `router_profiles` — so the pairing
 * is assembled in exactly one place even though its slug no longer encodes it.
 */
export class RouterModel {
  /**
   * What both pickers label the pair, regardless of which models it pairs.
   *
   * Unlike every other name here, this one is not a gateway route: the router
   * intercepts it and resolves the pairing itself, so the gateway holds nothing
   * under it. That makes this string part of the router binary's vocabulary
   * rather than the gateway's — the binary has to recognize it, bare and under
   * Claude's `anthropic.` prefix, or a turn named with it is forwarded on as an
   * unrecognized name and 404s at a gateway that has no such route.
   */
  static readonly DISPLAY_NAME = 'Tokkey.Hybrid';

  private readonly local: RouterModelTier;
  private readonly cloud: RouterModelTier;

  constructor(local: RouterModelTier, cloud: RouterModelTier) {
    this.local = { ...local };
    this.cloud = { ...cloud };
  }

  /**
   * The pair both halves of which are the same model.
   *
   * This is the shape every pair has today: no local model can be started yet,
   * so the cloud model stands in for the local tier and the router tiers
   * between two routes that happen to be identical. Once a local model can be
   * selected, only this call site changes.
   */
  static forSingleModel(tier: RouterModelTier): RouterModel {
    return new RouterModel(tier, tier);
  }

  /**
   * The model name a client sends, which is also the Codex catalog slug.
   *
   * Fixed rather than built from the pair: see the class doc for why the
   * pairing now lives in `router_profiles` instead of in this string.
   */
  get slug(): string {
    return RouterModel.DISPLAY_NAME;
  }

  /**
   * What the pair reads as in a picker's description line: both models by
   * name, since the slug itself no longer carries either.
   */
  get description(): string {
    return `local ${this.local.displayName}, cloud ${this.cloud.displayName}`;
  }

  /** The tier names, for logging a toggle without rebuilding the slug. */
  get localDisplayName(): string {
    return this.local.displayName;
  }

  get cloudDisplayName(): string {
    return this.cloud.displayName;
  }
}

export default RouterModel;

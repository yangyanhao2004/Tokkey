/**
 * The single model Tokkey publishes to Codex and Claude Code while a local
 * model is running.
 *
 * The slug is fixed rather than built from the model's own name, for the same
 * reasons `RouterModel` fixes its own (see that class): Claude Code's picker
 * builds no row for a name carrying dots, and Claude Desktop refuses any name
 * carrying a rival vendor's fragment — `qwen`, `gpt`, `deepseek` and dozens
 * more — which a GGUF's file name almost always does. A fixed slug has no such
 * fragment to trip on.
 *
 * Only one local model can run at a time, so the fixed slug costs nothing in
 * expressiveness, and it buys two things: swapping models rewrites no row in
 * either CLI's configuration, and a Codex session that already selected the row
 * keeps working across the swap.
 *
 * The model's own name is not lost — it travels as `displayName`, which is the
 * label both pickers actually show beside the row.
 */
export class LocalModel {
  /**
   * What both pickers key the row on, regardless of which model is running.
   *
   * Also the gateway route name and the body of Claude's `anthropic.` alias:
   * the three have to be one string, because the gateway resolves an incoming
   * model name by exact match against the route it registered.
   *
   * The dot is safe everywhere this name travels: it is a JSON value in a
   * request body and a dict key in the gateway's registry, never a URL segment,
   * a header, or anything parsed. Claude Code rejects dots only in its
   * unprefixed picker branch, and this name is always sent under the
   * `anthropic.` prefix, which takes any body unconditionally.
   */
  static readonly DISPLAY_NAME = 'Tokkey.Local';

  /** The running model's own name, as the Tokkey page shows it. */
  private readonly label: string;

  constructor(label: string) {
    this.label = label;
  }

  /**
   * The model name a client sends, which is also the Codex catalog slug and the
   * gateway route name. Fixed; see the class doc.
   */
  get slug(): string {
    return LocalModel.DISPLAY_NAME;
  }

  /**
   * The picker label. The model's own name, so the row reads as the model the
   * user started rather than as the slug that routes to it.
   */
  get displayName(): string {
    return this.label;
  }

  /** What the row's description line says, since the slug names no model. */
  get description(): string {
    return `local ${this.label}`;
  }
}

export default LocalModel;

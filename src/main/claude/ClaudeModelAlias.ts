/**
 * The name a gateway route is published under in Claude's model pickers.
 *
 * Neither Claude surface will show a bare route name, and the two refuse it for
 * different reasons, so a route gets one alias per surface.
 *
 * Claude Code builds a picker row for an `availableModels` entry only if the
 * entry starts with `anthropic.`, or matches `/^claude-[a-z0-9-]+$/` *and*
 * names opus/sonnet/haiku *and* resolves in Claude Code's own bundled model
 * registry. A cloud route is in no registry, and route names carry dots
 * (`gpt-5.6-terra`) which that pattern rejects outright, so the second branch
 * is closed to us no matter how a route is renamed. `anthropic.` is the one
 * branch that takes a name unconditionally, so `forRoute` keeps the route name
 * whole behind it and the row still reads as the model it serves.
 *
 * Claude Desktop also rejects model names containing rival-vendor fragments.
 * The router's fixed slug carries no backend route details, so the same
 * `anthropic.` alias satisfies Desktop without exposing a denied fragment.
 *
 * Ordinary gateway routes are resolved by `PickerModelAlias` in the gateway.
 * The router accepts this same prefix around its fixed profile slug and removes
 * the indirection by loading that profile before forwarding any model call.
 *
 * Native Claude models are published unprefixed: their slugs are real Anthropic
 * ids that both pickers already know, and prefixing them would trade a properly
 * labelled built-in row for an anonymous "Custom model" one.
 */
export class ClaudeModelAlias {
  /** Kept in step with `PickerModelAlias.PREFIX` in the gateway. */
  static readonly PREFIX = 'anthropic.';

  /**
   * The Claude Code picker alias for a gateway route.
   *
   * Used for the routed pair's fixed slug (`RouterModel.DISPLAY_NAME`) same as
   * any other route. The router recognizes both its bare slug and this
   * picker-qualified spelling, then reads the pairing from `RouterProfileStore`
   * instead of parsing route names out of the slug. This is also the form a
   * plain route will use once a local model can be started on its own.
   */
  static forRoute(routeName: string): string {
    return `${ClaudeModelAlias.PREFIX}${routeName}`;
  }
}

export default ClaudeModelAlias;

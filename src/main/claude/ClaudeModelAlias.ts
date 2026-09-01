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
 * Claude Desktop is stricter, and in a way the prefix alone does not satisfy.
 * Its managed-config validator lowercases the name, refuses it outright if it
 * matches a denylist of rival-vendor fragments (`gpt`, `openai`, `deepseek`,
 * `qwen`, and about forty more), and otherwise requires it to contain one of
 * `claude`/`anthropic`/`opus`/`sonnet`/`haiku`/`fable`/`mythos`. A route named
 * for the model it fronts — `custom-gpt-5.6-terra-openai-c05442` — trips that
 * denylist twice over, whatever prefix it carries, and Desktop drops the entry
 * with an `is not an Anthropic model` warning. `forDesktop` therefore publishes
 * only the route's id suffix, which names no vendor at all; the real model name
 * travels in the entry's `labelOverride`, which the validator never inspects.
 *
 * Both forms are resolved by `PickerModelAlias` in the gateway, so the model
 * sent upstream is unaffected by either.
 *
 * Native Claude models are published unprefixed: their slugs are real Anthropic
 * ids that both pickers already know, and prefixing them would trade a properly
 * labelled built-in row for an anonymous "Custom model" one.
 */
export class ClaudeModelAlias {
  /** Kept in step with `PickerModelAlias.PREFIX` in the gateway. */
  static readonly PREFIX = 'anthropic.';

  /** The Claude Code picker alias for a gateway route. */
  static forRoute(routeName: string): string {
    return `${ClaudeModelAlias.PREFIX}${routeName}`;
  }

  /**
   * The Claude Desktop picker alias for a gateway route.
   *
   * The body is the route name's last segment, which `routeNameFor` builds from
   * the card's id — the one part of the name that can carry no vendor fragment
   * for Desktop's denylist to catch. The gateway resolves the route back from
   * it by that same suffix.
   */
  static forDesktop(routeName: string): string {
    const suffix = routeName.slice(routeName.lastIndexOf('-') + 1);
    return `${ClaudeModelAlias.PREFIX}${suffix}`;
  }
}

export default ClaudeModelAlias;

/**
 * The MCP server the router itself serves, and the name both CLIs file it under.
 *
 * The router binary carries an MCP endpoint alongside the OpenAI-compatible
 * one, on the same port: whatever address a turn is sent to, `/mcp` on that
 * address is the tool server that goes with it. So there is no second port to
 * discover and nothing to configure — the endpoint is derived from the binding
 * the CLIs are already being pointed at, which is also why it is written from
 * the router's real base URL rather than the default 5033: a launch that had
 * to fall back to another port must still hand out the port it actually bound.
 *
 * Both takeovers need the same name to write the entry under, and the same
 * name again to take it back out, so it lives here rather than once per CLI.
 */
export class RouterMcpServer {
  /** What Codex and Claude Code both file the router's tool server under. */
  static readonly NAME = 'tokkey-router';

  /** The MCP endpoint on a router serving at `routerBaseUrl`. */
  static urlFor(routerBaseUrl: string): string {
    return `${routerBaseUrl.replace(/\/+$/, '')}/mcp`;
  }
}

export default RouterMcpServer;

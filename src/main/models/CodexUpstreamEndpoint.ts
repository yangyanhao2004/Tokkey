import type { GatewayEndpoint } from '../gateway/GatewayModelClient';
import GatewayPortResolver from '../gateway/GatewayPortResolver';
import CodexProviderConfig from './CodexProviderConfig';

/** Spellings of "this machine" that a loopback URL may use. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

/**
 * The endpoint Tokkey serves Codex's models from, read from `config.toml`.
 *
 * That file names where the Codex CLI itself sends these models, and it is the
 * answer whenever it gives one: the user configured it for the CLI, and Tokkey
 * serving the same models from somewhere else would be a disagreement with the
 * tool it is standing in for.
 *
 * The one thing the file cannot be trusted about is Tokkey's own address,
 * because pointing the Codex CLI at Tokkey rewrites `config.toml` with this
 * gateway's URL. Reading that back would register the gateway as its own
 * upstream, so the gateway's own address is refused.
 *
 * Nothing here asks the endpoint whether it is real. An earlier version listed
 * its models and required a GPT-shaped id among them, which assumed the user had
 * not curated their own models — the very thing `model_catalog_json` exists to
 * let them do, and which `CodexUserCatalog` now honors. A custom relay serving
 * custom slugs would fail that test and be refused. The user's own configuration
 * is a better authority than a guess about naming.
 *
 * This reads `config.toml` and nothing else. An earlier version also kept the
 * last non-gateway endpoint in a file of its own, to answer while a takeover was
 * in force or after a crash that never undid one. Both are already handled one
 * step earlier and better: `CodexConfigTakeover` runs last on the way up and
 * `recoverInterruptedSession` runs first, so by the time `resolve` reads the
 * file it holds the user's own provider — see the ordering in `TokkeyApp`. The
 * remembered copy only added a second, unvalidated record of a fact the takeover
 * ledger already owns, and one that nothing ever aged out: a user who switched
 * back to the official API kept being routed to the relay they had abandoned,
 * because the switch reads here as "no endpoint" and left the record untouched.
 *
 * A null answer means "no endpoint configured", which the gateway reads as
 * OpenAI's public API — see `_native_codex_target` in `credentials.py`, which
 * owns that default so it is defined in exactly one place. That is also the
 * right answer for a provider naming no `base_url`, which is how the Codex CLI
 * itself spells "the official API".
 */
export class CodexUpstreamEndpoint {
  private readonly config: CodexProviderConfig;
  private readonly gateway: GatewayEndpoint | null;
  /** Shared by every caller during one launch, so the file is read at most once. */
  private resolution: Promise<string | null> | null = null;

  constructor(
    options: {
      config?: CodexProviderConfig;
      gateway?: GatewayEndpoint;
      homeDirectory?: string;
      codexHome?: string;
    } = {}
  ) {
    this.config = options.config ?? new CodexProviderConfig(options);
    this.gateway = options.gateway ?? null;
  }

  /** The endpoint to register routes with, or null when there is none to use. */
  resolve(): Promise<string | null> {
    this.resolution ??= this.decide();
    return this.resolution;
  }

  /** Takes what Codex is configured with now, unless that is this gateway. */
  private async decide(): Promise<string | null> {
    const candidate = await this.config.read();
    if (candidate === null || this.isGatewayItself(candidate.baseUrl)) {
      // Either Codex names no endpoint — no file, or a provider that defines no
      // `base_url`, which means OpenAI's own API — or it names the gateway that
      // is asking, which is what pointing the Codex CLI at Tokkey writes there.
      return null;
    }
    return this.normalize(candidate.baseUrl);
  }

  /** Drops a trailing slash so two spellings of one endpoint compare equal. */
  private normalize(baseUrl: string): string {
    return baseUrl.trim().replace(/\/+$/, '');
  }

  /**
   * Whether a URL names this app's own gateway.
   *
   * Both the running port and the default one are refused. The running port is
   * the address a rewrite would be carrying right now; the default is the one
   * almost every rewrite carried, and a `config.toml` an interrupted launch left
   * taken over names whichever port that launch's gateway had bound, not this
   * one's.
   *
   * An unparseable URL is not the gateway: it is some spelling this code does
   * not recognize, and guessing here would drop a usable endpoint.
   */
  private isGatewayItself(baseUrl: string): boolean {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      return false;
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    if (!LOOPBACK_HOSTS.has(hostname)) return false;
    return this.gatewayPorts().has(url.port);
  }

  /** The ports this app's gateway listens on, or would listen on. */
  private gatewayPorts(): Set<string> {
    const ports = new Set([String(GatewayPortResolver.DEFAULT_PORT)]);
    const running = this.gateway?.baseUrl() ?? null;
    if (running === null) return ports;
    try {
      ports.add(new URL(running).port);
    } catch {
      // The supervisor builds this URL itself, so it is only ever well-formed.
    }
    return ports;
  }
}

export default CodexUpstreamEndpoint;

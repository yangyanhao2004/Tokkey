export interface RouterHealthProbeOptions {
  timeoutMs?: number;
  /** Injected so tests can answer without binding a socket. */
  fetchImplementation?: typeof fetch;
}

/**
 * Reports whether the router is answering on a port.
 *
 * Unlike `GatewayHealthProbe` this checks nothing but reachability: the router's
 * `/health` returns a bare 200 with no launch identity or protocol version to
 * match on. It does not need one. The gateway probe exists to avoid *adopting* a
 * listener some earlier launch left behind, whereas the router is only ever
 * probed on the port this launch just spawned a child onto — and
 * `LocalPortResolver` has already moved that port off anything it did not
 * recognize as this app's own.
 */
export class RouterHealthProbe {
  private static readonly DEFAULT_TIMEOUT_MS = 2000;

  private readonly timeoutMs: number;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: RouterHealthProbeOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? RouterHealthProbe.DEFAULT_TIMEOUT_MS;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  /** Returns whether the router is serving on the given loopback port. */
  async isHealthy(port: number): Promise<boolean> {
    try {
      const response = await this.fetchImplementation(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      return response.ok;
    } catch {
      // An unreachable or still-booting listener is simply not ready yet. Every
      // failure means the same thing to the caller, so none is worth branching on.
      return false;
    }
  }
}

export default RouterHealthProbe;

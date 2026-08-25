/** The `/health/liveness` payload the gateway returns. */
interface GatewayHealthPayload {
  status?: unknown;
  service?: unknown;
  instance_id?: unknown;
  runtime_protocol_version?: unknown;
}

export interface GatewayHealthProbeOptions {
  /** Launch identity that a reusable helper must report back. */
  instanceId: string;
  /** Bearer credential shared with the gateway through its environment. */
  masterKey: string;
  /** Contract version; a mismatch means the listener is an older app build. */
  protocolVersion: number;
  timeoutMs?: number;
  /** Injected so tests can answer without binding a socket. */
  fetchImplementation?: typeof fetch;
}

/**
 * Decides whether the process listening on a port is *this* app launch's
 * gateway. A 2xx response is not enough on its own: an orphaned helper from a
 * previous launch stays alive and answers too, so both the per-launch identity
 * and the runtime protocol version must match before it is adopted.
 */
export class GatewayHealthProbe {
  private static readonly SERVICE_NAME = 'amis-gateway';
  private static readonly DEFAULT_TIMEOUT_MS = 2000;
  private readonly instanceId: string;
  private readonly masterKey: string;
  private readonly protocolVersion: number;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: GatewayHealthProbeOptions) {
    this.instanceId = options.instanceId;
    this.masterKey = options.masterKey;
    this.protocolVersion = options.protocolVersion;
    this.timeoutMs = options.timeoutMs ?? GatewayHealthProbe.DEFAULT_TIMEOUT_MS;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  /** Returns whether the given port serves this launch's compatible gateway. */
  async isHealthy(port: number): Promise<boolean> {
    try {
      const response = await this.fetchImplementation(`http://127.0.0.1:${port}/health/liveness`, {
        headers: { Authorization: `Bearer ${this.masterKey}` },
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      if (!response.ok) {
        return false;
      }
      return this.matchesThisLaunch((await response.json()) as GatewayHealthPayload);
    } catch {
      // An unreachable, slow, or non-JSON listener is never adopted. The caller
      // treats every failure the same way, so the cause is not worth branching on.
      return false;
    }
  }

  private matchesThisLaunch(payload: GatewayHealthPayload): boolean {
    return (
      payload.status === 'ok' &&
      payload.service === GatewayHealthProbe.SERVICE_NAME &&
      payload.instance_id === this.instanceId &&
      payload.runtime_protocol_version === this.protocolVersion
    );
  }
}

export default GatewayHealthProbe;

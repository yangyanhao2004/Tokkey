import LocalPortResolver, {
  type LocalPortResolverOptions,
  type PortListener
} from '../process/LocalPortResolver';

export type { PortListener };

export type GatewayPortResolverOptions = Partial<Omit<LocalPortResolverOptions, 'logLabel'>>;

/**
 * Chooses the port each gateway launch binds.
 *
 * Everything but the defaults lives in `LocalPortResolver`, which the router
 * supervisor uses the same way: an orphan of a previous launch is evicted from
 * 4033, an unrelated process holding it is left alone and a free port is used
 * instead. The Amis-Wifi desktop app ships this same gateway, which is why that
 * eviction rule matches on the executable path rather than the program name.
 */
export class GatewayPortResolver extends LocalPortResolver {
  /** Where the gateway listens unless something else already holds the port. */
  static readonly DEFAULT_PORT = 4033;

  constructor(options: GatewayPortResolverOptions = {}) {
    super({
      ...options,
      preferredPort: options.preferredPort ?? GatewayPortResolver.DEFAULT_PORT,
      logLabel: 'AmisGateway'
    });
  }
}

export default GatewayPortResolver;

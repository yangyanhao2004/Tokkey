import { createServer } from 'node:net';

export interface LocalInferencePortResolverOptions {
  findFreePort?: () => Promise<number>;
}

/** Allocates a fresh loopback port without ever reclaiming another application's listener. */
export class LocalInferencePortResolver {
  private readonly findFreePortImplementation: () => Promise<number>;

  constructor(options: LocalInferencePortResolverOptions = {}) {
    this.findFreePortImplementation = options.findFreePort ?? LocalInferencePortResolver.findFreePort;
  }

  resolve(): Promise<number> {
    return this.findFreePortImplementation();
  }

  private static findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          server.close(() => reject(new Error('Failed to allocate a local inference port.')));
          return;
        }
        server.close((error) => error ? reject(error) : resolve(address.port));
      });
    });
  }
}

export default LocalInferencePortResolver;

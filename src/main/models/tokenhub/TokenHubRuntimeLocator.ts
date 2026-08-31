import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface TokenHubRuntimeResources {
  serverPath: string;
  templatePath: string;
}

/** Resolves the architecture-specific Dongle server and Qwen chat template. */
export class TokenHubRuntimeLocator {
  private readonly roots: string[];

  constructor(options: {
    resourcesPath?: string;
    appPath?: string;
    environment?: NodeJS.ProcessEnv;
  } = {}) {
    const environment = options.environment ?? process.env;
    this.roots = [
      environment.AMIS_TOKEN_HUB_RUNTIME,
      options.resourcesPath && path.join(options.resourcesPath, 'TokenHubRuntime', process.arch),
      options.appPath && path.join(options.appPath, 'resources', 'TokenHubRuntime', process.arch),
      path.resolve(__dirname, '../../../../resources/TokenHubRuntime', process.arch),
      path.resolve(process.cwd(), 'resources/TokenHubRuntime', process.arch)
    ].filter((candidate): candidate is string => Boolean(candidate));
  }

  async resolve(): Promise<TokenHubRuntimeResources> {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') {
      throw new Error(`The Amis Hub runtime is unavailable on ${process.platform}/${process.arch}.`);
    }
    for (const root of this.roots) {
      const resources = {
        serverPath: path.join(root, 'tokenhub_server', 'llama-server'),
        templatePath: path.join(root, 'qwen3_codex_compatible.jinja')
      };
      try {
        await Promise.all([
          access(resources.serverPath, constants.X_OK),
          access(resources.templatePath, constants.R_OK)
        ]);
        await this.validateServer(resources.serverPath);
        return resources;
      } catch {
        // Continue through the explicit, packaged, and development candidates.
      }
    }
    throw new Error(`The Dongle-enabled llama-server is missing. Searched: ${this.roots.join(':')}`);
  }

  private async validateServer(serverPath: string): Promise<void> {
    const data = await readFile(serverPath);
    const magic = data.subarray(0, 4).toString('hex');
    const supportedMachOMagic = new Set([
      'cefaedfe', 'cffaedfe', 'feedface', 'feedfacf',
      'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'
    ]);
    if (!supportedMachOMagic.has(magic)) {
      throw new Error(`Hub server is not a compatible Mach-O executable: ${magic}.`);
    }
    const missing = ['--api-key', '--dongle-port', '--chat-template-file'].filter(
      (option) => data.indexOf(Buffer.from(option)) < 0
    );
    if (missing.length > 0) {
      throw new Error(`Hub server does not support required options: ${missing.join(', ')}.`);
    }
  }
}

export default TokenHubRuntimeLocator;

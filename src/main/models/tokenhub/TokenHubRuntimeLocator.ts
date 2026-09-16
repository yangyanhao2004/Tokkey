import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';

export interface TokenHubRuntimeResources {
  templatePath: string;
}

/** Resolves the locally packaged Qwen chat template for the Dongle-provided server. */
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
        templatePath: path.join(root, 'qwen3_codex_compatible.jinja')
      };
      try {
        await access(resources.templatePath, constants.R_OK);
        return resources;
      } catch {
        // Continue through the explicit, packaged, and development candidates.
      }
    }
    throw new Error(`The Amis Hub chat template is missing. Searched: ${this.roots.join(':')}`);
  }
}

export default TokenHubRuntimeLocator;

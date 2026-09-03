import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ShellAgent } from './AgentTypes';

/** How one agent's desktop app is recognized on disk. */
interface DesktopAppSignature {
  /** Bundle names the app has shipped under, checked in every search directory. */
  bundleNames: readonly string[];
  /**
   * Bundle identifier prefix that confirms the bundle really is this agent.
   *
   * The name alone is not enough: OpenAI ships Codex inside a bundle also named
   * `ChatGPT.app`, so a plain ChatGPT install would otherwise read as Codex.
   */
  bundleIdentifierPrefix: string;
}

const DESKTOP_APPS: Readonly<Record<ShellAgent, DesktopAppSignature>> = {
  claude: { bundleNames: ['Claude.app'], bundleIdentifierPrefix: 'com.anthropic.claude' },
  codex: { bundleNames: ['Codex.app', 'ChatGPT.app'], bundleIdentifierPrefix: 'com.openai.codex' }
};

export interface DesktopAppDetectorOptions {
  /** Directories searched for app bundles; defaults to the two macOS app folders. */
  searchDirectories?: readonly string[];
  platform?: NodeJS.Platform;
  homeDirectory?: string;
}

/**
 * Finds the desktop app of a coding agent, which counts as that agent being
 * installed just as much as its CLI does.
 *
 * A user who only ever installed Claude Desktop or the Codex app never has
 * `claude` or `codex` on PATH, so a PATH-only probe greys out an agent that is
 * plainly sitting in `/Applications`.
 */
export class DesktopAppDetector {
  private readonly searchDirectories: readonly string[];

  constructor(options: DesktopAppDetectorOptions = {}) {
    const homeDirectory = options.homeDirectory ?? os.homedir();
    const platform = options.platform ?? process.platform;
    this.searchDirectories =
      options.searchDirectories ??
      // Only macOS has app bundles; elsewhere the CLI probe is the whole answer.
      (platform === 'darwin' ? ['/Applications', path.join(homeDirectory, 'Applications')] : []);
  }

  /** The installed app bundle path for one agent, or null when it is absent. */
  locate(agent: ShellAgent): string | null {
    const signature = DESKTOP_APPS[agent];
    if (!signature) return null;
    for (const directory of this.searchDirectories) {
      for (const bundleName of signature.bundleNames) {
        const bundlePath = path.join(directory, bundleName);
        if (this.isBundleOf(bundlePath, signature.bundleIdentifierPrefix)) return bundlePath;
      }
    }
    return null;
  }

  /**
   * Whether the bundle exists and declares the expected identifier.
   *
   * `Info.plist` is usually a binary plist, but identifiers are stored as plain
   * strings in both formats, so a substring test reads either one without
   * pulling in a plist parser.
   */
  private isBundleOf(bundlePath: string, bundleIdentifierPrefix: string): boolean {
    const infoPlistPath = path.join(bundlePath, 'Contents', 'Info.plist');
    if (!existsSync(infoPlistPath)) return false;
    try {
      return readFileSync(infoPlistPath, 'latin1').includes(bundleIdentifierPrefix);
    } catch {
      return false;
    }
  }
}

export default DesktopAppDetector;

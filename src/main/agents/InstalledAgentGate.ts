import type { McpAgent, SkillAgent } from '../../shared/types';
import AgentManager from './AgentManager';
import type { ShellAgent } from './AgentTypes';

/** The agent name both catalog scanners badge under, spelled the same way. */
export type CatalogAgent = SkillAgent & McpAgent;

/** Every catalog agent, in the order the badges and adapters are listed in. */
export const CATALOG_AGENTS: readonly CatalogAgent[] = ['claudeCode', 'codex'];

/** The executable each catalog agent is detected by, which is not always its name. */
const CATALOG_AGENT_CLIS: Readonly<Record<CatalogAgent, ShellAgent>> = {
  claudeCode: 'claude',
  codex: 'codex'
};

/**
 * Which agent-owned locations are worth reading on this machine.
 *
 * The scanners take this rather than a boolean per call so the whole main
 * process answers "is Codex here" one way. Uninstalling an agent does not remove
 * its home directory, so without this a departed agent keeps contributing
 * cards from `~/.codex` long after nothing can load them.
 */
export interface InstalledAgentGating {
  installedAgents(): Promise<readonly CatalogAgent[]>;
}

export interface InstalledAgentGateOptions {
  agentManager?: AgentManager;
}

/** Reads the shared detection cache and reports the agents actually present. */
export class InstalledAgentGate implements InstalledAgentGating {
  private readonly agentManager: AgentManager;

  constructor(options: InstalledAgentGateOptions = {}) {
    this.agentManager = options.agentManager ?? new AgentManager();
  }

  /**
   * The catalog agents installed right now, by CLI or by desktop app.
   *
   * The refresh is cheap after the first call — the detector caches until the
   * Agent Hub invalidates it — so every scan gets the same answer the page
   * greys its chips from.
   */
  async installedAgents(): Promise<readonly CatalogAgent[]> {
    await this.agentManager.refresh();
    const states = this.agentManager.statesSnapshot();
    return CATALOG_AGENTS.filter((agent) => states[CATALOG_AGENT_CLIS[agent]]?.state === 'installed');
  }
}

export default InstalledAgentGate;

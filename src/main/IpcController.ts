import { app, ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { AppInfo, InstalledSkill, SkillAgent, SkillAgentSelection } from '../shared/types';
import { LocalSkillCatalogScanner } from './mcpnskills/SkillCatalogScanner';
import { SKILL_AGENT_ORDER, SkillDeployer } from './mcpnskills/SkillDeployer';

type IpcHandler = (...args: unknown[]) => unknown;

/**
 * Central place for every main-process IPC handler exposed to the renderer.
 * Channel names live here and in preload.ts only, so the surface stays auditable.
 */
export default class IpcController {
  private readonly handlers: Record<string, IpcHandler>;
  private readonly skillCatalogScanner: LocalSkillCatalogScanner;
  private readonly skillDeployer: SkillDeployer;

  constructor(
    skillCatalogScanner: LocalSkillCatalogScanner = new LocalSkillCatalogScanner(),
    skillDeployer: SkillDeployer = new SkillDeployer({ scanner: skillCatalogScanner })
  ) {
    this.skillCatalogScanner = skillCatalogScanner;
    this.skillDeployer = skillDeployer;
    // Channel name -> handler function. Add new renderer-callable APIs here.
    this.handlers = {
      'app:get-info': () => this.getAppInfo(),
      'skills:list-installed': () => this.getInstalledSkills(),
      'skills:get-agent-selection': (skillId: unknown) =>
        this.getSkillAgentSelection(this.requireSkillId(skillId)),
      'skills:apply-agent-selection': (skillId: unknown, selectedAgents: unknown) =>
        this.applySkillAgentSelection(
          this.requireSkillId(skillId),
          this.requireSkillAgents(selectedAgents)
        ),
      'skills:uninstall': (skillId: unknown) => this.uninstallSkill(this.requireSkillId(skillId))
    };
  }

  /** Registers every handler on ipcMain. Call once, before any window opens. */
  register(): void {
    Object.entries(this.handlers).forEach(([channel, handler]) => {
      ipcMain.handle(channel, (_event: IpcMainInvokeEvent, ...args: unknown[]) => handler(...args));
    });
  }

  /**
   * Runtime information about the app and its platform, used by the renderer.
   * @returns Runtime information about the current Electron process.
   */
  getAppInfo(): AppInfo {
    return {
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron ?? 'unknown',
      chrome: process.versions.chrome ?? 'unknown',
      node: process.versions.node,
      platform: process.platform
    };
  }

  /** Lists local skills for the future skills page without exposing filesystem APIs to it. */
  async getInstalledSkills(): Promise<InstalledSkill[]> {
    return this.skillCatalogScanner.scanInstalledSkills();
  }

  /** Returns the current selection derived from the skill's filesystem locations. */
  async getSkillAgentSelection(skillId: string): Promise<SkillAgentSelection> {
    const skill = await this.findSkill(skillId);
    const enabledAgents = this.skillDeployer.getEnabledAgents(skill);
    return {
      skill,
      selectedAgents: SKILL_AGENT_ORDER.filter((agent) => enabledAgents.has(agent))
    };
  }

  /** Applies the complete requested set and returns the post-operation catalog. */
  async applySkillAgentSelection(
    skillId: string,
    selectedAgents: SkillAgent[]
  ): Promise<InstalledSkill[]> {
    const skill = await this.findSkill(skillId);
    return this.skillDeployer.applyAgentSelection(skill, selectedAgents);
  }

  /** Uninstalls the app-managed copy while preserving external real directories. */
  async uninstallSkill(skillId: string): Promise<InstalledSkill[]> {
    const skill = await this.findSkill(skillId);
    return this.skillDeployer.uninstallSkill(skill);
  }

  private async findSkill(skillId: string): Promise<InstalledSkill> {
    const skill = (await this.getInstalledSkills()).find((candidate) => candidate.id === skillId);
    if (!skill) {
      throw new Error(`Skill not found: ${skillId}`);
    }
    return skill;
  }

  private requireSkillId(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new TypeError('Skill ID must be a non-empty string');
    }
    return value;
  }

  private requireSkillAgents(value: unknown): SkillAgent[] {
    if (!Array.isArray(value)) {
      throw new TypeError('Selected agents must be an array');
    }
    const selectedAgents = value.map((agent) => {
      if (typeof agent !== 'string' || !SKILL_AGENT_ORDER.includes(agent as SkillAgent)) {
        throw new TypeError(`Unsupported skill agent: ${String(agent)}`);
      }
      return agent as SkillAgent;
    });
    return [...new Set(selectedAgents)];
  }
}

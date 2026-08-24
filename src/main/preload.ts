import { contextBridge, ipcRenderer } from 'electron';
import type { TokiieApi } from '../shared/types';

/**
 * The only bridge between renderer and main process. It exposes a small,
 * explicit API on `window.tokiie` instead of handing the renderer ipcRenderer,
 * which keeps context isolation meaningful.
 */
class PreloadBridge {
  /** Exposes the API object on the isolated renderer window. */
  expose(): void {
    const api: TokiieApi = {
      getAppInfo: () => ipcRenderer.invoke('app:get-info'),
      getInstalledSkills: () => ipcRenderer.invoke('skills:list-installed'),
      getSkillAgentSelection: (skillId) => ipcRenderer.invoke('skills:get-agent-selection', skillId),
      applySkillAgentSelection: (skillId, selectedAgents) =>
        ipcRenderer.invoke('skills:apply-agent-selection', skillId, selectedAgents),
      uninstallSkill: (skillId) => ipcRenderer.invoke('skills:uninstall', skillId),
      listCachedRepositories: () => ipcRenderer.invoke('discover-repos:list-cached'),
      addRepository: (input, branch) => ipcRenderer.invoke('discover-repos:add', input, branch),
      installRepositorySkill: (request) => ipcRenderer.invoke('discover-repos:install-skill', request),
      fetchSkillsPage: (page) => ipcRenderer.invoke('discover-skills:fetch-page', page),
      searchSkills: (query) => ipcRenderer.invoke('discover-skills:search', query),
      refreshSkillsInstalledStatus: () => ipcRenderer.invoke('discover-skills:refresh-installed'),
      getSkillCardState: (listing) => ipcRenderer.invoke('discover-skills:card-state', listing),
      installSkill: (request) => ipcRenderer.invoke('discover-skills:install', request)
    };
    contextBridge.exposeInMainWorld('tokiie', api);
  }
}

new PreloadBridge().expose();

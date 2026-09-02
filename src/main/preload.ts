import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { LocalChatEvent, LocalModelRuntimeState, TokiieApi } from '../shared/types';

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
      getAccountState: () => ipcRenderer.invoke('account:get-state'),
      requestEmailVerificationCode: (email) =>
        ipcRenderer.invoke('account:request-email-code', email),
      verifyEmailSignIn: (email, code) =>
        ipcRenderer.invoke('account:verify-email', email, code),
      signInWithGoogle: () => ipcRenderer.invoke('account:sign-in-google'),
      cancelGoogleSignIn: () => ipcRenderer.invoke('account:cancel-google'),
      signOutAccount: () => ipcRenderer.invoke('account:sign-out'),
      getHostSnapshot: () => ipcRenderer.invoke('host:snapshot'),
      detectAgents: () => ipcRenderer.invoke('agents:detect'),
      getInstalledMcps: () => ipcRenderer.invoke('mcps:list-installed'),
      scanInstalledMcps: () => ipcRenderer.invoke('mcps:list-installed'),
      prepareMcpConfiguration: (draft) => ipcRenderer.sendSync('mcps:prepare-configuration', draft),
      applyMcpConfiguration: (request) => ipcRenderer.invoke('mcps:apply-configuration', request),
      applyMcpAgentSelection: (mcpId, selectedAgents) =>
        ipcRenderer.invoke('mcps:apply-agent-selection', mcpId, selectedAgents),
      getInstalledSkills: () => ipcRenderer.invoke('skills:list-installed'),
      getSkillAgentSelection: (skillId) => ipcRenderer.invoke('skills:get-agent-selection', skillId),
      applySkillAgentSelection: (skillId, selectedAgents) =>
        ipcRenderer.invoke('skills:apply-agent-selection', skillId, selectedAgents),
      uninstallSkill: (skillId) => ipcRenderer.invoke('skills:uninstall', skillId),
      uploadSkillFolder: () => ipcRenderer.invoke('skills:upload-folder'),
      resolveSkillUploadConflict: (pendingUploadId, choice) =>
        ipcRenderer.invoke('skills:resolve-upload-conflict', pendingUploadId, choice),
      listCachedRepositories: () => ipcRenderer.invoke('discover-repos:list-cached'),
      addRepository: (input, branch) => ipcRenderer.invoke('discover-repos:add', input, branch),
      installRepositorySkill: (request) => ipcRenderer.invoke('discover-repos:install-skill', request),
      fetchSkillsPage: (page) => ipcRenderer.invoke('discover-skills:fetch-page', page),
      searchSkills: (query) => ipcRenderer.invoke('discover-skills:search', query),
      searchSkillsPage: (query, page) => ipcRenderer.invoke('discover-skills:search-page', query, page),
      refreshSkillsInstalledStatus: () => ipcRenderer.invoke('discover-skills:refresh-installed'),
      getSkillCardState: (listing) => ipcRenderer.invoke('discover-skills:card-state', listing),
      getSkillCardStates: (listings) => ipcRenderer.invoke('discover-skills:card-states', listings),
      installSkill: (request) => ipcRenderer.invoke('discover-skills:install', request),
      listLocalModels: (request) => ipcRenderer.invoke('models:list', request),
      refreshLocalModels: (request) => ipcRenderer.invoke('models:refresh', request),
      startLocalModelDownload: (modelId, request) => ipcRenderer.invoke('models:start-download', modelId, request),
      cancelLocalModelDownload: (modelId, request) => ipcRenderer.invoke('models:cancel-download', modelId, request),
      deleteLocalModel: (modelId, request) => ipcRenderer.invoke('models:delete', modelId, request),
      deployLocalModel: (modelId, request) => ipcRenderer.invoke('models:deploy', modelId, request),
      listInstalledLocalModels: () => ipcRenderer.invoke('models:list-installed'),
      startInstalledLocalModel: (modelId) => ipcRenderer.invoke('models:start-installed', modelId),
      removeInstalledLocalModel: (modelId) => ipcRenderer.invoke('models:remove-installed', modelId),
      getLocalModelRuntimeState: () => ipcRenderer.invoke('models:runtime-state'),
      stopLocalModelRuntime: () => ipcRenderer.invoke('models:stop-runtime'),
      onLocalModelRuntimeStateChanged: (listener) => {
        const handler = (_event: IpcRendererEvent, state: LocalModelRuntimeState) => listener(state);
        ipcRenderer.on('models:runtime-state-changed', handler);
        return () => ipcRenderer.removeListener('models:runtime-state-changed', handler);
      },
      listCloudModelCards: () => ipcRenderer.invoke('models:cloud-cards'),
      connectCloudModel: (cardId) => ipcRenderer.invoke('models:connect-cloud', cardId),
      restoreCloudModels: () => ipcRenderer.invoke('models:restore-cloud'),
      loadLocalChatWorkspace: () => ipcRenderer.invoke('chat:load-workspace'),
      createLocalChatSession: () => ipcRenderer.invoke('chat:create-session'),
      openLocalChatSession: (sessionId) => ipcRenderer.invoke('chat:open-session', sessionId),
      closeLocalChatSession: (sessionId) => ipcRenderer.invoke('chat:close-session', sessionId),
      getLocalChatRuntimeState: () => ipcRenderer.invoke('chat:get-runtime-state'),
      startLocalChatTurn: (request) => ipcRenderer.invoke('chat:start-turn', request),
      cancelLocalChatTurn: (turnId) => ipcRenderer.invoke('chat:cancel-turn', turnId),
      onLocalChatEvent: (listener) => {
        const forwardEvent = (_event: IpcRendererEvent, payload: unknown) => {
          if (isLocalChatEvent(payload)) {
            listener(payload);
          }
        };
        ipcRenderer.on('chat:event', forwardEvent);
        return () => ipcRenderer.removeListener('chat:event', forwardEvent);
      }
    };
    contextBridge.exposeInMainWorld('tokiie', api);
  }
}

new PreloadBridge().expose();

function isLocalChatEvent(value: unknown): value is LocalChatEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const event = value as Record<string, unknown>;
  if (!hasLocalChatEventIdentity(event)) {
    return false;
  }
  switch (event.type) {
    case 'textDelta':
      return typeof event.text === 'string';
    case 'reasoningDelta':
      return typeof event.text === 'string';
    case 'usage':
      return isNullableFiniteNumber(event.inputTokens) && isNullableFiniteNumber(event.outputTokens);
    case 'completed':
    case 'cancelled':
    case 'watchdogTerminated':
      return true;
    case 'error':
      return typeof event.message === 'string' && typeof event.retryable === 'boolean';
    default:
      return false;
  }
}

function hasLocalChatEventIdentity(event: Record<string, unknown>): boolean {
  return typeof event.turnId === 'string' &&
    typeof event.sessionId === 'string' &&
    typeof event.assistantMessageId === 'string';
}

function isNullableFiniteNumber(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

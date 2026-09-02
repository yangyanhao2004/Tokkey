import type {
  LocalChatRuntimeState,
  LocalModelRuntimeState
} from '../../shared/types';

/** Minimal model data required to load one downloaded GGUF into local inference. */
export interface LocalModelLaunchRequest {
  id: string;
  label: string;
  fileName: string;
  filePath: string;
}

/** Main-process-only access to the currently authenticated local Chat server. */
export interface LocalChatRuntimeServing {
  getLocalChatRuntimeState(): LocalChatRuntimeState;
  chatCompletionsUrl(modelId: string): string;
  chatRequestHeaders(modelId: string): Record<string, string>;
}

/** One device-backed local model lifecycle shared by deployment and local Chat. */
export interface LocalModelRuntime extends LocalChatRuntimeServing {
  startModel(model: LocalModelLaunchRequest): Promise<LocalModelRuntimeState>;
  stopModel(): Promise<LocalModelRuntimeState>;
  subscribe(listener: (state: LocalModelRuntimeState) => void): () => void;
}

/** Runtime information returned by the main process over IPC. */
export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
}

/** Renderer-facing API exposed by the preload bridge. */
export interface TokieApi {
  getAppInfo(): Promise<AppInfo>;
}

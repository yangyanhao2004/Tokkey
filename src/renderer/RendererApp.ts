import type { AppInfo } from '../shared/types';

/**
 * Drives the renderer UI. It never touches Node or Electron directly and talks
 * to the main process only through the `window.tokie` preload bridge.
 */
class RendererApp {
  private readonly infoElement: HTMLElement;

  constructor() {
    const infoElement = document.getElementById('info');
    if (!(infoElement instanceof HTMLElement)) {
      throw new Error('The runtime info element is missing.');
    }
    this.infoElement = infoElement;
  }

  /** Boots the UI once the DOM is available. */
  async start(): Promise<void> {
    const appInfo = await window.tokie.getAppInfo();
    this.renderInfo(appInfo);
  }

  /**
   * Renders the runtime information as definition-list rows.
   * @param appInfo runtime key/value pairs from the main process
   */
  renderInfo(appInfo: AppInfo): void {
    this.infoElement.replaceChildren(
      ...Object.entries(appInfo).flatMap(([key, value]) => {
        const term = document.createElement('dt');
        term.textContent = key;
        const definition = document.createElement('dd');
        definition.textContent = String(value);
        return [term, definition];
      })
    );
  }
}

document.addEventListener('DOMContentLoaded', () => {
  void new RendererApp().start();
});

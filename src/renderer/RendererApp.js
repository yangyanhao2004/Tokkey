'use strict';

/**
 * Drives the renderer UI. It never touches Node or Electron directly and talks
 * to the main process only through the `window.tokie` preload bridge.
 */
class RendererApp {
  constructor() {
    this.infoElement = document.getElementById('info');
  }

  /** Boots the UI once the DOM is available. */
  async start() {
    const appInfo = await window.tokie.getAppInfo();
    this.renderInfo(appInfo);
  }

  /**
   * Renders the runtime information as definition-list rows.
   * @param {Record<string, string>} appInfo key/value pairs from the main process
   */
  renderInfo(appInfo) {
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
  new RendererApp().start();
});

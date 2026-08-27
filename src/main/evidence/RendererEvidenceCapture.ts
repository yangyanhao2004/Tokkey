import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrowserWindow } from 'electron';

interface EvidenceBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface EvidenceElement {
  testId: string | null;
  tagName: string;
  role: string | null;
  accessibleName: string;
  text: string;
  bounds: EvidenceBounds;
  visible: boolean;
}

interface RendererSnapshot {
  viewport: {
    width: number;
    height: number;
    devicePixelRatio: number;
    documentWidth: number;
    documentHeight: number;
  };
  elements: EvidenceElement[];
}

interface RendererEvidenceManifest {
  status: 'passed' | 'failed';
  kind: 'renderer-evidence';
  target: RendererEvidence['target'];
  artifacts: {
    screenshot?: string;
    snapshot?: string;
    error?: string;
  };
}

export interface RendererEvidence {
  capturedAt: string;
  target: {
    contentWidth: number;
    contentHeight: number;
  };
  windowBounds: EvidenceBounds;
  contentBounds: EvidenceBounds;
  screenshot: {
    width: number;
    height: number;
  };
  renderer: RendererSnapshot;
}

/**
 * Captures deterministic renderer evidence without depending on a display-wide
 * screenshot or coordinate-based automation.
 */
export default class RendererEvidenceCapture {
  private readonly outputDirectory: string;
  private readonly targetWidth: number;
  private readonly targetHeight: number;

  /**
   * @param outputDirectory directory that receives the PNG and JSON artifacts
   * @param targetWidth expected renderer/content width from the Figma ledger
   * @param targetHeight expected renderer/content height from the Figma ledger
   */
  constructor(outputDirectory: string, targetWidth: number, targetHeight: number) {
    this.outputDirectory = outputDirectory;
    this.targetWidth = targetWidth;
    this.targetHeight = targetHeight;
  }

  /** Captures the visible page and its semantic geometry into retained files. */
  async capture(window: BrowserWindow): Promise<RendererEvidence> {
    await fs.mkdir(this.outputDirectory, { recursive: true });
    // Device emulation keeps Figma-sized evidence independent of the host display
    // while preserving the production window configuration outside this mode.
    window.webContents.enableDeviceEmulation({
      screenPosition: 'desktop',
      screenSize: { width: this.targetWidth, height: this.targetHeight },
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: 0,
      viewSize: { width: this.targetWidth, height: this.targetHeight },
      scale: 1
    });
    // Figma frames describe the renderer canvas; set content size so native
    // title-bar chrome does not silently subtract from the comparison height.
    await this.resizeToTargetViewport(window);

    // Wait for two paint opportunities so React layout and fonts settle before capture.
    await this.waitForPaint(window);

    const renderer = (await window.webContents.executeJavaScript(`(${RendererEvidenceCapture.rendererSnapshotScript.toString()})()`)) as RendererSnapshot;
    const windowBounds = RendererEvidenceCapture.normalizeBounds(window.getBounds());
    const contentBounds = RendererEvidenceCapture.normalizeBounds(window.getContentBounds());
    const screenshot = await window.webContents.capturePage({
      x: 0,
      y: 0,
      width: this.targetWidth,
      height: this.targetHeight
    });
    const evidence: RendererEvidence = {
      capturedAt: new Date().toISOString(),
      target: { contentWidth: this.targetWidth, contentHeight: this.targetHeight },
      windowBounds,
      contentBounds,
      screenshot: screenshot.getSize(),
      renderer
    };

    await Promise.all([
      fs.writeFile(path.join(this.outputDirectory, 'renderer.png'), screenshot.toPNG()),
      fs.writeFile(
        path.join(this.outputDirectory, 'renderer-evidence.json'),
        `${JSON.stringify(evidence, null, 2)}\n`,
        'utf8'
      ),
      fs.writeFile(
        path.join(this.outputDirectory, 'manifest.json'),
        `${JSON.stringify({
          status: 'passed',
          kind: 'renderer-evidence',
          target: evidence.target,
          artifacts: {
            screenshot: 'renderer.png',
            snapshot: 'renderer-evidence.json'
          }
        } satisfies RendererEvidenceManifest, null, 2)}\n`,
        'utf8'
      )
    ]);
    return evidence;
  }

  /** Retains a structured failure artifact before the owning process exits. */
  async recordFailure(error: unknown): Promise<void> {
    await fs.mkdir(this.outputDirectory, { recursive: true });
    const message = error instanceof Error ? error.message : String(error);
    await fs.writeFile(
      path.join(this.outputDirectory, 'manifest.json'),
      `${JSON.stringify({
        status: 'failed',
        kind: 'renderer-evidence',
        target: { contentWidth: this.targetWidth, contentHeight: this.targetHeight },
        artifacts: { error: 'error.txt' }
      } satisfies RendererEvidenceManifest, null, 2)}\n`,
      'utf8'
    );
    await fs.writeFile(path.join(this.outputDirectory, 'error.txt'), `${message}\n`, 'utf8');
  }

  /** Compensates for platform chrome until the actual renderer viewport matches Figma. */
  private async resizeToTargetViewport(window: BrowserWindow): Promise<void> {
    window.setContentSize(this.targetWidth, this.targetHeight);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await this.waitForPaint(window);
      const viewport = await this.readViewportSize(window);
      const widthDelta = this.targetWidth - viewport.width;
      const heightDelta = this.targetHeight - viewport.height;
      if (widthDelta === 0 && heightDelta === 0) return;

      const [windowWidth, windowHeight] = window.getSize();
      window.setSize(windowWidth + widthDelta, windowHeight + heightDelta);
    }

    const viewport = await this.readViewportSize(window);
    throw new Error(
      `Renderer viewport did not reach ${this.targetWidth}x${this.targetHeight}; ` +
        `observed ${viewport.width}x${viewport.height}.`
    );
  }

  /** Waits for layout and font metrics to settle after a native resize. */
  private async waitForPaint(window: BrowserWindow): Promise<void> {
    await window.webContents.executeJavaScript(
      'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
    );
  }

  /** Reads CSS viewport dimensions from the renderer rather than inferring them from chrome. */
  private async readViewportSize(window: BrowserWindow): Promise<{ width: number; height: number }> {
    return (await window.webContents.executeJavaScript(
      '({ width: window.innerWidth, height: window.innerHeight })'
    )) as { width: number; height: number };
  }

  /** Keeps Electron rectangles serializable and stable across platform types. */
  private static normalizeBounds(bounds: Electron.Rectangle): EvidenceBounds {
    return {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height
    };
  }

  /** Runs inside the isolated renderer and reports only stable public UI facts. */
  private static readonly rendererSnapshotScript = (): RendererSnapshot => {
    const visibleElements = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-testid], button, input, textarea, nav, aside, dialog, h1, h2, h3'
      )
    );
    const elements = visibleElements.map((element): EvidenceElement => {
      const rectangle = element.getBoundingClientRect();
      const computedStyle = window.getComputedStyle(element);
      const accessibleName =
        element.getAttribute('aria-label') ||
        element.getAttribute('title') ||
        element.textContent?.trim() ||
        '';
      return {
        testId: element.dataset.testid || null,
        tagName: element.tagName.toLowerCase(),
        role: element.getAttribute('role'),
        accessibleName,
        text: element.textContent?.trim() || '',
        bounds: {
          x: Number(rectangle.x.toFixed(2)),
          y: Number(rectangle.y.toFixed(2)),
          width: Number(rectangle.width.toFixed(2)),
          height: Number(rectangle.height.toFixed(2))
        },
        visible:
          rectangle.width > 0 &&
          rectangle.height > 0 &&
          computedStyle.visibility !== 'hidden' &&
          computedStyle.display !== 'none'
      };
    });

    return {
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        documentWidth: document.documentElement.scrollWidth,
        documentHeight: document.documentElement.scrollHeight
      },
      elements
    };
  };
}

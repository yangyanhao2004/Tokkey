import path from 'node:path';
import { BrowserWindow, screen } from 'electron';
import type { PetInteraction, PetRuntimeState, PetSettings } from '../../shared/types';
import {
  advancePetMotion,
  initialPetMotion,
  isPointInsidePetBody,
  petMovementBounds,
  petRenderSize,
  type PetMotionState,
  type PetWorkArea
} from './PetRuntimeGeometry';
import type { PetPosition, PetPositionStoring } from './PetPositionStore';
import {
  resolvePetCompanionFeedback,
  type PetCompanionFeedback,
  type PetCompanionSignal,
  type PetCompanionSnapshot
} from './PetCompanionStatus';

export interface PetRuntimeCoordinating {
  getState(): PetRuntimeState;
  subscribe(listener: (state: PetRuntimeState) => void): () => void;
  applySettings(settings: PetSettings): Promise<void>;
  setPaused(isPaused: boolean): void;
  signalCompanion(signal: PetCompanionSignal): void;
  stop(reason?: string): void;
  interact(interaction: PetInteraction): void;
}

const TICK_INTERVAL_MS = 80;
const BUBBLE_DURATION_MS = 2_200;
const RETURN_DURATION_MS = 450;
const EASTER_DURATION_MS = 1_500;
const MIN_EASTER_DELAY_MS = 18_000;
const MAX_EASTER_DELAY_MS = 34_000;
const PET_WINDOW_EXTRA_WIDTH_PX = 148;
const PET_WINDOW_BUBBLE_SPACE_PX = 46;
const MAX_WINDOW_RECOVERY_ATTEMPTS = 2;
const WINDOW_RECOVERY_DELAY_MS = 500;
const COMPANION_SUCCESS_DURATION_MS = 1_800;
const COMPANION_ERROR_DURATION_MS = 2_600;
const PET_SLEEP_DELAY_MS = 5 * 60 * 1_000;

/** Owns the independent transparent Pet window and its main-process motion loop. */
export default class PetRuntimeCoordinator implements PetRuntimeCoordinating {
  private readonly rendererPath: string;
  private readonly onOpenChat: () => void;
  private readonly onContextMenu: ((window: BrowserWindow | null) => void) | null;
  private readonly positionStore: PetPositionStoring | null;
  private readonly listeners = new Set<(state: PetRuntimeState) => void>();
  private readonly handleDisplayChange = (): void => {
    if (!this.settings?.isEnabled) return;
    this.refreshDisplayLocation(false);
  };
  private petWindow: BrowserWindow | null = null;
  private petWindowReady: Promise<void> | null = null;
  private petWindowIgnoresMouseEvents: boolean | null = null;
  private motionTimer: ReturnType<typeof setInterval> | null = null;
  private lastTickAt = 0;
  private settings: PetSettings | null = null;
  private motion: PetMotionState | null = null;
  private workArea: PetWorkArea | null = null;
  private activeDisplayId: number | null = null;
  private displaysAreBound = false;
  private returnAnimation: ReturnAnimation | null = null;
  private bubbleExpiresAt: number | null = null;
  private nextEasterAt = Number.POSITIVE_INFINITY;
  private easterTimer: ReturnType<typeof setTimeout> | null = null;
  private windowRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private windowRecoveryAttempts = 0;
  private windowStartPromise: Promise<void> | null = null;
  private companionFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  private sleepTimer: ReturnType<typeof setTimeout> | null = null;
  private transientCompanionFeedback: PetCompanionFeedback | null = null;
  private companionSnapshot: PetCompanionSnapshot = {
    gateway: 'stopped',
    router: 'stopped',
    model: 'idle',
    activeChatTurnCount: 0
  };
  private activeChatTurnIds: string[] = [];
  private isPaused = false;
  private hasRestoredPosition = false;
  private isShuttingDown = false;
  private state: PetRuntimeState = {
    phase: 'hidden',
    position: null,
    direction: 'right',
    size: 72,
    message: null,
    error: null,
    isPaused: false
  };

  constructor(options: {
    rendererPath?: string;
    onOpenChat?: () => void;
    onContextMenu?: (window: BrowserWindow | null) => void;
    positionStore?: PetPositionStoring;
  } = {}) {
    this.rendererPath = options.rendererPath ?? path.join(__dirname, '../../renderer/index.html');
    this.onOpenChat = options.onOpenChat ?? (() => undefined);
    this.onContextMenu = options.onContextMenu ?? null;
    this.positionStore = options.positionStore ?? null;
  }

  getState(): PetRuntimeState {
    return cloneRuntimeState(this.state);
  }

  subscribe(listener: (state: PetRuntimeState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Applies persisted settings and starts or stops the desktop runtime. */
  async applySettings(settings: PetSettings): Promise<void> {
    this.isShuttingDown = false;
    this.settings = { ...settings };
    if (!settings.isEnabled) {
      this.stop('disabled');
      return;
    }

    this.bindDisplayEvents();
    this.clearWindowRecovery();
    this.windowRecoveryAttempts = 0;
    await this.startEnabledRuntime();
  }

  /** Pauses movement while preserving the Pet window and its interactions. */
  setPaused(isPaused: boolean): void {
    if (!this.settings?.isEnabled) return;
    this.isPaused = isPaused;
    this.stopEasterTimer();
    if (!isPaused) this.scheduleNextEaster();
    this.markActivity();
    this.publishCompanionFeedback();
  }

  /** Receives narrow lifecycle signals from Tokkey services and Chat. */
  signalCompanion(signal: PetCompanionSignal): void {
    if (signal.source === 'chat') {
      this.handleChatSignal(signal);
      return;
    }

    this.companionSnapshot = {
      ...this.companionSnapshot,
      [signal.source]: signal.phase
    };
    this.markActivity();
    this.publishCompanionFeedback();
  }

  private handleChatSignal(signal: Extract<PetCompanionSignal, { source: 'chat' }>): void {
    if (signal.phase === 'sending') {
      if (!this.activeChatTurnIds.includes(signal.turnId)) {
        this.activeChatTurnIds = [...this.activeChatTurnIds, signal.turnId];
      }
    } else {
      this.activeChatTurnIds = this.activeChatTurnIds.filter((turnId) => turnId !== signal.turnId);
    }
    this.companionSnapshot = {
      ...this.companionSnapshot,
      activeChatTurnCount: this.activeChatTurnIds.length
    };
    this.markActivity();

    if (this.activeChatTurnIds.length > 0 || signal.phase === 'sending' || signal.phase === 'cancelled') {
      this.publishCompanionFeedback();
      return;
    }
    if (signal.phase === 'completed') {
      const currentFeedback = resolvePetCompanionFeedback(this.companionSnapshot);
      if (currentFeedback.phase === 'serviceError') {
        this.publishCompanionFeedback();
        return;
      }
      this.showTransientCompanionFeedback(
        { phase: 'celebrating', message: 'Reply ready.' },
        COMPANION_SUCCESS_DURATION_MS
      );
      return;
    }
    this.showTransientCompanionFeedback(
      { phase: 'serviceError', message: 'Chat request needs attention.' },
      COMPANION_ERROR_DURATION_MS
    );
  }

  /** Starts the enabled runtime once and retries transient window failures. */
  private startEnabledRuntime(): Promise<void> {
    if (this.windowStartPromise) return this.windowStartPromise;
    this.windowStartPromise = this.startEnabledRuntimeWithRetry()
      .finally(() => {
        this.windowStartPromise = null;
      });
    return this.windowStartPromise;
  }

  private async startEnabledRuntimeWithRetry(): Promise<void> {
    const settings = this.settings;
    if (!settings?.isEnabled) return;
    const size = petRenderSize(settings);

    try {
      this.refreshDisplayLocation(this.motion === null);
      const workArea = this.workArea;
      if (!workArea) {
        throw new Error('No display work area is available.');
      }
      if (!this.motion) {
        this.motion = initialPetMotion(settings, workArea);
      } else {
        this.motion = advancePetMotion(this.motion, settings, workArea, 0);
      }
      await this.restoreSavedPosition(settings);
      await this.ensurePetWindow();
      this.updateWindowBounds();
      this.startMotionTimer();
      if (!this.isPaused) this.scheduleNextEaster();
      this.scheduleSleep();
      this.windowRecoveryAttempts = 0;
      const feedback = this.currentCompanionFeedback();
      this.publish({
        phase: this.isPaused && feedback.phase === 'walking' ? 'paused' : feedback.phase,
        position: this.motion.position,
        direction: this.motion.direction,
        size,
        message: feedback.message,
        error: null,
        isPaused: this.isPaused
      });
    } catch (error) {
      this.stopMotionTimer();
      this.discardPetWindow();
      if (this.windowRecoveryAttempts < MAX_WINDOW_RECOVERY_ATTEMPTS && settings.isEnabled) {
        this.windowRecoveryAttempts += 1;
        await delay(WINDOW_RECOVERY_DELAY_MS);
        if (this.settings?.isEnabled && !this.isShuttingDown) {
          return this.startEnabledRuntimeWithRetry();
        }
        return;
      }
      this.publish({
        phase: 'error',
        position: null,
        direction: this.motion?.direction ?? 'right',
        size,
        message: null,
        error: `Pet window failed to start: ${describeError(error)}`,
        isPaused: this.isPaused
      });
    }
  }

  /** Stops movement and destroys the window so no child survives app quit. */
  stop(reason = 'disabled'): void {
    this.stopMotionTimer();
    this.stopEasterTimer();
    this.clearWindowRecovery();
    this.clearCompanionFeedbackTimer();
    this.clearSleepTimer();
    this.windowRecoveryAttempts = 0;
    this.returnAnimation = null;
    this.bubbleExpiresAt = null;
    this.nextEasterAt = Number.POSITIVE_INFINITY;
    this.isPaused = false;
    this.hasRestoredPosition = false;
    if (reason === 'application quit') {
      this.isShuttingDown = true;
      if (this.petWindow && !this.petWindow.isDestroyed()) {
        this.petWindow.destroy();
      }
      this.petWindow = null;
      this.petWindowReady = null;
      this.petWindowIgnoresMouseEvents = null;
      this.unbindDisplayEvents();
    } else {
      this.hidePetWindow();
    }
    const size = this.settings ? petRenderSize(this.settings) : this.state.size;
    this.motion = null;
    this.activeDisplayId = null;
    this.workArea = null;
    this.publish({
      phase: 'hidden',
      position: null,
      direction: 'right',
      size,
      message: null,
      error: null,
      isPaused: false
    });
  }

  /** Handles renderer pointer intent while keeping state transitions in main. */
  interact(interaction: PetInteraction): void {
    if (!this.settings?.isEnabled) return;
    this.markActivity();

    switch (interaction.type) {
      case 'mouseEnter':
        this.handleMouseEnter();
        return;
      case 'mouseLeave':
        this.handleMouseLeave();
        return;
      case 'contextMenu':
        this.onContextMenu?.(this.petWindow);
        return;
      case 'click':
        this.handleClick();
        return;
      case 'dragStart':
        this.handleDragStart();
        return;
      case 'dragMove':
        this.handleDragMove(interaction.point);
        return;
      case 'dragEnd':
        this.handleDragEnd();
        return;
    }
  }

  private bindDisplayEvents(): void {
    if (this.displaysAreBound) return;
    this.displaysAreBound = true;
    screen.on('display-added', this.handleDisplayChange);
    screen.on('display-metrics-changed', this.handleDisplayChange);
    screen.on('display-removed', this.handleDisplayChange);
  }

  private unbindDisplayEvents(): void {
    if (!this.displaysAreBound) return;
    this.displaysAreBound = false;
    screen.off('display-added', this.handleDisplayChange);
    screen.off('display-metrics-changed', this.handleDisplayChange);
    screen.off('display-removed', this.handleDisplayChange);
  }

  /** Chooses the display under the Pet window, or the current cursor on first start. */
  private refreshDisplayLocation(resetPosition: boolean): void {
    const display = readNearestDisplay(this.petWindow, this.motion, this.settings);
    const nextWorkArea = normalizeWorkArea(display.workArea);
    const displayChanged = this.activeDisplayId !== display.id || !sameWorkArea(this.workArea, nextWorkArea);
    this.activeDisplayId = display.id;
    this.workArea = nextWorkArea;
    if (!this.settings?.isEnabled || !this.motion || resetPosition || displayChanged) {
      if (this.settings?.isEnabled && this.workArea) {
        this.motion = initialPetMotion(this.settings, this.workArea);
      }
      return;
    }
    this.motion = advancePetMotion(this.motion, this.settings, this.workArea, 0);
    this.updateWindowBounds();
    this.publishCurrent(this.state.phase, this.state.message, this.state.error);
  }

  /** Restores a valid placement while falling back to the selected display. */
  private async restoreSavedPosition(settings: PetSettings): Promise<void> {
    if (this.hasRestoredPosition || !this.positionStore || !this.workArea) return;
    this.hasRestoredPosition = true;

    let savedPosition: PetPosition | null;
    try {
      savedPosition = await this.positionStore.load();
    } catch (error) {
      console.error('[Pet] Could not load saved position:', error);
      return;
    }
    if (!savedPosition) return;

    const savedDisplay = screen.getAllDisplays().find(
      (display) => display.id === savedPosition.displayId
    );
    if (savedDisplay) {
      this.activeDisplayId = savedDisplay.id;
      this.workArea = normalizeWorkArea(savedDisplay.workArea);
    }
    const bounds = petMovementBounds(settings, this.workArea);
    this.motion = {
      position: {
        x: clamp(savedPosition.x, bounds.minX, bounds.maxX),
        y: bounds.y
      },
      direction: this.motion?.direction ?? 'right'
    };
  }

  /** Saves only deliberate user placement changes, never every animation tick. */
  private persistCurrentPosition(): void {
    if (!this.positionStore || !this.motion) return;
    const position: PetPosition = {
      x: this.motion.position.x,
      y: this.motion.position.y,
      displayId: this.activeDisplayId
    };
    void this.positionStore.save(position).catch((error: unknown) => {
      console.error('[Pet] Could not save position:', error);
    });
  }

  private async ensurePetWindow(): Promise<void> {
    if (this.petWindow && !this.petWindow.isDestroyed()) {
      if (this.petWindowReady) await this.petWindowReady;
      return;
    }

    const petWindow = new BrowserWindow({
      width: this.state.size,
      height: this.state.size,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      skipTaskbar: true,
      focusable: false,
      show: false,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, '../preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    this.petWindow = petWindow;
    petWindow.setAlwaysOnTop(true, 'floating');
    petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    petWindow.setIgnoreMouseEvents(true, { forward: true });
    this.petWindowIgnoresMouseEvents = true;
    petWindow.on('closed', () => {
      if (this.petWindow === petWindow) {
        this.petWindow = null;
        this.petWindowReady = null;
        this.petWindowIgnoresMouseEvents = null;
        if (this.settings?.isEnabled && !this.isShuttingDown) {
          this.publish({
            phase: 'error',
            position: null,
            direction: this.motion?.direction ?? 'right',
            size: this.settings ? petRenderSize(this.settings) : this.state.size,
            message: null,
            error: 'Pet window was closed unexpectedly.',
            isPaused: this.isPaused
          });
          this.scheduleWindowRecovery();
        }
      }
    });
    petWindow.webContents.on('render-process-gone', (_event, details) => {
      this.handleWindowFailure(petWindow, `renderer ${details.reason}`);
    });
    this.petWindowReady = petWindow
      .loadFile(this.rendererPath, { query: { window: 'pet' } })
      .catch((error: unknown) => {
        this.discardPetWindow(petWindow);
        throw error;
      });
    await this.petWindowReady;
  }

  private startMotionTimer(): void {
    if (this.motionTimer) return;
    this.lastTickAt = Date.now();
    this.motionTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
  }

  private stopMotionTimer(): void {
    if (!this.motionTimer) return;
    clearInterval(this.motionTimer);
    this.motionTimer = null;
  }

  private tick(): void {
    if (!this.settings?.isEnabled || !this.motion || !this.workArea) return;
    this.syncMouseEventPolicy();
    const now = Date.now();
    const deltaSeconds = Math.min((now - this.lastTickAt) / 1_000, 0.25);
    this.lastTickAt = now;

    if (this.bubbleExpiresAt !== null && now >= this.bubbleExpiresAt) {
      this.bubbleExpiresAt = null;
      this.publishCurrent(this.state.phase, null, this.state.error);
    }

    if (this.returnAnimation) {
      const fraction = Math.min(
        1,
        (now - this.returnAnimation.startedAt) / RETURN_DURATION_MS
      );
      const eased = easeOutCubic(fraction);
      const { start, end } = this.returnAnimation;
      this.motion = {
        position: {
          x: start.x + (end.x - start.x) * eased,
          y: start.y + (end.y - start.y) * eased
        },
        direction: this.motion.direction
      };
      this.updateWindowBounds();
      if (fraction >= 1) {
        this.returnAnimation = null;
        this.persistCurrentPosition();
        this.publishCompanionFeedback(true);
      } else {
        this.publishCurrent('returning', this.state.message, null);
      }
      return;
    }

    if (this.isCompanionPhase(this.state.phase)) return;
    if (this.isPaused) {
      this.publishCurrent('paused', this.state.message, null);
      return;
    }
    if (this.state.phase === 'easter') return;
    if (this.state.phase !== 'walking' && this.state.phase !== 'idle') return;
    if (now >= this.nextEasterAt) {
      this.triggerEaster();
      return;
    }

    this.motion = advancePetMotion(this.motion, this.settings, this.workArea, deltaSeconds);
    this.updateWindowBounds();
    this.publish({
      phase: 'walking',
      position: this.motion.position,
      direction: this.motion.direction,
      size: petRenderSize(this.settings),
      message: this.state.message,
      error: null,
      isPaused: this.isPaused
    });
  }

  private handleMouseEnter(): void {
    if (this.state.phase === 'dragging' || this.state.phase === 'returning') return;
    this.stopEasterTimer();
    this.scheduleNextEaster();
    this.publishWithBubble('hover', 'Hi, I am here.');
  }

  private handleMouseLeave(): void {
    if (this.state.phase !== 'hover') return;
    this.publishCompanionFeedback(true);
  }

  private handleClick(): void {
    if (this.state.phase === 'dragging' || this.state.phase === 'returning') return;
    this.stopEasterTimer();
    this.scheduleNextEaster();
    this.publishWithBubble('clickWave', 'Opening chat...');
    try {
      this.onOpenChat();
      this.publishCurrent('openingChat', this.state.message, null);
      setTimeout(() => {
        if (this.state.phase === 'openingChat') {
          this.publishCompanionFeedback(true);
        }
      }, 260);
    } catch (error) {
      this.publishWithBubble('error', `Could not open Chat: ${describeError(error)}`);
    }
  }

  private handleDragStart(): void {
    if (!this.motion) return;
    this.stopEasterTimer();
    this.scheduleNextEaster();
    this.returnAnimation = null;
    this.publishWithBubble('dragging', 'Whoa!');
  }

  private handleDragMove(point: { x: number; y: number }): void {
    if (!this.motion || !this.settings) return;
    this.refreshDisplayLocationAtPoint(point);
    if (!this.workArea) return;
    const size = petRenderSize(this.settings);
    const maxX = this.workArea.x + Math.max(0, this.workArea.width - size);
    const maxY = this.workArea.y + Math.max(0, this.workArea.height - size);
    this.motion = {
      position: {
        x: clamp(point.x - size / 2, this.workArea.x, maxX),
        y: clamp(point.y - size / 2, this.workArea.y, maxY)
      },
      direction: this.motion.direction
    };
    this.updateWindowBounds();
    this.publishCurrent('dragging', this.state.message, null);
  }

  /** Rebinds the activity band when a drag crosses onto another display. */
  private refreshDisplayLocationAtPoint(point: { x: number; y: number }): void {
    const display = screen.getDisplayNearestPoint(point);
    const nextWorkArea = normalizeWorkArea(display.workArea);
    this.activeDisplayId = display.id;
    this.workArea = nextWorkArea;
  }

  private handleDragEnd(): void {
    if (!this.motion || !this.workArea || !this.settings) return;
    const bounds = petMovementBounds(this.settings, this.workArea);
    this.returnAnimation = {
      start: { ...this.motion.position },
      end: {
        x: clamp(this.motion.position.x, bounds.minX, bounds.maxX),
        y: bounds.y
      },
      startedAt: Date.now()
    };
    this.publishWithBubble('returning', 'Back to my spot.');
  }

  private triggerEaster(): void {
    if (this.isPaused) return;
    this.stopEasterTimer();
    const messages = ['Still here.', 'Tiny stretch.', 'I am watching.'];
    const message = messages[Math.floor(Math.random() * messages.length)] ?? messages[0];
    this.publishWithBubble('easter', message);
    this.easterTimer = setTimeout(() => {
      this.easterTimer = null;
      if (!this.settings?.isEnabled || this.state.phase !== 'easter') return;
      this.scheduleNextEaster();
      this.publishCompanionFeedback(true);
    }, EASTER_DURATION_MS);
  }

  private stopEasterTimer(): void {
    if (!this.easterTimer) return;
    clearTimeout(this.easterTimer);
    this.easterTimer = null;
  }

  private scheduleNextEaster(): void {
    const delay = MIN_EASTER_DELAY_MS + Math.random() * (MAX_EASTER_DELAY_MS - MIN_EASTER_DELAY_MS);
    this.nextEasterAt = Date.now() + delay;
  }

  private currentCompanionFeedback(): PetCompanionFeedback {
    return this.transientCompanionFeedback ?? resolvePetCompanionFeedback(this.companionSnapshot);
  }

  private publishCompanionFeedback(force = false): void {
    if (
      !this.settings?.isEnabled ||
      !this.motion ||
      (!force && this.isInteractionPhase(this.state.phase))
    ) return;
    const feedback = this.currentCompanionFeedback();
    const phase = this.isPaused && feedback.phase === 'walking' ? 'paused' : feedback.phase;
    this.publishCurrent(phase, feedback.message, null);
  }

  private showTransientCompanionFeedback(
    feedback: PetCompanionFeedback,
    durationMs: number
  ): void {
    this.clearCompanionFeedbackTimer();
    this.transientCompanionFeedback = feedback;
    this.publishCompanionFeedback();
    this.companionFeedbackTimer = setTimeout(() => {
      this.companionFeedbackTimer = null;
      this.transientCompanionFeedback = null;
      this.publishCompanionFeedback();
    }, durationMs);
    this.companionFeedbackTimer.unref?.();
  }

  private clearCompanionFeedbackTimer(): void {
    if (this.companionFeedbackTimer) {
      clearTimeout(this.companionFeedbackTimer);
      this.companionFeedbackTimer = null;
    }
    this.transientCompanionFeedback = null;
  }

  private markActivity(): void {
    this.scheduleSleep();
    if (this.state.phase === 'sleeping') this.publishCompanionFeedback();
  }

  private scheduleSleep(): void {
    this.clearSleepTimer();
    if (!this.settings?.isEnabled) return;
    this.sleepTimer = setTimeout(() => {
      this.sleepTimer = null;
      const feedback = resolvePetCompanionFeedback(this.companionSnapshot);
      if (
        feedback.phase !== 'walking' ||
        this.transientCompanionFeedback ||
        this.isPaused ||
        this.isInteractionPhase(this.state.phase)
      ) {
        this.scheduleSleep();
        return;
      }
      this.stopEasterTimer();
      this.publishCurrent('sleeping', null, null);
    }, PET_SLEEP_DELAY_MS);
    this.sleepTimer.unref?.();
  }

  private clearSleepTimer(): void {
    if (!this.sleepTimer) return;
    clearTimeout(this.sleepTimer);
    this.sleepTimer = null;
  }

  private isInteractionPhase(phase: PetRuntimeState['phase']): boolean {
    return phase === 'hover' ||
      phase === 'clickWave' ||
      phase === 'dragging' ||
      phase === 'returning' ||
      phase === 'openingChat' ||
      phase === 'easter' ||
      phase === 'error';
  }

  private isCompanionPhase(phase: PetRuntimeState['phase']): boolean {
    return phase === 'working' ||
      phase === 'thinking' ||
      phase === 'celebrating' ||
      phase === 'serviceError' ||
      phase === 'sleeping';
  }

  private publishWithBubble(phase: PetRuntimeState['phase'], message: string): void {
    this.bubbleExpiresAt = Date.now() + BUBBLE_DURATION_MS;
    this.publishCurrent(phase, message, null);
  }

  private publishCurrent(
    phase: PetRuntimeState['phase'],
    message: string | null,
    error: string | null
  ): void {
    if (!this.settings) return;
    this.publish({
      phase,
      position: this.motion?.position ?? null,
      direction: this.motion?.direction ?? this.state.direction,
      size: petRenderSize(this.settings),
      message,
      error,
      isPaused: this.isPaused
    });
  }

  private updateWindowBounds(): void {
    if (!this.petWindow || this.petWindow.isDestroyed() || !this.motion || !this.settings) return;
    const size = petRenderSize(this.settings);
    const windowWidth = Math.max(220, size + PET_WINDOW_EXTRA_WIDTH_PX);
    const windowHeight = size + PET_WINDOW_BUBBLE_SPACE_PX;
    this.petWindow.setBounds({
      x: Math.round(this.motion.position.x - (windowWidth - size) / 2),
      y: Math.round(this.motion.position.y - PET_WINDOW_BUBBLE_SPACE_PX),
      width: windowWidth,
      height: windowHeight
    }, false);
    this.syncMouseEventPolicy();
    if (!this.petWindow.isVisible()) {
      this.petWindow.showInactive();
    }
  }

  private hidePetWindow(): void {
    if (!this.petWindow || this.petWindow.isDestroyed()) return;
    this.petWindow.hide();
  }

  /** Lets transparent bubble margins pass clicks through to the window below. */
  private syncMouseEventPolicy(): void {
    if (!this.petWindow || this.petWindow.isDestroyed() || !this.motion || !this.settings) return;
    const cursorIsOverPet = isPointInsidePetBody(
      screen.getCursorScreenPoint(),
      this.motion,
      this.settings
    );
    const shouldIgnoreMouseEvents = !cursorIsOverPet;
    if (this.petWindowIgnoresMouseEvents === shouldIgnoreMouseEvents) return;
    this.petWindow.setIgnoreMouseEvents(shouldIgnoreMouseEvents, { forward: true });
    this.petWindowIgnoresMouseEvents = shouldIgnoreMouseEvents;
  }

  /** Removes a failed window before a recovery attempt creates its replacement. */
  private discardPetWindow(window = this.petWindow): void {
    if (!window) return;
    if (this.petWindow === window) {
      this.petWindow = null;
      this.petWindowReady = null;
      this.petWindowIgnoresMouseEvents = null;
    }
    if (!window.isDestroyed()) window.destroy();
  }

  private handleWindowFailure(window: BrowserWindow, reason: string): void {
    if (this.petWindow !== window || !this.settings?.isEnabled || this.isShuttingDown) return;
    this.stopMotionTimer();
    this.discardPetWindow(window);
    this.publishCurrent('error', null, `Pet window stopped: ${reason}.`);
    this.scheduleWindowRecovery();
  }

  private scheduleWindowRecovery(): void {
    if (
      this.windowRecoveryTimer ||
      this.windowRecoveryAttempts >= MAX_WINDOW_RECOVERY_ATTEMPTS ||
      !this.settings?.isEnabled ||
      this.isShuttingDown
    ) {
      return;
    }
    this.windowRecoveryAttempts += 1;
    this.windowRecoveryTimer = setTimeout(() => {
      this.windowRecoveryTimer = null;
      if (this.settings?.isEnabled && !this.isShuttingDown) {
        void this.startEnabledRuntime().catch((error: unknown) => {
          console.error('[Pet] Window recovery failed:', error);
        });
      }
    }, WINDOW_RECOVERY_DELAY_MS);
  }

  private clearWindowRecovery(): void {
    if (!this.windowRecoveryTimer) return;
    clearTimeout(this.windowRecoveryTimer);
    this.windowRecoveryTimer = null;
  }

  private publish(nextState: PetRuntimeState): void {
    this.state = cloneRuntimeState(nextState);
    const snapshot = this.getState();
    this.listeners.forEach((listener) => listener(snapshot));
  }
}

function readNearestDisplay(
  petWindow: BrowserWindow | null,
  motion: PetMotionState | null,
  settings: PetSettings | null
) {
  const point = petWindow && !petWindow.isDestroyed()
    ? centerOfBounds(petWindow.getBounds())
    : motion && settings
      ? {
          x: motion.position.x + petRenderSize(settings) / 2,
          y: motion.position.y + petRenderSize(settings) / 2
        }
      : screen.getCursorScreenPoint();
  return screen.getDisplayNearestPoint(point);
}

function normalizeWorkArea(workArea: Electron.Rectangle): PetWorkArea {
  return { x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height };
}

function centerOfBounds(bounds: Electron.Rectangle): { x: number; y: number } {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

function sameWorkArea(left: PetWorkArea | null, right: PetWorkArea): boolean {
  return left !== null &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function cloneRuntimeState(state: PetRuntimeState): PetRuntimeState {
  return {
    ...state,
    position: state.position ? { ...state.position } : null
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ReturnAnimation {
  start: { x: number; y: number };
  end: { x: number; y: number };
  startedAt: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function easeOutCubic(value: number): number {
  return 1 - (1 - value) ** 3;
}

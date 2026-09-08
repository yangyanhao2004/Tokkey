import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { PetInteraction, PetRuntimePhase } from '../../shared/types';
import { usePetRuntimeState } from '../hooks/usePetRuntimeState';

const PET_ASSET_BASE_PATH = './assets/pet';
const PET_ANIMATION_BASE_PATH = `${PET_ASSET_BASE_PATH}/animations`;
const DRAG_THRESHOLD_PX = 4;

const FRAME_COUNTS: Record<PetRuntimePhase, number> = {
  hidden: 1,
  idle: 34,
  paused: 34,
  working: 5,
  thinking: 20,
  celebrating: 16,
  serviceError: 20,
  sleeping: 34,
  walking: 8,
  hover: 20,
  clickWave: 16,
  dragging: 5,
  returning: 8,
  easter: 5,
  openingChat: 16,
  error: 1
};

const FRAME_FOLDERS: Record<PetRuntimePhase, string> = {
  hidden: 'idle-tail',
  idle: 'idle-tail',
  paused: 'idle-tail',
  working: 'hover-wink',
  thinking: 'hover-face',
  celebrating: 'click-wave',
  serviceError: 'hover-face',
  sleeping: 'idle-tail',
  walking: 'walk-left',
  hover: 'hover-face',
  clickWave: 'click-wave',
  dragging: 'hover-wink',
  returning: 'walk-left',
  easter: 'hover-wink',
  openingChat: 'click-wave',
  error: 'idle-tail'
};

const PET_BODY_SIZE_CLASSES: Record<number, string> = {
  56: 'size-[56px]',
  72: 'size-[72px]',
  96: 'size-[96px]'
};

function sendInteraction(interaction: PetInteraction): void {
  window.tokkey.sendPetInteraction(interaction);
}

function pointFromEvent(event: PointerEvent<HTMLDivElement>) {
  return { x: event.screenX, y: event.screenY };
}

/** Minimal renderer for the transparent desktop Pet BrowserWindow. */
export function PetWindow() {
  const runtimeState = usePetRuntimeState();
  const frameIndexRef = useRef(0);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const isDraggingRef = useRef(false);
  const [frameIndex, setFrameIndex] = useState(0);
  // The borrowed walk-left frames face left by default, so rightward motion
  // needs the same horizontal flip used by Amis-Wifi's Pet renderer.
  const directionClass = runtimeState.direction === 'right' ? '-scale-x-100' : '';
  const frameCount = FRAME_COUNTS[runtimeState.phase];
  const frameFolder = FRAME_FOLDERS[runtimeState.phase];
  const bodySizeClass = PET_BODY_SIZE_CLASSES[runtimeState.size] ?? 'size-[72px]';

  useEffect(() => {
    frameIndexRef.current = 0;
    setFrameIndex(0);
    const timer = window.setInterval(() => {
      frameIndexRef.current = (frameIndexRef.current + 1) % frameCount;
      setFrameIndex(frameIndexRef.current);
    }, 95);
    return () => window.clearInterval(timer);
  }, [runtimeState.phase, frameCount, frameFolder]);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerStartRef.current = pointFromEvent(event);
    isDraggingRef.current = false;
    event.preventDefault();
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = pointerStartRef.current;
    if (!start) return;
    const point = pointFromEvent(event);
    const distance = Math.hypot(point.x - start.x, point.y - start.y);
    if (!isDraggingRef.current && distance < DRAG_THRESHOLD_PX) return;
    if (!isDraggingRef.current) {
      isDraggingRef.current = true;
      sendInteraction({ type: 'dragStart', point });
    }
    sendInteraction({ type: 'dragMove', point });
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointerStartRef.current) return;
    if (isDraggingRef.current) {
      sendInteraction({ type: 'dragEnd' });
    } else {
      sendInteraction({ type: 'click' });
    }
    pointerStartRef.current = null;
    isDraggingRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handlePointerCancel = () => {
    if (isDraggingRef.current) sendInteraction({ type: 'dragEnd' });
    pointerStartRef.current = null;
    isDraggingRef.current = false;
  };

  return (
    <div
      className="pet-window-surface pointer-events-none relative h-full w-full"
      aria-label="Tokkey Pet"
      data-testid="pet-window"
    >
      {runtimeState.message ? (
        <span
          className="pointer-events-none absolute top-0 left-1/2 z-10 max-w-[210px] -translate-x-1/2 truncate rounded-[6px] border border-black/12 bg-white px-2 py-1 text-[11px] leading-[16px] font-semibold text-black/82 shadow-[0px_3px_6px_rgba(0,0,0,0.12)]"
          data-testid="pet-bubble"
        >
          {runtimeState.message}
        </span>
      ) : null}
      <div
        className={`pointer-events-auto absolute bottom-0 left-1/2 -translate-x-1/2 cursor-grab active:cursor-grabbing ${bodySizeClass}`}
        onPointerEnter={() => sendInteraction({ type: 'mouseEnter' })}
        onPointerLeave={() => sendInteraction({ type: 'mouseLeave' })}
        onContextMenu={(event) => {
          event.preventDefault();
          sendInteraction({ type: 'contextMenu' });
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
      >
        <img
          className={`pet-pixel-art block size-full object-contain ${directionClass}`}
          src={`${PET_ANIMATION_BASE_PATH}/${frameFolder}/${String(frameIndex + 1).padStart(3, '0')}.png`}
          alt="Tokkey Pet"
          draggable={false}
        />
      </div>
    </div>
  );
}

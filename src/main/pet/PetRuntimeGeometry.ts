import type { PetSettings } from '../../shared/types';

export interface PetWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PetPosition {
  x: number;
  y: number;
}

export type PetDirection = 'left' | 'right';

export interface PetMotionState {
  position: PetPosition;
  direction: PetDirection;
}

export interface PetMovementBounds {
  minX: number;
  maxX: number;
  y: number;
}

/** Returns whether one screen point is inside the visible Pet body. */
export function isPointInsidePetBody(
  point: PetPosition,
  motion: PetMotionState,
  settings: PetSettings
): boolean {
  const size = petRenderSize(settings);
  return point.x >= motion.position.x &&
    point.x < motion.position.x + size &&
    point.y >= motion.position.y &&
    point.y < motion.position.y + size;
}

// The window reserves 46px above the body for the fixed bubble slot.
const PET_TOP_OFFSET_PX = 54;

/** Converts the three UI size values into stable desktop-pixel dimensions. */
export function petRenderSize(settings: PetSettings): number {
  switch (settings.size) {
    case 'small':
      return 56;
    case 'mid':
      return 72;
    case 'large':
      return 96;
  }
}

/** Converts the speed control into points per second. */
export function petPointsPerSecond(settings: PetSettings): number {
  switch (settings.speed) {
    case 'small':
      return 25;
    case 'mid':
      return 45;
    case 'large':
      return 70;
  }
}

/** Converts the range control into the share of the display work area. */
export function petMovementRangeFraction(settings: PetSettings): number {
  switch (settings.movementRange) {
    case 'small':
      return 0.35;
    case 'mid':
      return 0.65;
    case 'large':
      return 0.9;
  }
}

/** Returns the horizontal activity band in Electron screen coordinates. */
export function petMovementBounds(
  settings: PetSettings,
  workArea: PetWorkArea
): PetMovementBounds {
  const size = petRenderSize(settings);
  const activityWidth = Math.max(size, workArea.width * petMovementRangeFraction(settings));
  const minX = workArea.x + (workArea.width - activityWidth) / 2;
  const maxX = minX + activityWidth - size;
  return {
    minX,
    maxX: Math.max(minX, maxX),
    y: workArea.y + PET_TOP_OFFSET_PX
  };
}

/** Places a newly enabled Pet in the center of its activity band. */
export function initialPetMotion(
  settings: PetSettings,
  workArea: PetWorkArea
): PetMotionState {
  const bounds = petMovementBounds(settings, workArea);
  return {
    position: { x: (bounds.minX + bounds.maxX) / 2, y: bounds.y },
    direction: 'right'
  };
}

/** Advances one motion step and reflects at both activity-band boundaries. */
export function advancePetMotion(
  motion: PetMotionState,
  settings: PetSettings,
  workArea: PetWorkArea,
  deltaSeconds: number
): PetMotionState {
  const bounds = petMovementBounds(settings, workArea);
  const distance = petPointsPerSecond(settings) * Math.max(0, deltaSeconds);
  const signedDistance = motion.direction === 'right' ? distance : -distance;
  const candidateX = motion.position.x + signedDistance;

  if (candidateX >= bounds.maxX) {
    return {
      position: { x: bounds.maxX, y: bounds.y },
      direction: 'left'
    };
  }
  if (candidateX <= bounds.minX) {
    return {
      position: { x: bounds.minX, y: bounds.y },
      direction: 'right'
    };
  }
  return {
    position: { x: candidateX, y: bounds.y },
    direction: motion.direction
  };
}

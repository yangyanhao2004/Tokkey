import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import test from 'node:test';
import path from 'node:path';

import {
  advancePetMotion,
  initialPetMotion,
  isPointInsidePetBody,
  petMovementBounds,
  petMovementRangeFraction,
  petPointsPerSecond,
  petRenderSize
} from '../dist/main/pet/PetRuntimeGeometry.js';
import { resolvePetCompanionFeedback } from '../dist/main/pet/PetCompanionStatus.js';

const WORK_AREA = { x: 0, y: 0, width: 1_000, height: 800 };

function settings(overrides = {}) {
  return {
    isEnabled: true,
    size: 'mid',
    speed: 'mid',
    movementRange: 'small',
    ...overrides
  };
}

test('Pet settings map to the finite runtime geometry values', () => {
  assert.equal(petRenderSize(settings({ size: 'small' })), 56);
  assert.equal(petRenderSize(settings({ size: 'mid' })), 72);
  assert.equal(petRenderSize(settings({ size: 'large' })), 96);
  assert.equal(petPointsPerSecond(settings({ speed: 'small' })), 25);
  assert.equal(petPointsPerSecond(settings({ speed: 'mid' })), 45);
  assert.equal(petPointsPerSecond(settings({ speed: 'large' })), 70);
  assert.equal(petMovementRangeFraction(settings({ movementRange: 'small' })), 0.35);
  assert.equal(petMovementRangeFraction(settings({ movementRange: 'mid' })), 0.65);
  assert.equal(petMovementRangeFraction(settings({ movementRange: 'large' })), 0.9);
});

test('Pet starts centered in its horizontal activity band', () => {
  const petSettings = settings();
  const bounds = petMovementBounds(petSettings, WORK_AREA);
  const motion = initialPetMotion(petSettings, WORK_AREA);

  assert.equal(bounds.minX, 325);
  assert.equal(bounds.maxX, 603);
  assert.deepEqual(motion, {
    position: { x: 464, y: 54 },
    direction: 'right'
  });
});

test('Pet geometry keeps negative screen coordinates on a secondary display', () => {
  const secondaryWorkArea = { x: -1_440, y: 20, width: 1_440, height: 900 };
  const bounds = petMovementBounds(settings({ movementRange: 'large' }), secondaryWorkArea);

  assert.equal(bounds.minX, -1_368);
  assert.equal(bounds.maxX, -144);
  assert.equal(bounds.y, 74);
});

test('Pet movement uses elapsed time and keeps its direction inside bounds', () => {
  const petSettings = settings();
  const initialMotion = initialPetMotion(petSettings, WORK_AREA);
  const movedMotion = advancePetMotion(initialMotion, petSettings, WORK_AREA, 1);

  assert.deepEqual(movedMotion, {
    position: { x: 509, y: 54 },
    direction: 'right'
  });
});

test('Pet pointer hit testing excludes transparent window margins', () => {
  const petSettings = settings();
  const motion = { position: { x: -120, y: 40 }, direction: 'right' };

  assert.equal(isPointInsidePetBody({ x: -120, y: 40 }, motion, petSettings), true);
  assert.equal(isPointInsidePetBody({ x: -49, y: 111 }, motion, petSettings), true);
  assert.equal(isPointInsidePetBody({ x: -48, y: 60 }, motion, petSettings), false);
  assert.equal(isPointInsidePetBody({ x: -121, y: 60 }, motion, petSettings), false);
  assert.equal(isPointInsidePetBody({ x: -20, y: 60 }, motion, petSettings), false);
  assert.equal(isPointInsidePetBody({ x: -80, y: 30 }, motion, petSettings), false);
});

test('Pet reflects at the right and left activity boundaries', () => {
  const petSettings = settings();
  const bounds = petMovementBounds(petSettings, WORK_AREA);

  const rightEdge = advancePetMotion(
    { position: { x: bounds.maxX - 1, y: bounds.y }, direction: 'right' },
    petSettings,
    WORK_AREA,
    1
  );
  const leftEdge = advancePetMotion(
    { position: { x: bounds.minX + 1, y: bounds.y }, direction: 'left' },
    petSettings,
    WORK_AREA,
    1
  );

  assert.deepEqual(rightEdge, {
    position: { x: bounds.maxX, y: bounds.y },
    direction: 'left'
  });
  assert.deepEqual(leftEdge, {
    position: { x: bounds.minX, y: bounds.y },
    direction: 'right'
  });
});

test('Pet companion status prioritizes Chat, failures, and startup work', () => {
  const base = {
    gateway: 'running',
    router: 'running',
    model: 'running',
    activeChatTurnCount: 0
  };

  assert.deepEqual(resolvePetCompanionFeedback(base), {
    phase: 'walking',
    message: null
  });
  assert.deepEqual(resolvePetCompanionFeedback({ ...base, model: 'failed' }), {
    phase: 'walking',
    message: null
  });
  assert.deepEqual(resolvePetCompanionFeedback({ ...base, gateway: 'starting' }), {
    phase: 'working',
    message: 'Starting Gateway...'
  });
  assert.deepEqual(resolvePetCompanionFeedback({ ...base, router: 'error' }), {
    phase: 'serviceError',
    message: 'Router needs attention.'
  });
  assert.deepEqual(resolvePetCompanionFeedback({
    ...base,
    router: 'error',
    activeChatTurnCount: 1
  }), {
    phase: 'thinking',
    message: 'Thinking...'
  });
});

test('Pet animation assets cover every runtime phase folder', async () => {
  const animationRoot = path.join(process.cwd(), 'src/renderer/assets/pet/animations');
  const expectedFrameCounts = {
    'click-wave': 16,
    'hover-face': 20,
    'hover-wink': 5,
    'idle-tail': 34,
    'walk-left': 8
  };

  for (const [folder, expectedCount] of Object.entries(expectedFrameCounts)) {
    const files = (await readdir(path.join(animationRoot, folder)))
      .filter((fileName) => fileName.endsWith('.png'))
      .sort();
    assert.equal(files.length, expectedCount, `${folder} frame count`);
    assert.equal(files[0], '001.png');
    assert.equal(files.at(-1), `${String(expectedCount).padStart(3, '0')}.png`);
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { TokiieApp } from '../dist/main/TokiieApp.js';

// Keep normal, development, and evidence launch modes distinct at the startup seam.
test('normal source launch does not open detached DevTools', () => {
  assert.equal(TokiieApp.shouldOpenDevTools(false, ['electron', '.']), false);
});

test('explicit dev launch opens detached DevTools', () => {
  assert.equal(TokiieApp.shouldOpenDevTools(false, ['electron', '.', '--dev']), true);
});

test('evidence launch never opens detached DevTools', () => {
  assert.equal(TokiieApp.shouldOpenDevTools(true, ['electron', '.', '--dev']), false);
});

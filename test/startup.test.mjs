import assert from 'node:assert/strict';
import test from 'node:test';

import { TokkeyApp } from '../dist/main/TokkeyApp.js';

// Keep normal, development, and evidence launch modes distinct at the startup seam.
test('normal source launch does not open detached DevTools', () => {
  assert.equal(TokkeyApp.shouldOpenDevTools(false, ['electron', '.']), false);
});

test('explicit dev launch opens detached DevTools', () => {
  assert.equal(TokkeyApp.shouldOpenDevTools(false, ['electron', '.', '--dev']), true);
});

test('evidence launch never opens detached DevTools', () => {
  assert.equal(TokkeyApp.shouldOpenDevTools(true, ['electron', '.', '--dev']), false);
});

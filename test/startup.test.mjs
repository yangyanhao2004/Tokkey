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

test('a second instance recreates a closed main window', () => {
  const application = Object.create(TokkeyApp.prototype);
  let createCount = 0;
  application.mainWindow = null;
  application.createMainWindow = () => {
    createCount += 1;
    return {};
  };

  application.focusMainWindow();

  assert.equal(createCount, 1);
});

test('a second instance restores and focuses an existing main window', () => {
  const application = Object.create(TokkeyApp.prototype);
  const calls = [];
  application.mainWindow = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => calls.push('restore'),
    focus: () => calls.push('focus')
  };
  application.createMainWindow = () => {
    throw new Error('Existing window must be reused.');
  };

  application.focusMainWindow();

  assert.deepEqual(calls, ['restore', 'focus']);
});

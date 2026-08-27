import assert from 'node:assert/strict';
import test from 'node:test';

import { EvidenceCommandLine } from '../dist/main/evidence/EvidenceCommandLine.js';

test('evidence command line preserves explicit Figma dimensions and output', () => {
  const options = EvidenceCommandLine.parse([
    '--evidence',
    '--width',
    '1440',
    '--height',
    '900',
    '--output',
    '.artifacts/figma-home'
  ]);

  assert.deepEqual(options, {
    width: 1440,
    height: 900,
    outputDirectory: '.artifacts/figma-home'
  });
});

test('evidence command line requires explicit Figma dimensions', () => {
  assert.throws(
    () => EvidenceCommandLine.parse(['--evidence']),
    /--width is required for evidence capture/
  );
  assert.equal(EvidenceCommandLine.parse([]), null);
});

test('evidence command line rejects invalid dimensions and missing values', () => {
  assert.throws(
    () => EvidenceCommandLine.parse(['--evidence', '--width', '0']),
    /--width must be a positive integer/
  );
  assert.throws(
    () => EvidenceCommandLine.parse(['--evidence', '--width', '100', '--height']),
    /--height requires a value/
  );
});

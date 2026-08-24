import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ClaudeCodeMcpAdapter,
  CodexMcpAdapter,
  LocalMcpCatalogScanner
} from '../dist/main/mcp/McpCatalogScanner.js';

/** Owns an isolated home directory for one MCP scanner test. */
class TestHome {
  constructor() {
    this.root = mkdtempSync(path.join(os.tmpdir(), 'tokiie-mcp-test-'));
  }

  write(relativePath, contents) {
    const filePath = path.join(this.root, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents);
  }

  cleanup() {
    rmSync(this.root, { recursive: true, force: true });
  }
}

test('missing MCP files produce an empty catalog without failures', async () => {
    const home = new TestHome();
  try {
    const result = await new LocalMcpCatalogScanner({ homeDirectory: home.root }).scanInstalledMcps();
    assert.deepEqual(result, { servers: [], failures: [] });
  } finally {
    home.cleanup();
  }
});

test('equivalent Claude and Codex stdio definitions merge into one card', async () => {
  const home = new TestHome();
  try {
    home.write('.claude.json', JSON.stringify({ mcpServers: { tools: { command: ' node ', args: ['--serve'], env: { TOKEN: 'x' } } } }));
    home.write('.codex/config.toml', '[mcp_servers.tools]\ncommand = "node"\nargs = ["--serve"]\n[mcp_servers.tools.env]\nTOKEN = "x"\n');

    const result = await new LocalMcpCatalogScanner({ homeDirectory: home.root }).scanInstalledMcps();
    assert.equal(result.failures.length, 0);
    assert.equal(result.servers.length, 1);
    assert.deepEqual(result.servers[0].agents, ['claudeCode', 'codex']);
    assert.deepEqual(result.servers[0].badges.map((badge) => badge.state), ['checked', 'checked']);
  } finally {
    home.cleanup();
  }
});

test('normalizes remote aliases and disables Codex for SSE', async () => {
  const home = new TestHome();
  try {
    home.write('.claude.json', JSON.stringify({ mcpServers: { remote: { type: 'http', url: ' https://example.com/mcp ' }, events: { type: 'sse', url: 'https://events.example.com' } } }));
    const result = await new LocalMcpCatalogScanner({ homeDirectory: home.root }).scanInstalledMcps();
    assert.equal(result.servers[0].connectionType, 'sse');
    assert.equal(result.servers[0].badges[1].state, 'disabled');
    assert.equal(result.servers[1].connectionType, 'streamable_http');
  } finally {
    home.cleanup();
  }
});

test('keeps valid siblings, reports malformed files, and assigns stable collision IDs', async () => {
  const home = new TestHome();
  try {
    home.write('.claude.json', JSON.stringify({ mcpServers: { duplicate: { command: 'one' }, skipped: { command: 'two', headers: {} } } }));
    home.write('.codex/config.toml', '[mcp_servers.duplicate]\ncommand = "two"\n');

    const scanner = new LocalMcpCatalogScanner({ homeDirectory: home.root });
    const first = await scanner.scanInstalledMcps();
    const second = await scanner.scanInstalledMcps();
    assert.equal(first.failures.length, 0);
    assert.equal(first.servers.find((server) => server.name === 'skipped'), undefined);
    assert.equal(first.servers.filter((server) => server.name === 'duplicate').length, 2);
    assert.deepEqual(first.servers.map((server) => server.id), second.servers.map((server) => server.id));
    assert.ok(first.servers.every((server) => server.hasNameCollision));
  } finally {
    home.cleanup();
  }
});

test('reports a malformed Codex file while retaining valid Claude cards', async () => {
  const home = new TestHome();
  try {
    home.write('.claude.json', JSON.stringify({ mcpServers: { valid: { command: 'node' } } }));
    home.write('.codex/config.toml', '{ invalid toml');
    const result = await new LocalMcpCatalogScanner({ homeDirectory: home.root }).scanInstalledMcps();
    assert.deepEqual(result.servers.map((server) => server.name), ['valid']);
    assert.deepEqual(result.failures.map((failure) => failure.agent), ['codex']);
  } finally {
    home.cleanup();
  }
});

test('parses quoted Codex names and nested environment tables', () => {
  const readout = new CodexMcpAdapter().parse('[mcp_servers."my server"]\ncommand = "node"\n[mcp_servers."my server".env]\nTOKEN = "secret"\n');
  assert.equal(readout.servers[0].name, 'my server');
  assert.deepEqual(readout.servers[0].environment, { TOKEN: 'secret' });
});

test('treats empty adapter input as an empty configuration', () => {
  assert.deepEqual(new ClaudeCodeMcpAdapter().parse(''), { servers: [], skipped: [] });
  assert.deepEqual(new CodexMcpAdapter().parse(''), { servers: [], skipped: [] });
});

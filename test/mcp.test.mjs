import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ClaudeCodeMcpAdapter,
  CodexMcpAdapter,
  LocalMcpCatalogScanner
} from '../dist/main/mcp/McpCatalogScanner.js';
import {
  McpCommandLineParser,
  McpConfigurationCodec,
  McpConfigurationPreparer
} from '../dist/shared/McpConfiguration.js';
import { LocalMcpConfigurationApplier } from '../dist/main/mcp/McpConfigurationApplier.js';
import { McpConfigurationFileWriter } from '../dist/main/mcp/McpConfigurationFileWriter.js';

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

  read(relativePath) {
    return readFileSync(path.join(this.root, relativePath), 'utf8');
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
    const events = result.servers.find((server) => server.name === 'events');
    assert.equal(events.connectionType, 'sse');
    assert.equal(events.badges.find((badge) => badge.agent === 'codex').state, 'disabled');
    assert.equal(result.servers.find((server) => server.name === 'remote').connectionType, 'streamable_http');
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

test('parses quoted command lines and prepares wizard fields without invoking a shell', () => {
  const parser = new McpCommandLineParser();
  assert.deepEqual(parser.parse('node "two words" \'\' \'literal\\slash\' escaped\\ value'), [
    'node',
    'two words',
    '',
    'literal\\slash',
    'escaped value'
  ]);
  assert.throws(() => parser.parse('node "unfinished'), /unterminated quote/);

  const result = new McpConfigurationPreparer().prepare({
    mode: 'wizard',
    name: ' tools ',
    connectionType: 'stdio',
    commandLine: 'node "server file.js"',
    environmentText: 'TOKEN=secret,EMPTY=',
    url: ''
  });
  assert.equal(result.isValid, true);
  assert.deepEqual(result.configuration, {
    name: 'tools',
    connectionType: 'stdio',
    command: 'node',
    arguments: ['server file.js'],
    environment: { TOKEN: 'secret', EMPTY: '' },
    url: null
  });
});

test('enforces the strict one-server full JSON schema', () => {
  const codec = new McpConfigurationCodec();
  assert.throws(
    () => codec.decode('{"mcpServers":{"one":{"type":"stdio","command":"node"}},"other":true}'),
    /only mcpServers/
  );
  assert.throws(
    () => codec.decode('{"mcpServers":{"one":{"type":"stdio","command":"node","headers":{}}}}'),
    /Unsupported server field: headers/
  );
  assert.throws(
    () => codec.decode('{"mcpServers":{"one":{"type":"streamable_http","url":"file:\/\/tmp\/mcp"}}}'),
    /HTTP or HTTPS/
  );
});

test('applies one canonical MCP to Claude and Codex in one call', async () => {
  const home = new TestHome();
  try {
    home.write('.claude.json', '{"theme":"dark"}\n');
    home.write('.codex/config.toml', 'model = "gpt-5"\n');
    const configurationJson = new McpConfigurationCodec().encode({
      name: 'tools',
      connectionType: 'stdio',
      command: 'node',
      arguments: ['server.js'],
      environment: { TOKEN: 'secret' },
      url: null
    });

    await new LocalMcpConfigurationApplier({ homeDirectory: home.root }).apply(
      configurationJson,
      ['claudeCode', 'codex']
    );

    assert.equal(JSON.parse(home.read('.claude.json')).theme, 'dark');
    assert.match(home.read('.codex/config.toml'), /model = "gpt-5"/);
    assert.match(home.read('.codex/config.toml'), /\[mcp_servers\."tools"\]/);
    const catalog = await new LocalMcpCatalogScanner({ homeDirectory: home.root }).scanInstalledMcps();
    assert.deepEqual(catalog.servers[0].agents, ['claudeCode', 'codex']);
  } finally {
    home.cleanup();
  }
});

test('stages every selected adapter before writing and rejects Codex SSE', async () => {
  const home = new TestHome();
  try {
    const originalClaude = '{"theme":"dark"}\n';
    home.write('.claude.json', originalClaude);
    home.write('.codex/config.toml', '[mcp_servers.duplicate]\ncommand = "node"\n');
    const codec = new McpConfigurationCodec();
    const duplicate = codec.encode({
      name: 'duplicate',
      connectionType: 'stdio',
      command: 'node',
      arguments: [],
      environment: {},
      url: null
    });
    const applier = new LocalMcpConfigurationApplier({ homeDirectory: home.root });
    await assert.rejects(() => applier.apply(duplicate, ['claudeCode', 'codex']), /already has/);
    assert.equal(home.read('.claude.json'), originalClaude);

    const sse = codec.encode({
      name: 'events',
      connectionType: 'sse',
      command: null,
      arguments: [],
      environment: {},
      url: 'https://example.com/events'
    });
    await assert.rejects(() => applier.apply(sse, ['codex']), /does not support SSE/);
  } finally {
    home.cleanup();
  }
});

/** In-memory operations that fail the second initial commit but allow rollback. */
class FailingFileOperations {
  constructor() {
    this.files = new Map([
      ['/claude', new TextEncoder().encode('claude-original')],
      ['/codex', new TextEncoder().encode('codex-original')]
    ]);
    this.didFail = false;
  }

  async read(filePath) {
    const bytes = this.files.get(filePath);
    return bytes ? { bytes: new Uint8Array(bytes), mode: 0o600 } : null;
  }

  async replaceAtomically(filePath, bytes) {
    if (filePath === '/codex' && !this.didFail) {
      this.didFail = true;
      throw new Error('simulated write failure');
    }
    this.files.set(filePath, new Uint8Array(bytes));
  }

  async remove(filePath) {
    this.files.delete(filePath);
  }

  text(filePath) {
    const bytes = this.files.get(filePath);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }
}

test('restores exact original bytes when a later atomic write fails', async () => {
  const operations = new FailingFileOperations();
  const writer = new McpConfigurationFileWriter(operations);
  const [claudeRead, createdRead, codexRead] = await Promise.all([
    writer.read('/claude'),
    writer.read('/created'),
    writer.read('/codex')
  ]);
  await assert.rejects(() => writer.commit([
    { ...claudeRead, replacementBytes: new TextEncoder().encode('claude-new') },
    { ...createdRead, replacementBytes: new TextEncoder().encode('created-new') },
    { ...codexRead, replacementBytes: new TextEncoder().encode('codex-new') }
  ]), /Previously written files were restored/);
  assert.equal(operations.text('/claude'), 'claude-original');
  assert.equal(operations.text('/created'), null);
  assert.equal(operations.text('/codex'), 'codex-original');
});

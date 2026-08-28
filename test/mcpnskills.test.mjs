import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GitHubRepositoryCoordinate } from '../dist/main/mcpnskills/GitHubRepositoryCoordinate.js';
import { RepositoryCloneCache } from '../dist/main/mcpnskills/RepositoryCloneCache.js';
import { RepositorySkillScanner } from '../dist/main/mcpnskills/RepositorySkillScanner.js';
import {
  LocalSkillCatalogScanner,
  SkillManifestParser
} from '../dist/main/mcpnskills/SkillCatalogScanner.js';
import { SkillDeployer } from '../dist/main/mcpnskills/SkillDeployer.js';
import { SkillFilesystemLayout } from '../dist/main/mcpnskills/SkillFilesystem.js';
import { SkillFolderImporter } from '../dist/main/mcpnskills/SkillFolderImporter.js';

/** Owns an isolated temporary filesystem tree for one test. */
class TestWorkspace {
  constructor() {
    this.root = mkdtempSync(path.join(os.tmpdir(), 'tokiie-test-'));
  }

  resolve(...segments) {
    return path.join(this.root, ...segments);
  }

  write(relativePath, contents) {
    const filePath = this.resolve(relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents);
    return filePath;
  }

  directory(relativePath) {
    const directoryPath = this.resolve(relativePath);
    mkdirSync(directoryPath, { recursive: true });
    return directoryPath;
  }

  cleanup() {
    rmSync(this.root, { recursive: true, force: true });
  }
}

/** Records cache commands while emulating a shallow checkout. */
class RecordingGitRunner {
  constructor() {
    this.calls = [];
  }

  async run(args, options = {}) {
    this.calls.push({ args: [...args], options: { ...options } });
    if (args[0] === 'clone') {
      mkdirSync(path.join(args.at(-1), '.git'), { recursive: true });
    }
    return { stdout: args[0] === 'rev-parse' ? 'commit-sha\n' : '', stderr: '', exitCode: 0 };
  }
}

test('normalizes supported GitHub inputs and rejects extra path segments', () => {
  const supportedInputs = [
    'owner/repository',
    'https://github.com/owner/repository.git',
    'git@github.com:owner/repository.git',
    'github.com/owner/repository/'
  ];
  for (const input of supportedInputs) {
    const coordinate = new GitHubRepositoryCoordinate(input);
    assert.equal(coordinate.source, 'owner/repository');
    assert.equal(coordinate.cloneUrl, 'https://github.com/owner/repository.git');
  }

  // Extra URL path components must not be silently redirected to another checkout.
  for (const input of ['owner/repository/tree/main', 'https://github.com/owner/repository/issues']) {
    assert.throws(() => new GitHubRepositoryCoordinate(input), /owner\/name format/);
  }
  assert.equal(GitHubRepositoryCoordinate.tryParse('github.com.evil/owner/repository'), null);
});

test('parses skill frontmatter scalars and multiline descriptions', () => {
  const parser = new SkillManifestParser();
  const manifest = parser.parse(`\uFEFF\n---\nname: "build-tools"\ndescription: |\n  Build reliable tools.\n  Keep output deterministic.\nversion: 1\n---\n`);
  assert.deepEqual(manifest, {
    skillName: 'build-tools',
    skillDescription: 'Build reliable tools.\nKeep output deterministic.'
  });
  assert.deepEqual(parser.parse('name: missing delimiters'), {
    skillName: null,
    skillDescription: null
  });
});

test('rejects filesystem traversal and preserves Codex path preference', () => {
  const workspace = new TestWorkspace();
  try {
    const layout = new SkillFilesystemLayout({ homeDirectory: workspace.root });
    assert.equal(layout.getRootPath('amis'), workspace.resolve('.amis/skills'));
    assert.throws(() => layout.getSkillPath('amis', '../outside'), /escapes amis root/);
    assert.deepEqual(layout.getAgentSkillPaths('codex', 'sample'), [
      workspace.resolve('.agents/skills/sample'),
      workspace.resolve('.codex/skills/sample')
    ]);
  } finally {
    workspace.cleanup();
  }
});

test('scans and deduplicates installed skills across roots', async () => {
  const workspace = new TestWorkspace();
  try {
    const amisManifest = '---\nname: shared\ndescription: Shared skill\n---\n';
    workspace.write('.amis/skills/shared/SKILL.md', amisManifest);
    workspace.write('.claude/skills/shared/SKILL.md', amisManifest);
    workspace.write('.agents/skills/unique/SKILL.md', '---\nname: unique\ndescription: Unique\n---\n');
    workspace.write('.codex/skills/shared/SKILL.md', '---\nname: shared\ndescription: Different\n---\n');
    workspace.write('.agents/skills/.hidden/SKILL.md', amisManifest);

    const scanner = new LocalSkillCatalogScanner({ homeDirectory: workspace.root });
    const skills = await scanner.scanInstalledSkills();
    assert.equal(skills.length, 3);
    const sharedSkills = skills.filter((skill) => skill.name === 'shared');
    assert.equal(sharedSkills.length, 2);
    assert.equal(sharedSkills[0].hasNameCollision, true);
    assert.equal(sharedSkills[1].hasNameCollision, true);
    const uniqueBadges = skills.find((skill) => skill.name === 'unique').agentBadges;
    assert.equal(uniqueBadges.find((badge) => badge.agent === 'codex').state, 'checked');
  } finally {
    workspace.cleanup();
  }
});

test('uninstalls a real agent directory the app never installed', async () => {
  const workspace = new TestWorkspace();
  try {
    // A skill authored directly in the Claude root: discovered by the scanner,
    // never copied or linked by the app.
    workspace.write('.claude/skills/legacy/SKILL.md', '---\nname: legacy\ndescription: Legacy\n---\n');

    const deployer = new SkillDeployer({ homeDirectory: workspace.root });
    const scanner = new LocalSkillCatalogScanner({ homeDirectory: workspace.root });
    const [legacySkill] = await scanner.scanInstalledSkills();
    assert.equal(legacySkill.name, 'legacy');

    const remainingSkills = await deployer.uninstallSkill(legacySkill);
    assert.equal(existsSync(workspace.resolve('.claude/skills/legacy')), false);
    assert.deepEqual(remainingSkills, []);
  } finally {
    workspace.cleanup();
  }
});

test('uninstalls links and canonical content without touching a same-name skill', async () => {
  const workspace = new TestWorkspace();
  try {
    // The app-managed card: canonical content plus a link from the Claude root.
    workspace.write('.amis/skills/shared/SKILL.md', '---\nname: shared\ndescription: Managed\n---\n');
    workspace.directory('.claude/skills');
    symlinkSync(workspace.resolve('.amis/skills/shared'), workspace.resolve('.claude/skills/shared'), 'dir');
    // A different card that happens to carry the same name.
    workspace.write('.codex/skills/shared/SKILL.md', '---\nname: shared\ndescription: Unrelated\n---\n');

    const deployer = new SkillDeployer({ homeDirectory: workspace.root });
    const scanner = new LocalSkillCatalogScanner({ homeDirectory: workspace.root });
    const skills = await scanner.scanInstalledSkills();
    const managedSkill = skills.find((skill) => skill.summary === 'Managed');

    const remainingSkills = await deployer.uninstallSkill(managedSkill);
    assert.equal(existsSync(workspace.resolve('.amis/skills/shared')), false);
    assert.equal(existsSync(workspace.resolve('.claude/skills/shared')), false);
    // The unrelated card owns its own directory and must survive.
    assert.equal(existsSync(workspace.resolve('.codex/skills/shared')), true);
    assert.deepEqual(
      remainingSkills.map((skill) => skill.summary),
      ['Unrelated']
    );
  } finally {
    workspace.cleanup();
  }
});

test('scans repository skill namespaces while ignoring generated directories', () => {
  const workspace = new TestWorkspace();
  try {
    const checkout = workspace.directory('checkout');
    workspace.write('checkout/skills/alpha/SKILL.md', '---\nname: alpha\ndescription: Alpha\n---\n');
    workspace.write('checkout/skills/team/beta/SKILL.md', '---\nname: beta\ndescription: Beta\n---\n');
    workspace.write('checkout/skills/node_modules/ignored/SKILL.md', '---\nname: ignored\n---\n');
    workspace.write('checkout/skills/cache.egg-info/ignored/SKILL.md', '---\nname: ignored-egg\n---\n');
    workspace.write('checkout/skills/cmake-build-debug/ignored/SKILL.md', '---\nname: ignored-cmake\n---\n');
    workspace.write('checkout/skills/tmp/ignored/SKILL.md', '---\nname: ignored-tmp\n---\n');
    const repository = new RepositorySkillScanner().scan(checkout, 'owner/repository', 'abc');
    assert.equal(repository.commit, 'abc');
    assert.deepEqual(repository.skills.map((skill) => skill.relativePath), [
      'skills/alpha',
      'skills/team/beta'
    ]);
    assert.equal(repository.skills[0].summary, 'Alpha');
  } finally {
    workspace.cleanup();
  }
});

test('imports skills with explicit conflict strategies and rejects source symlinks', () => {
  const workspace = new TestWorkspace();
  try {
    const source = workspace.directory('source');
    workspace.write('source/SKILL.md', '---\nname: importer\ndescription: source\n---\n');
    const importer = new SkillFolderImporter({ canonicalRoot: workspace.resolve('canonical') });
    const installed = importer.importSkill(source, 'importer', 'replace');
    assert.equal(installed.status, 'installed');
    assert.equal(path.basename(installed.destinationPath), 'importer');
    assert.equal(importer.importSkill(source, 'importer', 'skip').status, 'skipped');
    assert.equal(path.basename(importer.importSkill(source, 'importer', 'keepBoth').destinationPath), 'importer-2');
    assert.equal(importer.importSkill(source, 'importer', 'reportConflict').status, 'conflict');

    const linkedSource = workspace.resolve('linked-source');
    symlinkSync(source, linkedSource, 'dir');
    assert.throws(() => importer.importSkill(linkedSource, 'linked', 'replace'), /cannot be a symbolic link/);
    assert.throws(() => importer.importSkill(source, '../escape', 'replace'), /Invalid skill name/);
  } finally {
    workspace.cleanup();
  }
});

test('refreshes an existing safe checkout with the requested branch', async () => {
  const workspace = new TestWorkspace();
  try {
    const cacheRoot = workspace.directory('cache');
    workspace.directory('cache/owner/repository/.git');
    const runner = new RecordingGitRunner();
    const cache = new RepositoryCloneCache({ cacheRoot, runner });
    const result = await cache.synchronizeCheckout('owner/repository', 'release');
    assert.equal(result.wasRefreshed, true);
    assert.equal(result.commit, 'commit-sha');
    assert.deepEqual(runner.calls.map((call) => call.args), [
      ['rev-parse', 'HEAD'],
      ['fetch', '--depth', '1', 'origin', 'release'],
      ['reset', '--hard', 'FETCH_HEAD'],
      ['rev-parse', 'HEAD'],
      ['rev-parse', 'HEAD']
    ]);
  } finally {
    workspace.cleanup();
  }
});

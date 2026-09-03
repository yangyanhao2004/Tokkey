import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CachedRepositoryCatalog } from '../dist/main/mcpnskills/CachedRepositoryCatalog.js';
import { DiscoverRepositories } from '../dist/main/mcpnskills/DiscoverRepositories.js';
import { GitHubRepositoryCoordinate } from '../dist/main/mcpnskills/GitHubRepositoryCoordinate.js';
import { RepositoryCloneCache } from '../dist/main/mcpnskills/RepositoryCloneCache.js';
import { SkillInstaller } from '../dist/main/mcpnskills/SkillInstaller.js';
import { SkillDetailsReader } from '../dist/main/mcpnskills/SkillDetailsReader.js';
import { RepositorySkillScanner } from '../dist/main/mcpnskills/RepositorySkillScanner.js';
import {
  LocalSkillCatalogScanner,
  SkillManifestParser
} from '../dist/main/mcpnskills/SkillCatalogScanner.js';
import { SkillDeployer } from '../dist/main/mcpnskills/SkillDeployer.js';
import { SkillFilesystemLayout } from '../dist/main/mcpnskills/SkillFilesystem.js';
import { SkillFolderImporter } from '../dist/main/mcpnskills/SkillFolderImporter.js';
import { SkillFolderSelector } from '../dist/main/mcpnskills/SkillFolderSelector.js';
import { SkillUploadService } from '../dist/main/mcpnskills/SkillUploadService.js';

/** Owns an isolated temporary filesystem tree for one test. */
class TestWorkspace {
  constructor() {
    this.root = mkdtempSync(path.join(os.tmpdir(), 'tokkey-test-'));
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

test('reads installed and cached SKILL.md bodies with catalog-owned locations', async () => {
  const workspace = new TestWorkspace();
  try {
    const manifest = '---\nname: inspectable\ndescription: Read me\n---\n# Instructions\n\nUse the tool safely.\n';
    workspace.write('.agents/skills/inspectable/SKILL.md', manifest);
    workspace.write('cache/owner/repository/skills/inspectable/SKILL.md', manifest);
    const [installedSkill] = await new LocalSkillCatalogScanner({
      homeDirectory: workspace.root
    }).scanInstalledSkills();
    const reader = new SkillDetailsReader();

    const installedDetails = await reader.readInstalledSkill(installedSkill);
    assert.equal(installedDetails.content, '# Instructions\n\nUse the tool safely.');
    assert.deepEqual(installedDetails.locations, [{
      label: 'Agents',
      path: workspace.resolve('.agents/skills/inspectable')
    }]);

    // Cached cards carry their repository identity rather than an agent root.
    const cachedDetails = await reader.readRepositorySkill({
      id: 'owner/repository:skills/inspectable',
      name: 'inspectable',
      summary: 'Read me',
      description: 'Read me',
      source: 'owner/repository',
      relativePath: 'skills/inspectable',
      absolutePath: workspace.resolve('cache/owner/repository/skills/inspectable'),
      isInstalled: false,
      installedSkillId: null,
      agentBadges: []
    });
    assert.equal(cachedDetails.content, installedDetails.content);
    assert.equal(cachedDetails.locations[0].label, 'owner/repository');
  } finally {
    workspace.cleanup();
  }
});

test('reads an installed manifest link whose target belongs to the same installed catalog', async () => {
  const workspace = new TestWorkspace();
  try {
    const sharedManifestPath = workspace.write(
      '.claude/skills/shared/SKILL.md',
      '---\nname: shared\ndescription: Shared source\n---\n# Shared instructions\n'
    );
    const commandPath = workspace.directory('.amis/skills/shared-command');
    symlinkSync(sharedManifestPath, path.join(commandPath, 'SKILL.md'));
    const installedCatalog = await new LocalSkillCatalogScanner({
      homeDirectory: workspace.root
    }).scanInstalledSkills();
    const command = installedCatalog.find((skill) => skill.name === 'shared-command');
    assert.ok(command);

    const details = await new SkillDetailsReader().readInstalledSkill(command, installedCatalog);
    assert.equal(details.content, '# Shared instructions');
  } finally {
    workspace.cleanup();
  }
});

test('rejects a SKILL.md link whose target is outside every catalog skill', async () => {
  const workspace = new TestWorkspace();
  try {
    const skillPath = workspace.directory('cache/owner/repository/skills/linked');
    const externalManifestPath = workspace.write('private/SKILL.md', 'private content');
    symlinkSync(externalManifestPath, path.join(skillPath, 'SKILL.md'));
    const reader = new SkillDetailsReader();

    await assert.rejects(
      () => reader.readRepositorySkill({
        id: 'owner/repository:skills/linked',
        name: 'linked',
        summary: null,
        description: null,
        source: 'owner/repository',
        relativePath: 'skills/linked',
        absolutePath: skillPath,
        isInstalled: false,
        installedSkillId: null,
        agentBadges: []
      }),
      /escapes the cataloged skill directories/
    );
  } finally {
    workspace.cleanup();
  }
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

/** Answers the folder panel with a scripted queue instead of opening one. */
class ScriptedDirectoryChooser {
  constructor(folderPaths) {
    this.folderPaths = [...folderPaths];
  }

  async chooseDirectory() {
    return this.folderPaths.shift() ?? null;
  }
}

/** Builds an upload service whose roots all live inside one temporary tree. */
function makeUploadService(workspace, folderPaths) {
  const installedCatalog = new LocalSkillCatalogScanner({ homeDirectory: workspace.resolve('home') });
  return new SkillUploadService({
    installedCatalog,
    importer: new SkillFolderImporter({ filesystem: installedCatalog.getFilesystem() }),
    selector: new SkillFolderSelector({ chooser: new ScriptedDirectoryChooser(folderPaths) })
  });
}

test('accepts only chosen folders that carry a SKILL.md', async () => {
  const workspace = new TestWorkspace();
  try {
    const plainFolder = workspace.directory('plain');
    workspace.write('skill/SKILL.md', '---\nname: chosen\n---\n');
    const selector = new SkillFolderSelector({
      chooser: new ScriptedDirectoryChooser([null, plainFolder, workspace.resolve('skill')])
    });
    assert.equal((await selector.selectSkillFolder()).status, 'cancelled');
    assert.equal((await selector.selectSkillFolder()).status, 'notASkillFolder');

    const selected = await selector.selectSkillFolder();
    assert.equal(selected.status, 'selected');
    assert.equal(selected.folderName, 'skill');
  } finally {
    workspace.cleanup();
  }
});

test('uploads a chosen folder and refuses the identical folder afterwards', async () => {
  const workspace = new TestWorkspace();
  try {
    const manifest = '---\nname: uploaded\ndescription: from finder\n---\n';
    workspace.write('source/uploaded/SKILL.md', manifest);
    const sourcePath = workspace.resolve('source/uploaded');
    const service = makeUploadService(workspace, [sourcePath, sourcePath, workspace.resolve('source')]);

    const installed = await service.uploadSkillFolder();
    assert.equal(installed.status, 'installed');
    assert.equal(path.basename(installed.destinationPath), 'uploaded');
    assert.equal(installed.installedSkills.length, 1);
    assert.equal(existsSync(workspace.resolve('home/.amis/skills/uploaded/SKILL.md')), true);

    // Same folder name and same SKILL.md bytes: nothing is copied a second time.
    const repeated = await service.uploadSkillFolder();
    assert.equal(repeated.status, 'alreadyInstalled');
    assert.equal(repeated.pendingUploadId, null);

    // A folder with no manifest of its own never reaches the importer.
    assert.equal((await service.uploadSkillFolder()).status, 'notASkillFolder');
  } finally {
    workspace.cleanup();
  }
});

test('reports a same-name conflict and finishes it with the collected choice', async () => {
  const workspace = new TestWorkspace();
  try {
    workspace.write('home/.amis/skills/uploaded/SKILL.md', '---\nname: uploaded\ndescription: installed\n---\n');
    workspace.write('source/uploaded/SKILL.md', '---\nname: uploaded\ndescription: newer\n---\n');
    const sourcePath = workspace.resolve('source/uploaded');
    const service = makeUploadService(workspace, [sourcePath, sourcePath, sourcePath]);

    // Same name with different bytes is an update, so it becomes a prompt.
    const keepBothConflict = await service.uploadSkillFolder();
    assert.equal(keepBothConflict.status, 'conflict');
    assert.equal(path.basename(keepBothConflict.conflictPath), 'uploaded');
    const keptBoth = await service.resolveConflict(keepBothConflict.pendingUploadId, 'keepBoth');
    assert.equal(keptBoth.status, 'keptBoth');
    assert.equal(path.basename(keptBoth.destinationPath), 'uploaded-2');

    const skippedConflict = await service.uploadSkillFolder();
    assert.equal((await service.resolveConflict(skippedConflict.pendingUploadId, 'skip')).status, 'skipped');

    const replacedConflict = await service.uploadSkillFolder();
    const replaced = await service.resolveConflict(replacedConflict.pendingUploadId, 'replace');
    assert.equal(replaced.status, 'replaced');
    assert.match(
      readFileSync(workspace.resolve('home/.amis/skills/uploaded/SKILL.md'), 'utf8'),
      /newer/
    );
    // A spent token cannot be answered twice.
    await assert.rejects(
      () => service.resolveConflict(replacedConflict.pendingUploadId, 'replace'),
      /No skill upload is waiting/
    );
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

/** Builds the repository install stack over one temporary tree. */
function makeRepositoryInstaller(workspace) {
  const installedCatalog = new LocalSkillCatalogScanner({ homeDirectory: workspace.resolve('home') });
  const catalog = new CachedRepositoryCatalog({
    cacheRoot: workspace.resolve('cache'),
    installedCatalog
  });
  const installer = new SkillInstaller({
    catalog,
    installedCatalog,
    importer: new SkillFolderImporter({ filesystem: installedCatalog.getFilesystem() }),
    deployer: new SkillDeployer({ homeDirectory: workspace.resolve('home') })
  });
  return { catalog, installer };
}

test('installs a card from a repository root and from a nested skills folder', async () => {
  const workspace = new TestWorkspace();
  try {
    // A repository whose own root is the skill folder: its card has no path
    // below the checkout, which is the shape the install guard used to reject.
    workspace.write('cache/acme/root-skill/SKILL.md', '---\nname: root-skill\ndescription: at the root\n---\n');
    workspace.write('cache/acme/bundle/skills/nested/SKILL.md', '---\nname: nested\ndescription: below skills\n---\n');
    const { catalog, installer } = makeRepositoryInstaller(workspace);

    const rootCard = (await catalog.listSkillCards()).find((card) => card.name === 'root-skill');
    const rootResult = await installer.installCard(rootCard, ['claudeCode'], 'reportConflict');
    assert.equal(rootResult.status, 'installed');
    assert.equal(existsSync(workspace.resolve('home/.amis/skills/root-skill/SKILL.md')), true);
    assert.equal(existsSync(workspace.resolve('home/.claude/skills/root-skill')), true);
    assert.equal(existsSync(workspace.resolve('home/.codex/skills/root-skill')), false);

    const nestedCard = (await catalog.listSkillCards()).find((card) => card.name === 'nested');
    assert.equal(nestedCard.relativePath, 'skills/nested');
    assert.equal((await installer.installCard(nestedCard, ['codex'], 'reportConflict')).status, 'installed');
    assert.equal(existsSync(workspace.resolve('home/.codex/skills/nested')), true);

    // The cache is re-read the way the Repos tab reads it: an installed card
    // reports the agents that can load it, a cached-only one reports none.
    const cards = await catalog.listSkillCards();
    const installedCard = cards.find((card) => card.name === 'root-skill');
    assert.equal(installedCard.isInstalled, true);
    assert.equal(
      installedCard.agentBadges.find((badge) => badge.agent === 'claudeCode').state,
      'checked'
    );
    assert.equal(installedCard.agentBadges.find((badge) => badge.agent === 'codex').state, 'unchecked');
  } finally {
    workspace.cleanup();
  }
});

test('rejects an install request whose path is not a card in the cache', async () => {
  const workspace = new TestWorkspace();
  try {
    workspace.write('cache/acme/bundle/skills/nested/SKILL.md', '---\nname: nested\n---\n');
    const { installer } = makeRepositoryInstaller(workspace);

    await assert.rejects(
      () => installer.install({
        source: 'acme/bundle',
        relativePath: 'nested/../../../../escape',
        enabledAgents: [],
        conflictStrategy: 'reportConflict'
      }),
      /escapes checkout/
    );
    await assert.rejects(
      () => installer.install({
        source: 'acme/bundle',
        relativePath: 'absent',
        enabledAgents: [],
        conflictStrategy: 'reportConflict'
      }),
      /was not found/
    );
  } finally {
    workspace.cleanup();
  }
});

/** Emulates a clone that lands one skill folder inside the fresh checkout. */
class SeedingGitRunner extends RecordingGitRunner {
  async run(args, options = {}) {
    const result = await super.run(args, options);
    if (args[0] === 'clone') {
      const checkoutPath = args.at(-1);
      mkdirSync(path.join(checkoutPath, 'skills', 'linting'), { recursive: true });
      writeFileSync(
        path.join(checkoutPath, 'skills', 'linting', 'SKILL.md'),
        '---\nname: linting\ndescription: keeps the tree tidy\n---\n'
      );
    }
    return result;
  }
}

test('downloads a repository into the cache and reports the skills it added', async () => {
  const workspace = new TestWorkspace();
  try {
    const runner = new SeedingGitRunner();
    const cache = new RepositoryCloneCache({ cacheRoot: workspace.resolve('cache'), runner });
    const installedCatalog = new LocalSkillCatalogScanner({ homeDirectory: workspace.resolve('home') });
    const catalog = new CachedRepositoryCatalog({ cache, installedCatalog });
    const repositories = new DiscoverRepositories({
      cache,
      catalog,
      installer: new SkillInstaller({
        catalog,
        installedCatalog,
        importer: new SkillFolderImporter({ filesystem: installedCatalog.getFilesystem() }),
        deployer: new SkillDeployer({ homeDirectory: workspace.resolve('home') })
      })
    });

    // The dialog hands over whatever was pasted, so a full URL must reach the
    // same checkout an owner/name would.
    const result = await repositories.addRepository('https://github.com/acme/bundle', 'release');
    assert.equal(result.wasRefreshed, false);
    assert.equal(result.newSkillCount, 1);
    assert.deepEqual(result.repository.skills.map((skill) => skill.name), ['linting']);
    assert.match(result.notice, /^acme\/bundle downloaded/);
    assert.deepEqual(runner.calls[0].args, [
      'clone',
      '--depth',
      '1',
      '--branch',
      'release',
      'https://github.com/acme/bundle.git',
      workspace.resolve('cache/acme/bundle')
    ]);

    // The tab redraws by re-reading the cache, so the download has to be there.
    const cached = await repositories.listCached();
    assert.deepEqual(cached.map((repository) => repository.coordinate.source), ['acme/bundle']);
    assert.equal(cached[0].skills[0].isInstalled, false);

    // Adding the same repository again refreshes it rather than counting its
    // skills as new ones.
    const refreshed = await repositories.addRepository('acme/bundle', '');
    assert.equal(refreshed.wasRefreshed, true);
    assert.equal(refreshed.newSkillCount, 0);
    assert.match(refreshed.notice, /already downloaded/);
  } finally {
    workspace.cleanup();
  }
});

test('an uninstalled agent removes its own skill root but not the shared ones', async () => {
  const workspace = new TestWorkspace();
  try {
    workspace.write('.amis/skills/owned/SKILL.md', '---\nname: owned\ndescription: Tokkey\n---\n');
    workspace.write('.claude/skills/claude-only/SKILL.md', '---\nname: claude-only\ndescription: Claude\n---\n');
    workspace.write('.codex/skills/codex-only/SKILL.md', '---\nname: codex-only\ndescription: Codex\n---\n');
    workspace.write('.agents/skills/shared/SKILL.md', '---\nname: shared\ndescription: Shared\n---\n');

    const scanner = new LocalSkillCatalogScanner({
      homeDirectory: workspace.root,
      agentGate: { installedAgents: async () => ['claudeCode'] }
    });
    const skills = await scanner.scanInstalledSkills();

    // ~/.codex is Codex's own root and goes with it; ~/.agents and ~/.amis are
    // nobody's to own, so what lives there stays available to Claude Code.
    assert.deepEqual(skills.map((skill) => skill.name).sort(), ['claude-only', 'owned', 'shared']);
  } finally {
    workspace.cleanup();
  }
});

test('a failed detection walks every root rather than blanking the catalog', async () => {
  const workspace = new TestWorkspace();
  try {
    workspace.write('.codex/skills/codex-only/SKILL.md', '---\nname: codex-only\ndescription: Codex\n---\n');

    const scanner = new LocalSkillCatalogScanner({
      homeDirectory: workspace.root,
      agentGate: { installedAgents: async () => { throw new Error('probe timed out'); } }
    });

    assert.deepEqual((await scanner.scanInstalledSkills()).map((skill) => skill.name), ['codex-only']);
  } finally {
    workspace.cleanup();
  }
});

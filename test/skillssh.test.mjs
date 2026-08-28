import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SkillsShClient } from '../dist/main/mcpnskills/SkillsShClient.js';
import { SiteSkillDownloader } from '../dist/main/mcpnskills/SiteSkillDownloader.js';
import { CachedInstalledSkillMatcher } from '../dist/main/mcpnskills/CachedInstalledSkillMatcher.js';
import { DiscoverSkillsService } from '../dist/main/mcpnskills/DiscoverSkillsService.js';
import { LocalSkillCatalogScanner } from '../dist/main/mcpnskills/SkillCatalogScanner.js';
import { SkillFilesystemLayout } from '../dist/main/mcpnskills/SkillFilesystem.js';

class TestWorkspace {
  constructor() {
    this.root = mkdtempSync(path.join(os.tmpdir(), 'tokiie-directory-test-'));
  }

  resolve(...segments) {
    return path.join(this.root, ...segments);
  }

  cleanup() {
    rmSync(this.root, { recursive: true, force: true });
  }
}

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 503 ? 'Unavailable' : '',
    async json() {
      if (payload instanceof Error) {
        throw payload;
      }
      return payload;
    }
  };
}

test('decodes skills.sh listings, applies slash-first source classification, and retries 5xx', async () => {
  const calls = [];
  const delays = [];
  const fetcher = async (url) => {
    calls.push(url);
    if (calls.length < 3) {
      return response({}, 503);
    }
    return response({
      skills: [{ source: 'vercel/next.js', skillId: 'find-skills', name: 'find-skills' }],
      total: 201,
      hasMore: true,
      page: 0
    });
  };
  const client = new SkillsShClient({
    fetcher,
    sleep: async (delay) => delays.push(delay),
    random: () => 0.5
  });

  const page = await client.fetchPage(0);
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [500, 1000]);
  assert.equal(page.skills[0].sourceKind, 'repository');
  assert.equal(page.skills[0].installs, 0);
  assert.equal(page.skills[0].isOfficial, false);
  assert.equal(page.skills[0].id, 'vercel/next.js/find-skills');
  assert.equal(page.skills[0].url, 'https://www.skills.sh/vercel/next.js/find-skills');
});

test('does not retry invalid JSON or rejected non-retryable status', async () => {
  let calls = 0;
  const client = new SkillsShClient({
    fetcher: async () => {
      calls += 1;
      return response(new SyntaxError('bad json'));
    },
    sleep: async () => undefined
  });
  await assert.rejects(() => client.fetchPage(3), /invalid JSON/);
  assert.equal(calls, 1);

  calls = 0;
  const rejectedClient = new SkillsShClient({
    fetcher: async () => {
      calls += 1;
      return response({}, 404);
    }
  });
  await assert.rejects(() => rejectedClient.fetchPage(3), /rejected - retrying will not help/);
  assert.equal(calls, 1);
});

test('slices ten UI pages from one cached API page and keeps search results in memory', async () => {
  const apiCalls = [];
  const searchCalls = [];
  const listings = Array.from({ length: 200 }, (_, index) => ({
    id: `owner/repo/skill-${index}`,
    source: 'owner/repo',
    skillId: `skill-${index}`,
    name: `skill-${index}`,
    installs: index,
    isOfficial: false,
    sourceKind: 'repository',
    url: `https://www.skills.sh/owner/repo/skill-${index}`
  }));
  const service = new DiscoverSkillsService({
    skillsShClient: {
      async fetchPage(page) {
        apiCalls.push(page);
        return { skills: listings, total: 401, hasMore: true, page };
      },
      async search(query) {
        searchCalls.push(query);
        return listings.slice(0, 25);
      }
    }
  });

  const pageOne = await service.fetchSkillsPage(1);
  const pageNine = await service.fetchSkillsPage(9);
  const pageTen = await service.fetchSkillsPage(10);
  assert.equal(pageOne.skills[0].skillId, 'skill-20');
  assert.equal(pageNine.skills[0].skillId, 'skill-180');
  assert.equal(pageTen.skills[0].skillId, 'skill-0');
  assert.deepEqual(apiCalls, [0, 1]);

  const searchPageZero = await service.fetchSearchPage('tools', 0);
  const searchPageOne = await service.fetchSearchPage(' tools ', 1);
  assert.deepEqual(searchCalls, ['tools']);
  assert.equal(searchPageZero.skills.length, 20);
  assert.equal(searchPageZero.total, 25);
  assert.equal(searchPageZero.hasMore, true);
  assert.equal(searchPageOne.skills.length, 5);
  assert.equal(searchPageOne.hasMore, false);
});

test('downloads a site skill once and publishes it atomically', async () => {
  const workspace = new TestWorkspace();
  try {
    const calls = [];
    const client = {
      async fetchJson(requestPath) {
        calls.push(requestPath);
        return {
          skills: [{ name: 'mail-tools', description: 'Mail helpers', files: ['SKILL.md', 'rules/main.md'] }]
        };
      },
      async fetchBytes(requestPath) {
        calls.push(requestPath);
        return new TextEncoder().encode(requestPath.endsWith('SKILL.md') ? '---\nname: mail-tools\n---\n' : 'rule');
      }
    };
    const downloader = new SiteSkillDownloader({
      cacheRoot: workspace.resolve('cache'),
      client,
      createId: () => 'fixed-id'
    });
    const listing = {
      id: 'agent.qq.com/mail-tools',
      source: 'agent.qq.com',
      skillId: 'mail-tools',
      name: 'mail-tools',
      installs: 1,
      isOfficial: false,
      sourceKind: 'site',
      url: 'https://www.skills.sh/site/agent.qq.com/mail-tools'
    };
    const first = await downloader.downloadSkill(listing);
    assert.equal(readFileSync(path.join(first.skillPath, 'rules/main.md'), 'utf8'), 'rule');
    const callCount = calls.length;
    const second = await downloader.downloadSkill(listing);
    assert.equal(second.skillPath, first.skillPath);
    assert.equal(calls.length, callCount);
    assert.equal(downloader.validateIndex({ skills: [{ name: 'a', description: 'A', files: ['SKILL.md'] }] }).skills.length, 1);
    assert.throws(() => downloader.validateIndex({ skills: [{ name: 'a', description: 'A', files: ['../SKILL.md'] }] }), /Invalid/);
  } finally {
    workspace.cleanup();
  }
});

test('matches cached skills only when folder name and SKILL.md bytes agree', () => {
  const workspace = new TestWorkspace();
  try {
    const matcher = new CachedInstalledSkillMatcher();
    const cachedPath = workspace.resolve('cache', 'same');
    const installedPath = workspace.resolve('installed', 'same');
    const differentNamePath = workspace.resolve('installed', 'other');
    const manifest = '---\nname: metadata-name\n---\n';
    mkdirSync(cachedPath, { recursive: true });
    mkdirSync(installedPath, { recursive: true });
    mkdirSync(differentNamePath, { recursive: true });
    writeFileSync(path.join(cachedPath, 'SKILL.md'), manifest);
    writeFileSync(path.join(installedPath, 'SKILL.md'), manifest);
    writeFileSync(path.join(differentNamePath, 'SKILL.md'), manifest);
    const installation = (absolutePath) => ({ root: 'amis', relativePath: path.basename(absolutePath), absolutePath, resolvedPath: absolutePath, isSymlink: false, isCanonicalLocation: true });
    const installedSkills = [
      { id: 'same', name: 'same', summary: null, primaryInstallation: installation(installedPath), additionalInstallations: [], installations: [installation(installedPath)], sourcePath: installedPath, hasNameCollision: false, agentBadges: [] },
      { id: 'other', name: 'other', summary: null, primaryInstallation: installation(differentNamePath), additionalInstallations: [], installations: [installation(differentNamePath)], sourcePath: differentNamePath, hasNameCollision: false, agentBadges: [] }
    ];
    assert.equal(matcher.findMatch(cachedPath, installedSkills).id, 'same');
  } finally {
    workspace.cleanup();
  }
});

test('installs a resolved listing and reconciles a duplicate without copying again', async () => {
  const workspace = new TestWorkspace();
  try {
    const sourcePath = workspace.resolve('source', 'review-tools');
    mkdirSync(sourcePath, { recursive: true });
    writeFileSync(path.join(sourcePath, 'SKILL.md'), '---\nname: review-tools\ndescription: Review\n---\n');
    const filesystem = new SkillFilesystemLayout({ homeDirectory: workspace.root });
    const scanner = new LocalSkillCatalogScanner({ filesystem });
    const resolver = {
      async resolveSkill() {
        return { source: 'owner/repo', skillId: 'review-tools', sourceKind: 'repository', skillPath: sourcePath, relativePath: 'skills/review-tools', commit: 'abc' };
      }
    };
    const listing = {
      id: 'owner/repo/review-tools',
      source: 'owner/repo',
      skillId: 'review-tools',
      name: 'review-tools',
      installs: 1,
      isOfficial: false,
      sourceKind: 'repository',
      url: 'https://www.skills.sh/owner/repo/review-tools'
    };
    const service = new DiscoverSkillsService({ installedCatalog: scanner, skillSourceResolver: resolver });
    const installed = await service.installListing(listing, ['claudeCode'], 'reportConflict');
    assert.equal(installed.status, 'installed');
    assert.equal(readFileSync(path.join(filesystem.getCanonicalSkillPath('review-tools'), 'SKILL.md'), 'utf8').includes('Review'), true);
    assert.equal((await scanner.scanInstalledSkills())[0].agentBadges.find((badge) => badge.agent === 'claudeCode').state, 'checked');

    const alreadyInstalled = await service.installListing(listing, ['codex'], 'reportConflict');
    assert.equal(alreadyInstalled.status, 'alreadyInstalled');
    assert.equal((await service.getSkillCardState(listing)).installedSkill.name, 'review-tools');
    const finalSkill = (await scanner.scanInstalledSkills()).find((skill) => skill.name === 'review-tools');
    assert.equal(finalSkill.agentBadges.find((badge) => badge.agent === 'codex').state, 'checked');
    assert.equal(finalSkill.agentBadges.find((badge) => badge.agent === 'claudeCode').state, 'unchecked');

    // One page of cards is resolved in a single pass, and only what is actually
    // installed comes back with a skill attached.
    const cardStates = await service.getSkillCardStates([
      listing,
      { ...listing, id: 'owner/repo/other', skillId: 'other', name: 'other' }
    ]);
    assert.equal(cardStates.length, 2);
    assert.equal(cardStates[0].installedSkill.name, 'review-tools');
    assert.equal(cardStates[1].installedSkill, null);
  } finally {
    workspace.cleanup();
  }
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseFrontmatter, globToRegExp, addedLines, routeReview, loadAgents } from '../review-router.js';

const TEMPLATES = join(process.cwd(), 'agents');

describe('review-router: frontmatter + glob', () => {
  it('parses nested triggers, quoted regex lists and scalars', () => {
    const fm = parseFrontmatter(`---
name: x-reviewer
description: Does x (isolated context)
tools: Read, Grep
tier: 1
tags: ['a', "b"]
triggers:
  always: false
  paths: ['**/migrations/**', '**/*.sql']
  content: ['ALTER TABLE', '\\bmigration\\b', 'it''s']
---
body`);
    expect(fm.name).toBe('x-reviewer');
    expect(fm.tier).toBe(1);
    expect(fm.tags).toEqual(['a', 'b']);
    const t = fm.triggers as any;
    expect(t.always).toBe(false);
    expect(t.paths).toEqual(['**/migrations/**', '**/*.sql']);
    expect(t.content).toEqual(['ALTER TABLE', '\\bmigration\\b', "it's"]);
  });

  it('globs match repo-relative paths', () => {
    expect(globToRegExp('**/migrations/**').test('db/migrations/001.sql')).toBe(true);
    expect(globToRegExp('**/*.sql').test('a/b/c.sql')).toBe(true);
    expect(globToRegExp('**/*.sql').test('a/b/c.sqlx')).toBe(false);
    expect(globToRegExp('**/index.ts').test('src/index.ts')).toBe(true);
    expect(globToRegExp('**/index.ts').test('index.ts')).toBe(true);
    expect(globToRegExp('**/.env*').test('.env.local')).toBe(true);
    expect(globToRegExp('**/api/**').test('src/api/users.ts')).toBe(true);
    expect(globToRegExp('**/api/**').test('src/apix/users.ts')).toBe(false);
  });

  it('addedLines keeps only + lines without headers', () => {
    expect(addedLines('--- a\n+++ b\n@@\n-old\n+new\n context\n+more')).toEqual(['new', 'more']);
  });

  it('every shipped agent has valid frontmatter, output contract and unique name', async () => {
    const { agents } = await loadAgents('/nonexistent-project', TEMPLATES);
    expect(agents.length).toBeGreaterThanOrEqual(38);
    const names = new Set<string>();
    for (const a of agents) {
      expect(names.has(a.name)).toBe(false); names.add(a.name);
      expect(a.tier).toBeLessThanOrEqual(5);
      const md = await fs.readFile(a.file, 'utf-8');
      expect(md).toContain('## BLOCK');
      expect(md).toContain('## PASSED');
      expect(md).toMatch(/tools: Read, Grep, Glob, Bash/); // read-only lens
      if (a.tier === 0) expect(a.triggers.always).toBe(true);
      else expect((a.triggers.paths?.length ?? 0) + (a.triggers.content?.length ?? 0) + (a.triggers.langs?.length ?? 0)).toBeGreaterThan(0);
      for (const pat of a.triggers.content ?? []) expect(() => new RegExp(pat, 'i')).not.toThrow();
    }
  });
});

describe('review-router: routing', () => {
  let root: string;
  beforeEach(async () => {
    root = join(tmpdir(), `swmcp-route-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    await fs.mkdir(join(root, '.spec-workflow'), { recursive: true });
    await fs.writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { react: '1', openai: '1' } }));
    await fs.writeFile(join(root, 'tsconfig.json'), '{}');
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  const route = (over: any) => routeReview({ projectPath: root, ...over }, TEMPLATES);

  it('tier 0 always; tier 1 by path / content / profile; reasons are explicit', async () => {
    const r = await route({
      changedFiles: ['src/api/users.ts', 'db/migrations/002_add.sql', 'src/pages/Login.tsx'],
      diffText: '+++ b/x\n+ALTER TABLE users ADD COLUMN x;\n+await Promise.all(jobs)\n+const key = process.env.API_KEY\n',
      full: true,
    });
    const names = r.selected.map(s => s.name);
    for (const t0 of ['security-reviewer', 'logic-reviewer', 'performance-reviewer', 'api-reviewer', 'test-adequacy-judge', 'spec-drift-detector']) expect(names).toContain(t0);
    expect(names).toContain('data-migration-reviewer');
    expect(names).toContain('concurrency-reviewer');
    expect(names).toContain('config-secrets-reviewer');
    expect(names).toContain('accessibility-reviewer');
    expect(names).toContain('cost-reviewer'); // profile: openai dep
    expect(names).not.toContain('i18n-reviewer');
    const dm = r.selected.find(s => s.name === 'data-migration-reviewer')!;
    expect(dm.reasons.join(' ')).toMatch(/path db\/migrations|content/);
    expect(r.profile.languages).toContain('typescript');
    expect(r.profile.hasLlmSdk).toBe(true);
    expect(r.profile.hasUi).toBe(true);
  });

  it('caps at maxAgents, keeps tier 0 first, and reports the overflow', async () => {
    const r = await route({ changedFiles: ['db/migrations/1.sql', 'src/pages/A.tsx', 'package.json'], diffText: '+ALTER TABLE a\n+await x\n+process.env.Y\n+console.log("hi")\n', maxAgents: 7 });
    expect(r.selected).toHaveLength(7);
    expect(r.selected.slice(0, 6).every(s => s.tier === 0)).toBe(true);
    expect(r.skipped.some(s => /over maxAgents/.test(s.why))).toBe(true);
  });

  it('docs-only diff → fast path (spec-drift + ux-copy only)', async () => {
    const r = await route({ changedFiles: ['README.md', 'docs/a.md'], diffText: '+hello', full: true });
    expect(r.docsOnly).toBe(true);
    expect(r.selected.map(s => s.name).sort()).toEqual(['spec-drift-detector', 'ux-copy-reviewer']);
  });

  it('explicit agents bypass routing; skip/never/always/tags respected; unknown reported', async () => {
    let r = await route({ changedFiles: ['a.ts'], agents: ['logic-reviewer', 'nope-reviewer'] });
    expect(r.selected.map(s => s.name)).toEqual(['logic-reviewer']);
    expect(r.skipped).toEqual([{ name: 'nope-reviewer', why: 'unknown agent' }]);

    await fs.writeFile(join(root, '.spec-workflow', 'review.config.json'), JSON.stringify({ always: ['i18n-reviewer'], never: ['performance-reviewer'], maxAgents: 20 }));
    r = await route({ changedFiles: ['a.ts'], diffText: '+x', skip: ['api-reviewer'], tags: ['concurrency'] });
    const names = r.selected.map(s => s.name);
    expect(names).toContain('i18n-reviewer');
    expect(names).toContain('concurrency-reviewer');
    expect(names).not.toContain('performance-reviewer');
    expect(names).not.toContain('api-reviewer');
    expect(r.skipped.find(s => s.name === 'api-reviewer')?.why).toBe('--skip');
    expect(r.selected.find(s => s.name === 'concurrency-reviewer')?.reasons[0]).toMatch(/_Review tag/);
  });

  it('prefers the project .claude/agents over the shipped templates', async () => {
    await fs.mkdir(join(root, '.claude', 'agents'), { recursive: true });
    await fs.writeFile(join(root, '.claude', 'agents', 'my-reviewer.md'), `---\nname: my-reviewer\ndescription: mine\ntools: Read\ntier: 0\ntriggers:\n  always: true\n---\nbody`);
    const r = await route({ changedFiles: ['a.ts'] });
    expect(r.selected.map(s => s.name)).toEqual(['my-reviewer']);
  });
});

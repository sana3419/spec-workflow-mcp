import { promises as fs } from 'fs';
import { join, relative } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { PathUtils } from './path-utils.js';

const execFileP = promisify(execFile);

/**
 * Deterministic reviewer-agent routing.
 *
 * Source of truth = the agent files themselves (`.claude/agents/*.md` in the project, falling back
 * to this package's `agents/`). Each agent's frontmatter declares:
 *   tier: 0 | 1 | 2 | ...          (tier 0 = always on)
 *   tags: [..]
 *   triggers:
 *     always: true                 always selected
 *     paths:   ['**\/migrations/**', ...]     glob on changed file paths
 *     content: ['ALTER TABLE', ...]           regex on ADDED diff lines
 *     langs:   ['typescript', ...]            project language AND a changed file of that language
 *     profile: ['hasSpecs', 'hasLlmSdk', ...] project profile flags
 * No LLM is involved: same diff + same agents → same selection, with a reason per agent.
 *
 * Override precedence (highest first): explicit `agents` list → `add`/`skip` → tasks.md `_Review:` tags
 * (passed in as `tags`) → `.spec-workflow/review.config.json` (always / never / maxAgents) → triggers.
 */

export interface AgentSpec {
  name: string;
  description: string;
  tier: number;
  tags: string[];
  triggers: { always?: boolean; paths?: string[]; content?: string[]; langs?: string[]; profile?: string[] };
  file: string;
}

export interface RouteInput {
  projectPath: string;
  /** Changed files (repo-relative). If omitted, derived from `git diff --name-only <base>`. */
  changedFiles?: string[];
  /** Unified diff text. If omitted and git is available, derived from `git diff <base>` (capped). */
  diffText?: string;
  /** git base ref for auto diff (default: HEAD — i.e. working tree changes; use HEAD~1 for last commit). */
  base?: string;
  /** Explicit list — bypasses routing entirely (still validated against known agents). */
  agents?: string[];
  add?: string[];
  skip?: string[];
  /** Tags from tasks.md `_Review:` (e.g. ['security','perf']) — agents with any of these tags are selected. */
  tags?: string[];
  /** Ignore maxAgents and Tier-0-only shortcuts; select everything that triggers. */
  full?: boolean;
  maxAgents?: number;
}

export interface RouteResult {
  selected: Array<{ name: string; reasons: string[]; tier: number }>;
  skipped: Array<{ name: string; why: string }>;
  changedFiles: string[];
  profile: ProjectProfile;
  docsOnly: boolean;
  maxAgents: number;
  agentsDir: string;
  /** set when git could not produce the diff — selection then rests on tier 0 / explicit inputs only */
  gitError?: string;
}

export interface ProjectProfile {
  /** .spec-workflow/specs has at least one spec */
  hasSpecs: boolean;
  languages: string[];
  frameworks: string[];
  hasMigrations: boolean;
  hasLlmSdk: boolean;
  hasIac: boolean;
  hasUi: boolean;
}

export interface ReviewConfig {
  always?: string[];
  never?: string[];
  maxAgents?: number;
}

// ------------------------------------------------------------------ frontmatter

export function parseFrontmatter(md: string): Record<string, unknown> {
  const m = md.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Record<string, unknown> = {};
  const lines = m[1].split('\n');
  let currentObj: Record<string, unknown> | null = null;
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indented = /^\s+/.test(raw);
    const line = raw.trim();
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, valRaw] = kv;
    const val = valRaw.trim();
    if (!indented) {
      if (val === '') { currentObj = {}; out[key] = currentObj; }
      else { currentObj = null; out[key] = parseScalar(val); }
    } else if (currentObj) {
      currentObj[key] = parseScalar(val);
    }
  }
  return out;
}

function parseScalar(v: string): unknown {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    // split on commas outside quotes
    const items: string[] = [];
    let cur = '', q: string | null = null;
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (q) {
        if (c === q) { if (inner[i + 1] === q) { cur += q; i++; } else q = null; }
        else cur += c;
      } else if (c === '"' || c === "'") q = c;
      else if (c === ',') { items.push(cur.trim()); cur = ''; }
      else cur += c;
    }
    if (cur.trim() || items.length) items.push(cur.trim());
    return items.filter(s => s.length > 0);
  }
  return v.replace(/^["']|["']$/g, '');
}

export async function loadAgents(projectPath: string, fallbackDir?: string): Promise<{ agents: AgentSpec[]; dir: string }> {
  const candidates = [join(PathUtils.translatePath(projectPath), '.claude', 'agents')];
  if (fallbackDir) candidates.push(fallbackDir);
  for (const dir of candidates) {
    let names: string[] = [];
    try { names = (await fs.readdir(dir)).filter(n => n.endsWith('.md')); } catch { continue; }
    const files = await Promise.all(names.map(n => fs.readFile(join(dir, n), 'utf-8')));
    const agents: AgentSpec[] = [];
    for (const [i, md] of files.entries()) {
      const fm = parseFrontmatter(md);
      if (typeof fm.name !== 'string') continue;
      const trig = (fm.triggers && typeof fm.triggers === 'object') ? fm.triggers as Record<string, unknown> : {};
      agents.push({
        name: fm.name,
        description: String(fm.description ?? ''),
        tier: typeof fm.tier === 'number' ? fm.tier : (typeof fm.tier === 'string' && /^\d+$/.test(fm.tier) ? Number(fm.tier) : 9),
        tags: Array.isArray(fm.tags) ? fm.tags.map(String) : [],
        triggers: {
          always: trig.always === true,
          paths: Array.isArray(trig.paths) ? trig.paths.map(String) : undefined,
          content: Array.isArray(trig.content) ? trig.content.map(String) : undefined,
          langs: Array.isArray(trig.langs) ? trig.langs.map(String) : undefined,
          profile: Array.isArray(trig.profile) ? trig.profile.map(String) : undefined,
        },
        file: join(dir, names[i]),
      });
    }
    if (agents.length) return { agents: agents.sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name)), dir };
  }
  return { agents: [], dir: candidates[0] };
}

// ------------------------------------------------------------------ profile

export async function detectProfile(projectPath: string): Promise<ProjectProfile> {
  const root = PathUtils.translatePath(projectPath);
  // One parallel batch: the probes are independent, and several were previously
  // evaluated twice (requirements.txt / pyproject.toml).
  const PROBES = [
    'package.json', 'tsconfig.json', 'pyproject.toml', 'requirements.txt', 'setup.py',
    'go.mod', 'Cargo.toml', 'Gemfile', 'pom.xml', 'build.gradle', 'build.gradle.kts',
    'migrations', 'db/migrate', 'prisma/migrations', 'alembic',
    'Dockerfile', 'docker-compose.yml', 'terraform', 'k8s', 'helm',
  ] as const;
  const found = new Map<string, boolean>(
    await Promise.all(PROBES.map(async p =>
      [p, await fs.access(join(root, p)).then(() => true, () => false)] as [string, boolean]))
  );
  const exists = (p: string) => found.get(p) ?? false;

  const languages: string[] = [], frameworks: string[] = [];
  let hasLlmSdk = false, hasUi = false;
  if (exists('package.json')) {
    languages.push(exists('tsconfig.json') ? 'typescript' : 'javascript');
    try {
      const pkg = JSON.parse(await fs.readFile(join(root, 'package.json'), 'utf-8'));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      const has = (re: RegExp) => Object.keys(deps).some(d => re.test(d));
      if (has(/^react$|^next$/)) { frameworks.push('react'); hasUi = true; }
      if (has(/^vue$|^nuxt$/)) { frameworks.push('vue'); hasUi = true; }
      if (has(/^svelte/)) { frameworks.push('svelte'); hasUi = true; }
      if (has(/^express$|^fastify$|^koa$|^@nestjs\/core$|^hono$/)) frameworks.push('node-server');
      if (has(/^prisma$|^@prisma\/client$|^typeorm$|^sequelize$|^knex$|^drizzle-orm$/)) frameworks.push('orm');
      if (has(/^openai$|^@anthropic-ai\/sdk$|^@google\/generative-ai$|^ai$|^langchain$|^@langchain\//)) hasLlmSdk = true;
    } catch { /* ignore */ }
  }
  if (exists('pyproject.toml') || exists('requirements.txt') || exists('setup.py')) {
    languages.push('python');
    try {
      const [req, pyproject] = await Promise.all([
        exists('requirements.txt') ? fs.readFile(join(root, 'requirements.txt'), 'utf-8') : Promise.resolve(''),
        exists('pyproject.toml') ? fs.readFile(join(root, 'pyproject.toml'), 'utf-8') : Promise.resolve(''),
      ]);
      const txt = req + pyproject;
      if (/openai|anthropic|langchain|google-generativeai/i.test(txt)) hasLlmSdk = true;
      if (/django|flask|fastapi/i.test(txt)) frameworks.push('python-web');
    } catch { /* ignore */ }
  }
  if (exists('go.mod')) languages.push('go');
  if (exists('Cargo.toml')) languages.push('rust');
  if (exists('Gemfile')) languages.push('ruby');
  if (exists('pom.xml') || exists('build.gradle') || exists('build.gradle.kts')) languages.push('java');
  const hasMigrations = exists('migrations') || exists('db/migrate') || exists('prisma/migrations') || exists('alembic');
  const hasIac = exists('Dockerfile') || exists('docker-compose.yml') || exists('terraform') || exists('k8s') || exists('helm');
  let hasSpecs = false;
  try { hasSpecs = (await fs.readdir(join(root, '.spec-workflow', 'specs'))).length > 0; } catch { /* none */ }
  return { hasSpecs, languages, frameworks, hasMigrations, hasLlmSdk, hasIac, hasUi };
}

// ------------------------------------------------------------------ globs

/** Minimal glob → RegExp: ** any depth, * within segment, ? single char. Matches repo-relative paths. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.replace(/^\.\//, '');
  if (!g.startsWith('**/') && !g.startsWith('/')) g = '**/' + g; // allow bare patterns to match at any depth
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}

// ------------------------------------------------------------------ diff

const GIT_REF = /^[A-Za-z0-9._\/~^@{}-]{1,200}$/;

async function gitDiff(projectPath: string, base: string, onlyFiles?: string[]): Promise<{ files: string[]; text: string; error?: string }> {
  const cwd = PathUtils.translatePath(projectPath);
  let files: string[] = [], text = '', error: string | undefined;
  // `base` may come from an LLM tool call: never let it be parsed as a git option (--output=... = file write).
  if (!GIT_REF.test(base) || base.startsWith('-')) return { files: [], text: '', error: `invalid git base ref: ${JSON.stringify(base).slice(0, 80)}` };
  try {
    const { stdout: names } = await execFileP('git', ['diff', '--no-color', '--name-only', '--diff-filter=d', '--end-of-options', base], { cwd, maxBuffer: 8e6 });
    files = names.split('\n').map(s => s.trim()).filter(Boolean);
    if (base === 'HEAD') {
      // include untracked new files so brand-new modules are routed too
      const { stdout: untracked } = await execFileP('git', ['ls-files', '--others', '--exclude-standard'], { cwd, maxBuffer: 8e6 });
      files = [...new Set([...files, ...untracked.split('\n').map(s => s.trim()).filter(Boolean)])];
    }
  } catch (e) {
    return { files: [], text: '', error: `git diff --name-only ${base} failed: ${(e as Error).message.split('\n')[0]}` };
  }
  try {
    const scoped = onlyFiles && onlyFiles.length ? ['--', ...onlyFiles.filter(f => !f.startsWith('-'))] : [];
    const { stdout } = await execFileP('git', ['diff', '--no-color', '--end-of-options', base, ...scoped], { cwd, maxBuffer: 32e6 });
    text = stdout.slice(0, 4e6);
  } catch (e) {
    error = `git diff ${base} failed (content triggers skipped): ${(e as Error).message.split('\n')[0]}`;
  }
  return { files, text, error };
}

/** Only ADDED lines (`+...`, not `+++` headers) — reviewers care about what the change introduces. */
export function addedLines(diff: string): string[] {
  return diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1));
}

const DOC_EXT = /\.(md|mdx|txt|rst|adoc)$/i;
const LANG_EXT: Record<string, RegExp> = {
  typescript: /\.(ts|tsx|mts|cts)$/i, javascript: /\.(js|jsx|mjs|cjs)$/i, python: /\.py$/i, go: /\.go$/i,
  rust: /\.rs$/i, ruby: /\.rb$/i, java: /\.(java|kt)$/i,
};

// ------------------------------------------------------------------ route

export async function loadReviewConfig(projectPath: string): Promise<ReviewConfig> {
  try {
    return JSON.parse(await fs.readFile(join(PathUtils.getWorkflowRoot(projectPath), 'review.config.json'), 'utf-8'));
  } catch { return {}; }
}

export async function routeReview(input: RouteInput, fallbackAgentsDir?: string): Promise<RouteResult> {
  const { agents, dir } = await loadAgents(input.projectPath, fallbackAgentsDir);
  const known = new Map(agents.map(a => [a.name, a]));
  const cfg = await loadReviewConfig(input.projectPath);
  const maxAgents = input.full ? Infinity : (input.maxAgents ?? cfg.maxAgents ?? 12);
  const profile = await detectProfile(input.projectPath);

  let changedFiles = input.changedFiles;
  let diffText = input.diffText;
  let gitError: string | undefined;
  if (!changedFiles || (!diffText && changedFiles.length)) {
    const d = await gitDiff(input.projectPath, input.base ?? 'HEAD', changedFiles);
    changedFiles = changedFiles ?? d.files; diffText = diffText ?? d.text; gitError = d.error;
  }
  changedFiles = (changedFiles ?? []).map(f => f.replace(/^\.\//, ''));
  const added = addedLines(diffText ?? '');
  // prompt files are markdown but are code for LLM apps — never treat them as docs
  const isDoc = (f: string) => DOC_EXT.test(f) && !/(^|\/)prompts?\//i.test(f) && !/\.prompt\.md$/i.test(f);
  const docsOnly = changedFiles.length > 0 && changedFiles.every(isDoc);

  const skipped: RouteResult['skipped'] = [];
  const reasons = new Map<string, string[]>();
  const push = (name: string, why: string) => {
    if (!known.has(name)) { skipped.push({ name, why: 'unknown agent' }); return; }
    const arr = reasons.get(name) ?? [];
    if (!arr.includes(why)) arr.push(why);
    reasons.set(name, arr);
  };

  // 1) explicit list wins
  if (input.agents && input.agents.length) {
    for (const n of input.agents) push(n, 'explicit --agents');
  } else {
    // 2) config always
    for (const n of cfg.always ?? []) push(n, 'review.config.json always');
    // 3) tags from tasks.md _Review:
    if (input.tags?.length) {
      for (const a of agents) if (a.tags.some(t => input.tags!.includes(t))) push(a.name, `_Review tag ${a.tags.filter(t => input.tags!.includes(t)).join('/')}`);
    }
    // 4) triggers (docs-only diffs take a fast path: drift + copy only, no profile nudges)
    if (docsOnly) {
      push('spec-drift-detector', 'docs-only fast path');
      push('ux-copy-reviewer', 'docs-only fast path');
    }
    for (const a of agents) {
      const t = a.triggers;
      if (docsOnly) break;
      if (t.always) { push(a.name, a.tier === 0 ? 'tier 0 (always)' : 'always'); continue; }
      if (t.paths?.length && changedFiles.length) {
        const res = t.paths.map(globToRegExp);
        const hit = changedFiles.find(f => res.some(r => r.test(f)));
        if (hit) push(a.name, `path ${hit}`);
      }
      if (t.content?.length && added.length) {
        for (const pat of t.content) {
          if (pat.length > 200 || /(\([^)]*[+*][^)]*\)[+*])/.test(pat)) continue; // agent files are project-writable: cap + crude nested-quantifier guard
          let re: RegExp;
          try { re = new RegExp(pat, 'i'); } catch { continue; }
          const line = added.find(l => re.test(l));
          if (line) { push(a.name, `content /${pat}/`); break; }
        }
      }
      if (t.langs?.length) {
        const hits = t.langs.filter(l => profile.languages.includes(l) && changedFiles.some(f => LANG_EXT[l]?.test(f)));
        if (hits.length) push(a.name, `lang ${hits.join('/')} (changed files)`);
      }
      if (t.profile?.length) {
        const hits = t.profile.filter(k => (profile as any)[k] === true);
        if (hits.length) push(a.name, `profile ${hits.join('/')}`);
      }
    }
    // profile-driven nudges (still deterministic)
    if (!docsOnly && profile.hasLlmSdk) push('cost-reviewer', 'profile: LLM SDK present');
    if (!docsOnly && profile.hasUi && changedFiles.some(f => /\.(tsx|jsx|vue|svelte|html|css|scss)$/i.test(f))) push('accessibility-reviewer', 'profile: UI files changed');
    for (const n of input.add ?? []) push(n, '--add');
  }
  for (const n of input.skip ?? []) { if (reasons.delete(n)) skipped.push({ name: n, why: '--skip' }); }
  for (const n of cfg.never ?? []) { if (reasons.delete(n)) skipped.push({ name: n, why: 'review.config.json never' }); }

  // order: tier 0 first; then SPECIFIC hits (path/content/profile/tag/explicit) before lang-only hits;
  // then more reasons first; then lower tier; then name. Cap afterwards.
  const specific = (rs: string[]) => rs.some(r => !r.startsWith('lang '));
  let selected = [...reasons.entries()].map(([name, rs]) => ({ name, reasons: rs, tier: known.get(name)!.tier }))
    .sort((a, b) => (a.tier === 0 ? 0 : 1) - (b.tier === 0 ? 0 : 1)
      || Number(specific(b.reasons)) - Number(specific(a.reasons))
      || b.reasons.length - a.reasons.length
      || a.tier - b.tier
      || a.name.localeCompare(b.name));
  if (selected.length > maxAgents) {
    let keep = selected.slice(0, maxAgents);
    const dropped = selected.slice(maxAgents);
    // A language/stack lens (tier 3, lang-triggered) is what most users want most: reserve one slot for it
    // by displacing the lowest-ranked tier-1 lens if it would otherwise fall off.
    const langLens = dropped.find(s => s.tier === 3 && s.reasons.some(r => r.startsWith('lang ')));
    if (langLens && !keep.some(s => s.tier === 3)) {
      const idx = keep.map(s => s.tier).lastIndexOf(1);
      if (idx >= 0) { dropped.push(keep[idx]); keep = [...keep.slice(0, idx), ...keep.slice(idx + 1), langLens]; dropped.splice(dropped.indexOf(langLens), 1); }
    }
    for (const s of dropped) skipped.push({ name: s.name, why: `over maxAgents=${maxAgents} (use --full or --max-agents)` });
    selected = keep;
  }
  return { selected, skipped, changedFiles, profile, docsOnly, maxAgents: Number.isFinite(maxAgents) ? maxAgents : -1, agentsDir: relative(process.cwd(), dir) || dir, ...(gitError ? { gitError } : {}) };
}

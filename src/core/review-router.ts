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
 * to this package's `templates/agents`). Each agent's frontmatter declares:
 *   tier: 0 | 1 | 2 | ...          (tier 0 = always on)
 *   tags: [..]
 *   triggers:
 *     always: true                 always selected
 *     paths:   ['**\/migrations/**', ...]     glob on changed file paths
 *     content: ['ALTER TABLE', ...]           regex on ADDED diff lines
 *     langs:   ['typescript', ...]            project profile languages
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
  triggers: { always?: boolean; paths?: string[]; content?: string[]; langs?: string[] };
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
}

export interface ProjectProfile {
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
  const m = md.match(/^---\n([\s\S]*?)\n---/);
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
    const agents: AgentSpec[] = [];
    for (const n of names) {
      const md = await fs.readFile(join(dir, n), 'utf-8');
      const fm = parseFrontmatter(md);
      if (typeof fm.name !== 'string') continue;
      const trig = (fm.triggers && typeof fm.triggers === 'object') ? fm.triggers as Record<string, unknown> : {};
      agents.push({
        name: fm.name,
        description: String(fm.description ?? ''),
        tier: typeof fm.tier === 'number' ? fm.tier : 9,
        tags: Array.isArray(fm.tags) ? fm.tags.map(String) : [],
        triggers: {
          always: trig.always === true,
          paths: Array.isArray(trig.paths) ? trig.paths.map(String) : undefined,
          content: Array.isArray(trig.content) ? trig.content.map(String) : undefined,
          langs: Array.isArray(trig.langs) ? trig.langs.map(String) : undefined,
        },
        file: join(dir, n),
      });
    }
    if (agents.length) return { agents: agents.sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name)), dir };
  }
  return { agents: [], dir: candidates[0] };
}

// ------------------------------------------------------------------ profile

export async function detectProfile(projectPath: string): Promise<ProjectProfile> {
  const root = PathUtils.translatePath(projectPath);
  const exists = async (p: string) => { try { await fs.access(join(root, p)); return true; } catch { return false; } };
  const languages: string[] = [], frameworks: string[] = [];
  let hasLlmSdk = false, hasUi = false;
  if (await exists('package.json')) {
    languages.push(await exists('tsconfig.json') ? 'typescript' : 'javascript');
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
  if (await exists('pyproject.toml') || await exists('requirements.txt') || await exists('setup.py')) {
    languages.push('python');
    try {
      const txt = (await exists('requirements.txt') ? await fs.readFile(join(root, 'requirements.txt'), 'utf-8') : '') + (await exists('pyproject.toml') ? await fs.readFile(join(root, 'pyproject.toml'), 'utf-8') : '');
      if (/openai|anthropic|langchain|google-generativeai/i.test(txt)) hasLlmSdk = true;
      if (/django|flask|fastapi/i.test(txt)) frameworks.push('python-web');
    } catch { /* ignore */ }
  }
  if (await exists('go.mod')) languages.push('go');
  if (await exists('Cargo.toml')) languages.push('rust');
  if (await exists('Gemfile')) languages.push('ruby');
  if (await exists('pom.xml') || await exists('build.gradle') || await exists('build.gradle.kts')) languages.push('java');
  const hasMigrations = (await exists('migrations')) || (await exists('db/migrate')) || (await exists('prisma/migrations')) || (await exists('alembic'));
  const hasIac = (await exists('Dockerfile')) || (await exists('docker-compose.yml')) || (await exists('terraform')) || (await exists('k8s')) || (await exists('helm'));
  return { languages, frameworks, hasMigrations, hasLlmSdk, hasIac, hasUi };
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

async function gitDiff(projectPath: string, base: string): Promise<{ files: string[]; text: string } | null> {
  const cwd = PathUtils.translatePath(projectPath);
  try {
    const args = base === 'HEAD' ? ['diff', 'HEAD'] : ['diff', base];
    const { stdout: names } = await execFileP('git', ['diff', '--name-only', ...(base === 'HEAD' ? ['HEAD'] : [base])], { cwd, maxBuffer: 8e6 });
    let files = names.split('\n').map(s => s.trim()).filter(Boolean);
    if (base === 'HEAD') {
      // include untracked new files so brand-new modules are routed too
      const { stdout: untracked } = await execFileP('git', ['ls-files', '--others', '--exclude-standard'], { cwd, maxBuffer: 8e6 });
      files = [...new Set([...files, ...untracked.split('\n').map(s => s.trim()).filter(Boolean)])];
    }
    const { stdout: text } = await execFileP('git', args, { cwd, maxBuffer: 32e6 });
    return { files, text: text.slice(0, 4e6) };
  } catch {
    return null;
  }
}

/** Only ADDED lines (`+...`, not `+++` headers) — reviewers care about what the change introduces. */
export function addedLines(diff: string): string[] {
  return diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1));
}

const DOC_EXT = /\.(md|mdx|txt|rst|adoc)$/i;

// ------------------------------------------------------------------ route

export async function loadReviewConfig(projectPath: string): Promise<ReviewConfig> {
  try {
    return JSON.parse(await fs.readFile(join(PathUtils.getWorkflowRoot(PathUtils.translatePath(projectPath)), 'review.config.json'), 'utf-8'));
  } catch { return {}; }
}

export async function routeReview(input: RouteInput, fallbackAgentsDir?: string): Promise<RouteResult> {
  const { agents, dir } = await loadAgents(input.projectPath, fallbackAgentsDir);
  const known = new Map(agents.map(a => [a.name, a]));
  const cfg = await loadReviewConfig(input.projectPath);
  const maxAgents = input.full ? Infinity : (input.maxAgents ?? cfg.maxAgents ?? 8);
  const profile = await detectProfile(input.projectPath);

  let changedFiles = input.changedFiles;
  let diffText = input.diffText;
  if (!changedFiles || (!diffText && changedFiles.length)) {
    const d = await gitDiff(input.projectPath, input.base ?? 'HEAD');
    if (d) { changedFiles = changedFiles ?? d.files; diffText = diffText ?? d.text; }
  }
  changedFiles = (changedFiles ?? []).map(f => f.replace(/^\.\//, ''));
  const added = addedLines(diffText ?? '');
  const docsOnly = changedFiles.length > 0 && changedFiles.every(f => DOC_EXT.test(f));

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
          let re: RegExp;
          try { re = new RegExp(pat, 'i'); } catch { continue; }
          const line = added.find(l => re.test(l));
          if (line) { push(a.name, `content /${pat}/`); break; }
        }
      }
      if (t.langs?.length && t.langs.some(l => profile.languages.includes(l))) push(a.name, `lang ${t.langs.filter(l => profile.languages.includes(l)).join('/')}`);
    }
    // profile-driven nudges (still deterministic)
    if (!docsOnly && profile.hasLlmSdk) push('cost-reviewer', 'profile: LLM SDK present');
    if (!docsOnly && profile.hasUi && changedFiles.some(f => /\.(tsx|jsx|vue|svelte|html|css|scss)$/i.test(f))) push('accessibility-reviewer', 'profile: UI files changed');
    for (const n of input.add ?? []) push(n, '--add');
  }
  for (const n of input.skip ?? []) { if (reasons.delete(n)) skipped.push({ name: n, why: '--skip' }); }
  for (const n of cfg.never ?? []) { if (reasons.delete(n)) skipped.push({ name: n, why: 'review.config.json never' }); }

  // order: tier, then number of reasons desc, then name; cap
  let selected = [...reasons.entries()].map(([name, rs]) => ({ name, reasons: rs, tier: known.get(name)!.tier }))
    .sort((a, b) => a.tier - b.tier || b.reasons.length - a.reasons.length || a.name.localeCompare(b.name));
  if (selected.length > maxAgents) {
    for (const s of selected.slice(maxAgents)) skipped.push({ name: s.name, why: `over maxAgents=${maxAgents} (use --full or --max-agents)` });
    selected = selected.slice(0, maxAgents);
  }
  return { selected, skipped, changedFiles, profile, docsOnly, maxAgents: Number.isFinite(maxAgents) ? maxAgents : -1, agentsDir: relative(process.cwd(), dir) || dir };
}

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

// Redirect the gates home + env file into a temp dir BEFORE importing the module.
const home = join(tmpdir(), `swmcp-gates-home-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
vi.mock('os', async (orig) => {
  const real = await orig<typeof import('os')>();
  return { ...real, homedir: () => home };
});

const gates = await import('../gates.js');
const { getRunDir } = await import('../run-state.js');

let root: string;
beforeEach(async () => {
  root = join(tmpdir(), `swmcp-gates-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  await fs.mkdir(join(root, '.spec-workflow', 'specs', 's'), { recursive: true });
  await fs.mkdir(home, { recursive: true });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

describe('core/gates', () => {
  it('ensureGateSecret creates a 0600 env file with a 64-hex secret and is idempotent', async () => {
    const s1 = await gates.ensureGateSecret();
    const s2 = await gates.ensureGateSecret();
    expect(s1).toBe(s2);
    expect(s1).toMatch(/^[0-9a-f]{64}$/);
    const st = await fs.stat(gates.TELEGRAM_ENV);
    expect(st.mode & 0o777).toBe(0o600);
    expect(gates.TELEGRAM_ENV.startsWith(home)).toBe(true);
  });

  it('lists pending gates written by the runner and records an HMAC-signed decision idempotently', async () => {
    const dir = join(getRunDir(root, 's'), 'gates');
    await fs.mkdir(dir, { recursive: true });
    const pending = { id: 's-spec-gate-fail-1-20260817T000000Z', spec: 's', kind: 'spec-gate-fail', nonce: 'ab'.repeat(16), summary: 'x', createdAt: '2026-08-17T00:00:00Z' };
    await fs.writeFile(join(dir, `${pending.id}.pending`), JSON.stringify(pending));
    await fs.writeFile(join(dir, 'junk.pending'), '{not json');
    const list = await gates.listPendingGates(root, 's');
    expect(list.map(g => g.id)).toEqual([pending.id]);

    const secret = await gates.ensureGateSecret();
    const first = await gates.writeDecision(root, pending, 'approve', 'tg:42', secret);
    expect(first.alreadyDecided).toBe(false);
    const again = await gates.writeDecision(root, pending, 'reject', 'tg:99', secret);
    expect(again.alreadyDecided).toBe(true);
    expect(again.record.decision).toBe('approve'); // redelivered callback cannot flip it

    expect(gates.verifyDecision(first.record, pending, secret)).toBe(true);
    expect(gates.verifyDecision({ ...first.record, decision: 'reject' }, pending, secret)).toBe(false);
    expect(gates.verifyDecision(first.record, { ...pending, nonce: 'ff'.repeat(16) }, secret)).toBe(false);

    const file = join(gates.gatesDecisionDir(root), `${pending.id}.json`);
    expect(((await fs.stat(file)).mode & 0o777)).toBe(0o600);
  });

  it('HMAC matches what the bash runner computes with openssl', async () => {
    let openssl = true;
    try { execSync('openssl version', { stdio: 'ignore' }); } catch { openssl = false; }
    if (!openssl) return; // environment without openssl: skip silently
    const secret = 'deadbeef'.repeat(8);
    const [id, nonce, dec, by, at] = ['s-manual-1-x', '00'.repeat(16), 'approve', 'tg:1', '2026-08-17T00:00:00Z'] as const;
    const ts = gates.gateHmac(secret, id, nonce, dec, by, at);
    const sh = execSync(`printf '%s' "${id}:${nonce}:${dec}:${by}:${at}" | openssl dgst -sha256 -hmac "${secret}" | awk '{print $NF}'`).toString().trim();
    expect(sh).toBe(ts);
  });

  it('projectHash matches sha256(realpath) | cut -c1-16', async () => {
    const ts = gates.projectHash(root);
    const sh = execSync(`printf '%s' "$(realpath "${root}")" | sha256sum | cut -c1-16`).toString().trim();
    expect(ts).toBe(sh);
  });
});

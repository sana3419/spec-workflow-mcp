import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfigFromPath, loadConfigFile, mergeConfigs, SpecWorkflowConfig } from '../config.js';

describe('config', () => {
  let testDir: string;
  const write = async (content: string) => {
    const p = join(testDir, 'config.toml');
    await fs.writeFile(p, content);
    return p;
  };

  beforeEach(async () => {
    testDir = join(tmpdir(), `spec-workflow-config-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    await fs.mkdir(testDir, { recursive: true });
  });
  afterEach(async () => { await fs.rm(testDir, { recursive: true, force: true }); });

  describe('loadConfigFromPath', () => {
    it('loads lang / projectDir', async () => {
      const r = loadConfigFromPath(await write(`lang = "ja"\nprojectDir = "~/x"\n`));
      expect(r.error).toBeUndefined();
      expect(r.config?.lang).toBe('ja');
      expect(r.config?.projectDir).toContain('/x');
    });

    it('rejects a wrong-typed lang', async () => {
      const r = loadConfigFromPath(await write(`lang = 42\n`));
      expect(r.config).toBeNull();
      expect(r.error).toContain('lang');
    });

    it('ignores legacy dashboard keys (port / bindAddress / dashboardOnly / [security])', async () => {
      const r = loadConfigFromPath(await write(`port = 8080\nbindAddress = "0.0.0.0"\ndashboardOnly = true\n[security]\nrateLimitPerMinute = 0\n`));
      expect(r.error).toBeUndefined();
      expect((r.config as any).port).toBeUndefined();
      expect((r.config as any).security).toBeUndefined();
    });

    it('validates [engine]', async () => {
      expect(loadConfigFromPath(await write(`[engine]\ndefault = "gemini"\n`)).error).toContain('engine.default');
      expect(loadConfigFromPath(await write(`[engine]\nmaxFixAttempts = 0\n`)).error).toContain('maxFixAttempts');
      expect(loadConfigFromPath(await write(`[engine.codex]\nsandbox = "yolo"\n`)).error).toContain('sandbox');
      const ok = loadConfigFromPath(await write(`[engine]\ndefault = "claude"\nmaxFixAttempts = 3\n[engine.codex]\nsandbox = "read-only"\napprovalPolicy = "never"\n`));
      expect(ok.error).toBeUndefined();
      expect(ok.config?.engine?.codex?.sandbox).toBe('read-only');
    });

    it('returns a parse error for invalid TOML', async () => {
      const r = loadConfigFromPath(await write(`lang = "unterminated\n`));
      expect(r.config).toBeNull();
      expect(r.error).toBeTruthy();
    });

    it('returns null when the file does not exist', () => {
      const r = loadConfigFromPath(join(testDir, 'nope.toml'));
      expect(r.config).toBeNull();
    });
  });

  describe('loadConfigFile', () => {
    it('returns null config when no config file exists', () => {
      expect(loadConfigFile(testDir).config).toBeNull();
    });
    it('reads .spec-workflow/config.toml', async () => {
      await fs.mkdir(join(testDir, '.spec-workflow'), { recursive: true });
      await fs.writeFile(join(testDir, '.spec-workflow', 'config.toml'), `lang = "en"\n`);
      expect(loadConfigFile(testDir).config?.lang).toBe('en');
    });
  });

  describe('mergeConfigs', () => {
    it('CLI args override file config, undefined does not', () => {
      const file: SpecWorkflowConfig = { lang: 'en', projectDir: '/a' };
      expect(mergeConfigs(null, { lang: 'ja' }).lang).toBe('ja');
      const merged = mergeConfigs(file, { lang: undefined, projectDir: '/b' });
      expect(merged.lang).toBe('en');
      expect(merged.projectDir).toBe('/b');
    });
  });
});

import { describe, it, expect } from 'vitest';
import { mergeDiscoveredProjects, ProjectStateEntry } from '../project-state.js';

const st = (status: ProjectStateEntry['status']): ProjectStateEntry => ({ status, at: '2026-08-21T00:00:00Z' });

describe('mergeDiscoveredProjects (the Telegram home screen sees BOTH registries)', () => {
  it('lists a project init.sh recorded even though no MCP server ever started in it', () => {
    // The exact case that made a Telegram-created project invisible: registry empty, state has it.
    const out = mergeDiscoveredProjects(['/tg/pinned'], [], { '/home/me/company': st('initialized') });
    expect(out).toContain('/home/me/company');
    expect(out).toContain('/tg/pinned');
  });

  it('keeps registry entries and de-duplicates across all three sources', () => {
    const out = mergeDiscoveredProjects(['/a'], ['/a', '/b'], { '/a': st('initialized'), '/c': st('pending') });
    expect([...out].sort()).toEqual(['/a', '/b', '/c']);
  });

  it('honours `ignored` as a veto, whatever the other sources say', () => {
    const out = mergeDiscoveredProjects(['/a'], ['/a'], { '/a': st('ignored') });
    expect(out).toEqual([]);
  });

  it('carries a pending project through (the liveness check, not this, decides if it is real)', () => {
    expect(mergeDiscoveredProjects([], [], { '/p': st('pending') })).toEqual(['/p']);
  });

  it('drops empty entries instead of listing a blank project', () => {
    expect(mergeDiscoveredProjects([''], [''], {})).toEqual([]);
  });
});

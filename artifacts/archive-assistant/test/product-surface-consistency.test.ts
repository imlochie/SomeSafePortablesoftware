import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const appSource = await readFile(join(import.meta.dirname, '..', 'src', 'App.tsx'), 'utf8');

describe('pilot surface consistency', () => {
  it('uses the rendered Plex-only projection for its summary count', () => {
    expect(appSource).toContain('ONLY ({plexOnly.length})');
    expect(appSource).not.toContain('PLEX ONLY ({scan?.plexOnlyCount ?? 0})');
  });

  it('does not expose the demo job control in the normal queue surface', () => {
    expect(appSource).not.toContain('button-create-mock-job');
    expect(appSource).not.toContain('CREATE DEMO JOB');
  });

  it('does not render reserved settings groups and makes unconfigured providers explicit', () => {
    expect(appSource).not.toContain('RESERVED</span>');
    expect(appSource).toContain("provider.configured ? provider.state : 'not_configured'");
  });
});

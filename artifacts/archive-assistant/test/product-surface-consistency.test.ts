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

  it('loads the assistant briefing on Home and never infers health from an unavailable readout', () => {
    expect(appSource).toContain('const assistantOverview = useGetAssistantOverview();');
    expect(appSource).not.toContain("enabled: false, queryKey: ['assistant-overview-deferred']");
    expect(appSource).toContain('data-testid="panel-home-briefing-unavailable"');
    expect(appSource).toContain('const assistantReady = !assistantOverview.isLoading && !assistantOverview.isError');
    expect(appSource).toContain("!assistantReady ? 'Briefing is not confirmed.'");
  });

  it('opens meaningful findings in the shared evidence record instead of a generic subsystem page', async () => {
    const findingSource = await readFile(join(import.meta.dirname, '..', 'src', 'components', 'finding-detail.tsx'), 'utf8');
    expect(appSource).toContain('/assistant/findings/:findingId');
    expect(appSource).toContain('encodeURIComponent(item.id)');
    expect(findingSource).toContain('panel-finding-conclusion');
    expect(findingSource).toContain('panel-finding-evidence');
    expect(findingSource).toContain('panel-finding-uncertainty');
    expect(findingSource).toContain('finding-confidence');
    expect(findingSource).toContain('This is not a negative conclusion.');
  });
});

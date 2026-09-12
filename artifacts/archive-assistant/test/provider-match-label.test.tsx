import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { recordState } = vi.hoisted(() => ({
  recordState: {
    current: null as Record<string, unknown> | null,
  },
}));

vi.mock('@workspace/api-client-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workspace/api-client-react')>();
  return {
    ...actual,
    getGetArchiveRecordQueryKey: (id: number) => ['archive', 'record', id],
    getGetArchiveInventoryQueryKey: () => ['archive', 'inventory'],
    useGetArchiveRecord: () => ({
      data: recordState.current,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useUpdateArchiveRecordReview: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

import { ArchiveRecordPanel } from '../src/App';

function baseRecord(plexMatch: Record<string, unknown> | null) {
  return {
    id: 7,
    archiveItemId: null,
    filename: 'Gamma.2024.mkv',
    path: 'D:/archive/Gamma.2024.mkv',
    relativePath: 'Gamma.2024.mkv',
    sizeBytes: 2048,
    checksum: 'checksum',
    mediaType: 'movie',
    scanStatus: 'active',
    errorMessage: null,
    integrityClassification: null,
    integritySummary: null,
    durationSeconds: null,
    videoCodec: 'h264',
    audioCodec: 'aac',
    width: 1920,
    height: 1080,
    fps: null,
    bitrate: null,
    container: 'matroska',
    dynamicRange: null,
    audioChannels: 2,
    audioLanguages: [],
    subtitleLanguages: [],
    lastSeenAt: null,
    qualityStatus: 'lower_quality_version',
    qualitySummary: 'The matched Jellyfin version ranks higher on available metadata.',
    qualityDifferences: ['resolution 1080p vs 2160p'],
    duplicateOfId: null,
    plexMatch,
    reviewStatus: 'unreviewed',
    reviewNote: null,
    reviewUpdatedAt: null,
  };
}

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ArchiveRecordPanel id={7} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

describe('provider-aware match labelling', () => {
  it('labels a Jellyfin match as JELLYFIN MATCH rather than always saying Plex', () => {
    recordState.current = baseRecord({
      ratingKey: 'jf-100',
      title: 'Gamma',
      year: 2024,
      qualityDifferences: ['resolution 1080p vs 2160p'],
      provider: 'jellyfin',
      providerLabel: 'Jellyfin',
    });
    renderPanel();

    expect(screen.getByText('JELLYFIN MATCH')).toBeInTheDocument();
    expect(screen.queryByText('PLEX MATCH')).not.toBeInTheDocument();
  });

  it('still labels a Plex match as PLEX MATCH', () => {
    recordState.current = baseRecord({
      ratingKey: '100',
      title: 'Gamma',
      year: 2024,
      qualityDifferences: [],
      provider: 'plex',
      providerLabel: 'Plex',
    });
    renderPanel();

    expect(screen.getByText('PLEX MATCH')).toBeInTheDocument();
    expect(screen.queryByText('JELLYFIN MATCH')).not.toBeInTheDocument();
  });

  it('falls back to the Plex label when a provider is not supplied', () => {
    // Older cached payloads predate provider attribution; the panel must still
    // render a sensible heading rather than "UNDEFINED MATCH".
    recordState.current = baseRecord({
      ratingKey: '100',
      title: 'Gamma',
      year: 2024,
      qualityDifferences: [],
    });
    renderPanel();

    expect(screen.getByText('PLEX MATCH')).toBeInTheDocument();
  });
});

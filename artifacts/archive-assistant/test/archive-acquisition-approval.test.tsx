import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@workspace/api-client-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workspace/api-client-react')>();
  return {
    ...actual,
    getLookupArchiveMediaQueryKey: (params: unknown) => ['archive', 'lookup', params],
    useLookupArchiveMedia: () => ({
      data: undefined,
      isError: false,
      isFetching: false,
    }),
  };
});

import { ArchiveAcquisitionPanel, type ArchiveAcquisitionTarget } from '../src/components/archive-acquisition-panel';

const target = {
  kind: 'finding',
  record: {
    id: 41,
    archiveItemId: 9,
    filename: 'The Signal.mkv',
    path: 'D:/archive/The Signal.mkv',
    relativePath: 'The Signal.mkv',
    sizeBytes: 1024,
    checksum: 'checksum',
    mediaType: 'movie',
    scanStatus: 'present',
    errorMessage: null,
    durationSeconds: null,
    videoCodec: null,
    audioCodec: null,
    width: null,
    height: null,
    fps: null,
    bitrate: null,
    container: 'mkv',
    dynamicRange: null,
    audioChannels: null,
    audioLanguages: [],
    subtitleLanguages: [],
    lastSeenAt: null,
    qualityStatus: 'needs_review',
    qualitySummary: 'Needs review',
    qualityDifferences: [],
    duplicateOfId: null,
    plexMatch: null,
    reviewStatus: 'unresolved',
    reviewNote: null,
    reviewUpdatedAt: null,
  },
} satisfies ArchiveAcquisitionTarget;

describe('archive acquisition approval boundary', () => {
  it('states that provider work waits for persisted approval and explicit job creation', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ArchiveAcquisitionPanel target={target} onClose={vi.fn()} />
      </QueryClientProvider>,
    );

    expect(screen.getByText('PROVIDER WORK HAS NOT STARTED')).toBeInTheDocument();
    expect(screen.queryByText('REQUEST THIS ITEM')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByTestId('button-explain-acquisition-approval'));
    expect(screen.getByTestId('status-acquisition-request')).toHaveTextContent('approve the acquisition recommendation');
    expect(screen.getByTestId('status-acquisition-request')).toHaveTextContent('CREATE / VIEW JOB');
  });
});
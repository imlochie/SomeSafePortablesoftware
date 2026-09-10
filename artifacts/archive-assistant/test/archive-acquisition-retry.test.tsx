import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcquisitionJob } from '@workspace/api-client-react';

const { requestMutate, retryMutate } = vi.hoisted(() => ({
  requestMutate: vi.fn(),
  retryMutate: vi.fn(),
}));

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
    useRequestArchiveAcquisition: () => ({
      isPending: false,
      mutate: requestMutate,
    }),
    useRetryAcquisitionJob: () => ({
      isPending: false,
      mutate: retryMutate,
    }),
  };
});

import {
  ArchiveAcquisitionPanel,
  type ArchiveAcquisitionTarget,
} from '../src/components/archive-acquisition-panel';

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

function job(overrides: Partial<AcquisitionJob>): AcquisitionJob {
  return {
    id: 7,
    ownerId: 'owner-1',
    mediaType: 'movie',
    title: 'The Signal',
    year: null,
    externalId: 'movie-7',
    sourceId: 'movie-7',
    sourceUrl: null,
    providerId: 'radarr',
    providerJobId: null,
    providerReference: null,
    downloadJobId: null,
    state: 'failed',
    progress: 0,
    retryCount: 0,
    maxRetries: 2,
    errorCode: 'PROVIDER_UNAVAILABLE',
    errorMessage: 'Radarr is unavailable.',
    request: {},
    metadata: {},
    plannedAt: '',
    searchingAt: null,
    sourceSelectedAt: null,
    downloadingAt: null,
    processingAt: null,
    verifyingAt: null,
    importingAt: null,
    completedAt: null,
    failedAt: '',
    cancelledAt: null,
    createdAt: '',
    updatedAt: '',
    events: [],
    ...overrides,
  };
}

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ArchiveAcquisitionPanel target={target} onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe('archive acquisition retry', () => {
  beforeEach(() => {
    requestMutate.mockReset();
    retryMutate.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('keeps a provider failure visible and retries the same owner-scoped job', async () => {
    const failed = job({});
    requestMutate.mockImplementationOnce((_request: unknown, options: { onSuccess: (value: AcquisitionJob) => void }) => {
      options.onSuccess(failed);
    });
    retryMutate.mockImplementationOnce((_request: unknown, options: { onSuccess: (value: AcquisitionJob) => void }) => {
      options.onSuccess(job({
        state: 'searching',
        retryCount: 1,
        errorCode: null,
        errorMessage: null,
        failedAt: null,
      }));
    });

    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByTestId('button-request-direct-acquisition'));

    expect(screen.getByTestId('status-acquisition-provider-error')).toHaveTextContent('Radarr is unavailable.');
    expect(screen.getByTestId('text-acquisition-retry-budget')).toHaveTextContent('2 retries remaining');
    expect(screen.getByTestId('text-acquisition-target')).toHaveTextContent('The Signal.mkv');
    expect(screen.getByTestId('text-acquisition-target')).toHaveTextContent('archive remains unchanged');

    await user.click(screen.getByTestId('button-retry-acquisition'));

    expect(retryMutate).toHaveBeenCalledWith({ id: 7 }, expect.anything());
    expect(screen.getByTestId('text-acquisition-state')).toHaveTextContent('SEARCHING');
    expect(screen.getByTestId('status-acquisition-request')).toHaveTextContent('retry is searching');
  });

  it('does not offer retry after the provider retry budget is exhausted', async () => {
    requestMutate.mockImplementationOnce((_request: unknown, options: { onSuccess: (value: AcquisitionJob) => void }) => {
      options.onSuccess(job({ retryCount: 2, maxRetries: 2 }));
    });

    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByTestId('button-request-direct-acquisition'));

    expect(screen.getByTestId('text-acquisition-retry-budget')).toHaveTextContent('Retry limit reached');
    expect(screen.queryByTestId('button-retry-acquisition')).not.toBeInTheDocument();
    expect(retryMutate).not.toHaveBeenCalled();
  });
});
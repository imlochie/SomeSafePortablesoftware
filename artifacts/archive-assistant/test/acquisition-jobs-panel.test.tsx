/**
 * The acquisition surface exists because the backend ran a full job lifecycle
 * that no human could see. These tests hold it to the same standard as the
 * action review surface: report engine facts, never invent them, and be
 * explicit about what did *not* happen.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcquisitionJob } from '@workspace/api-client-react';

const mocks = vi.hoisted(() => ({
  jobs: { current: [] as AcquisitionJob[] },
  isLoading: { current: false },
  isError: { current: false },
  cancel: vi.fn(),
  retry: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('@workspace/api-client-react', () => ({
  useGetAcquisitionJobs: () => ({
    data: mocks.jobs.current,
    isLoading: mocks.isLoading.current,
    isError: mocks.isError.current,
    refetch: vi.fn(),
  }),
  useCancelAcquisitionJob: () => ({ mutate: mocks.cancel, isPending: false }),
  useRetryAcquisitionJob: () => ({ mutate: mocks.retry, isPending: false }),
  useRefreshAcquisitionJob: () => ({ mutate: mocks.refresh, isPending: false }),
  getGetAcquisitionJobsQueryKey: () => ['acquisition-jobs'],
}));

const { AcquisitionJobsPanel } = await import('../src/components/acquisition-jobs-panel');

function job(overrides: Partial<AcquisitionJob> = {}): AcquisitionJob {
  return {
    id: 1,
    ownerId: 'owner',
    mediaType: 'tv',
    title: 'Example Show',
    year: 2019,
    externalId: null,
    sourceId: null,
    sourceUrl: null,
    providerId: null,
    providerJobId: null,
    providerReference: null,
    downloadJobId: null,
    state: 'downloading',
    progress: 45,
    retryCount: 0,
    maxRetries: 3,
    errorCode: null,
    errorMessage: null,
    request: {},
    metadata: {},
    plannedAt: '2026-01-01T00:00:00.000Z',
    searchingAt: '2026-01-01T00:01:00.000Z',
    sourceSelectedAt: '2026-01-01T00:02:00.000Z',
    downloadingAt: '2026-01-01T00:03:00.000Z',
    processingAt: null,
    verifyingAt: null,
    importingAt: null,
    completedAt: null,
    failedAt: null,
    cancelledAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:03:00.000Z',
    events: [
      { id: 1, fromState: null, toState: 'planned', detail: 'Acquisition request planned.', metadata: {}, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 2, fromState: 'planned', toState: 'searching', detail: 'Acquisition job moved to searching.', metadata: {}, createdAt: '2026-01-01T00:01:00.000Z' },
    ],
    ...overrides,
  } as AcquisitionJob;
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <AcquisitionJobsPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.jobs.current = [];
  mocks.isLoading.current = false;
  mocks.isError.current = false;
  vi.clearAllMocks();
});

describe('acquisition jobs panel', () => {
  it('makes an in-flight job visible instead of leaving it running in the dark', () => {
    mocks.jobs.current = [job()];
    renderPanel();
    expect(screen.getByTestId('badge-acquisition-state-1')).toHaveTextContent('DOWNLOADING');
    expect(screen.getByTestId('text-acquisition-progress-1')).toHaveTextContent('45% REPORTED');
    expect(screen.getByTestId('text-acquisition-count-active')).toHaveTextContent('1 ACTIVE');
  });

  it('says who the job is waiting on, so provider delay is not mistaken for inaction', () => {
    mocks.jobs.current = [job()];
    renderPanel();
    const narrative = screen.getByTestId('text-acquisition-narrative-1');
    expect(narrative).toHaveTextContent('waiting on the provider, not on you');
    // And it is honest that nothing has reached the archive yet.
    expect(narrative).toHaveTextContent('Nothing has entered the archive yet');
  });

  it('marks pipeline stages from recorded timestamps, not from the current state', () => {
    mocks.jobs.current = [job()];
    renderPanel();
    // Reached because the engine stamped them.
    expect(screen.getAllByTestId('stage-planned-reached').length).toBe(1);
    expect(screen.getAllByTestId('stage-downloading-reached').length).toBe(1);
    // Not reached: no timestamp, so the surface must not imply progress.
    expect(screen.getAllByTestId('stage-verifying-pending').length).toBe(1);
    expect(screen.getAllByTestId('stage-complete-pending').length).toBe(1);
  });

  it('shows the engine error verbatim and states that nothing was imported', () => {
    mocks.jobs.current = [job({
      state: 'failed',
      progress: 0,
      errorCode: 'NO_SOURCE',
      errorMessage: 'No usable source was found by the provider.',
      failedAt: '2026-01-01T00:04:00.000Z',
    })];
    renderPanel();
    const error = screen.getByTestId('text-acquisition-error-1');
    expect(error).toHaveTextContent('No usable source was found by the provider.');
    expect(error).toHaveTextContent('NOTHING WAS IMPORTED');
    expect(screen.getByTestId('text-acquisition-count-failed')).toHaveTextContent('1 NEEDS YOU');
  });

  it('only offers actions the job state actually permits', () => {
    mocks.jobs.current = [job()];
    const { unmount } = renderPanel();
    // Provider is working: asking for news makes sense, retrying does not.
    expect(screen.getByTestId('button-refresh-acquisition-1')).toBeInTheDocument();
    expect(screen.queryByTestId('button-retry-acquisition-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('button-cancel-acquisition-1')).toBeInTheDocument();
    unmount();

    mocks.jobs.current = [job({ state: 'complete', progress: 100, completedAt: '2026-01-01T00:09:00.000Z' })];
    renderPanel();
    // A finished job is finished: nothing to stop, nothing to chase.
    expect(screen.queryByTestId('button-cancel-acquisition-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('button-refresh-acquisition-1')).not.toBeInTheDocument();
  });

  it('offers a retry only after a failure, and cancel routes through the engine', async () => {
    const user = userEvent.setup();
    mocks.jobs.current = [job({ state: 'failed', errorMessage: 'Provider timed out.', failedAt: '2026-01-01T00:04:00.000Z' })];
    renderPanel();
    await user.click(screen.getByTestId('button-retry-acquisition-1'));
    expect(mocks.retry).toHaveBeenCalledWith({ id: 1 }, expect.anything());
  });

  it('keeps the full transition history one click away rather than on screen', async () => {
    const user = userEvent.setup();
    mocks.jobs.current = [job()];
    renderPanel();
    expect(screen.queryByTestId('list-acquisition-events-1')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('button-toggle-acquisition-events-1'));
    const events = screen.getByTestId('list-acquisition-events-1');
    expect(events).toHaveTextContent('Acquisition request planned.');
    expect(events).toHaveTextContent('PLANNED → SEARCHING');
  });

  it('explains the approval boundary when nothing is in flight', () => {
    renderPanel();
    expect(screen.getByTestId('panel-acquisition-jobs-empty'))
      .toHaveTextContent('Nothing reaches the archive without a reviewed import action');
  });

  it('refuses to invent job state when the read fails', () => {
    mocks.isError.current = true;
    renderPanel();
    expect(screen.getByTestId('panel-acquisition-jobs-error'))
      .toHaveTextContent('No job state is being guessed in the browser');
  });
});

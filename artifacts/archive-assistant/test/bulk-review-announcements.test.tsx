import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { bulkReviewMutate, bulkResponse } = vi.hoisted(() => ({
  bulkReviewMutate: vi.fn(),
  bulkResponse: {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    results: [] as Array<{ id: number; success: boolean; error?: string }>,
  },
}));

vi.mock('@workspace/api-client-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workspace/api-client-react')>();
  return {
    ...actual,
    getGetArchiveInventoryQueryKey: () => ['archive', 'inventory'],
    getGetArchiveScanQueryKey: () => ['archive', 'scan'],
    getGetArchiveRecordQueryKey: (id: number) => ['archive', 'record', id],
    useGetArchiveScan: () => ({
      data: {
        status: 'idle',
        activeFiles: 2,
        missingCount: 0,
        duplicateCount: 0,
        qualityConflictCount: 0,
        plexOnlyCount: 0,
      },
      isLoading: false,
    }),
    useGetArchiveInventory: () => ({
      data: {
        records: [
          {
            id: 101,
            filename: 'first.mkv',
            sizeBytes: 1024,
            scanStatus: 'present',
            qualityStatus: 'needs_review',
            reviewStatus: 'unresolved',
          },
          {
            id: 102,
            filename: 'second.mkv',
            sizeBytes: 2048,
            scanStatus: 'present',
            qualityStatus: 'needs_review',
            reviewStatus: 'unresolved',
          },
        ],
        plexOnly: [],
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useStartArchiveScan: () => ({ isPending: false, mutate: vi.fn() }),
    useUpdateArchiveRecordReviews: () => ({
      isPending: false,
      mutate: bulkReviewMutate,
    }),
  };
});

import { ArchivePage } from '../src/App';

function renderArchivePage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ArchivePage />
    </QueryClientProvider>,
  );
}

function setBulkResponse(response: {
  attempted: number;
  succeeded: number;
  failed: number;
  results: Array<{ id: number; success: boolean; error?: string }>;
}) {
  bulkResponse.attempted = response.attempted;
  bulkResponse.succeeded = response.succeeded;
  bulkResponse.failed = response.failed;
  bulkResponse.results = response.results;
  bulkReviewMutate.mockImplementationOnce(
    (_request: unknown, options: { onSuccess: (result: typeof bulkResponse) => void }) => {
      options.onSuccess(bulkResponse);
    },
  );
}

describe('bulk review announcements', () => {
  beforeEach(() => {
    bulkReviewMutate.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('announces a successful bulk review in the live status region', async () => {
    setBulkResponse({
      attempted: 1,
      succeeded: 1,
      failed: 0,
      results: [{ id: 101, success: true }],
    });
    const user = userEvent.setup();
    renderArchivePage();

    await user.click(screen.getByTestId('checkbox-archive-record-101'));
    await user.click(screen.getByTestId('button-bulk-reviewed'));

    const status = await screen.findByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('1 findings marked reviewed.');
    expect(screen.queryByTestId('bulk-review-failures')).not.toBeInTheDocument();
  });

  it('keeps failed records selected and exposes each failure id and error separately', async () => {
    setBulkResponse({
      attempted: 2,
      succeeded: 1,
      failed: 1,
      results: [
        { id: 101, success: true },
        { id: 102, success: false, error: 'Record is no longer a quality finding.' },
      ],
    });
    const user = userEvent.setup();
    renderArchivePage();

    await user.click(screen.getByTestId('checkbox-archive-record-101'));
    await user.click(screen.getByTestId('checkbox-archive-record-102'));
    await user.click(screen.getByTestId('button-bulk-reviewed'));

    await waitFor(() => {
      expect(screen.getByTestId('checkbox-archive-record-101')).not.toBeChecked();
      expect(screen.getByTestId('checkbox-archive-record-102')).toBeChecked();
    });
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('1 updated; 1 failed.');
    expect(screen.getByTestId('bulk-review-failure-id-102')).toHaveTextContent('Record #102');
    expect(screen.getByTestId('bulk-review-failure-error-102')).toHaveTextContent(
      'Record is no longer a quality finding.',
    );
  });
});
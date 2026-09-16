/**
 * The media identity view is where the product finally shows the world rather
 * than only the moments that need a mutation. Its central obligation is to
 * represent uncertainty honestly: the planner refuses to propose ambiguous
 * matches, and this surface has to say so instead of dropping them.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReconciliationReport, ReconciliationResult } from '@workspace/api-client-react';

const mocks = vi.hoisted(() => ({
  report: { current: null as ReconciliationReport | null },
  isLoading: { current: false },
  isError: { current: false },
}));

vi.mock('@workspace/api-client-react', () => ({
  useGetArchiveReconciliation: () => ({
    data: mocks.report.current,
    isLoading: mocks.isLoading.current,
    isError: mocks.isError.current,
    refetch: vi.fn(),
  }),
}));

const { MediaIdentityView } = await import('../src/components/media-identity-view');

function localItem(path: string) {
  return {
    fileRecordId: 1,
    localMediaIdentityId: 1,
    path: `/archive/${path}`,
    relativePath: path,
    volumeId: null,
    archiveRoot: null,
    mediaType: 'tv',
    identity: null,
    scanStatus: 'active',
  };
}

function plexItem(title: string, ratingKey: string) {
  return {
    id: 1,
    ratingKey,
    libraryId: 1,
    libraryName: 'TV Shows',
    title,
    year: 2019,
    itemType: 'episode',
    identity: null,
  };
}

function report(results: Partial<ReconciliationResult>[]): ReconciliationReport {
  const full = results.map((entry) => ({
    classification: 'matched',
    matchingStrategy: 'tv_show_season_episode',
    candidateCount: 1,
    local: null,
    plex: null,
    ambiguityCandidates: [],
    quality: { status: 'equivalent_available_metadata', differences: [] },
    ...entry,
  })) as ReconciliationResult[];
  return {
    summary: {
      localCount: full.filter((entry) => entry.local).length,
      plexCount: full.filter((entry) => entry.plex).length,
      matchedCount: full.filter((entry) => entry.classification === 'matched').length,
      localOnlyCount: full.filter((entry) => entry.classification === 'local_only').length,
      plexOnlyCount: full.filter((entry) => entry.classification === 'plex_only').length,
      uncertainCount: full.filter((entry) => entry.classification === 'uncertain').length,
      duplicateCount: 0,
      qualityConflictCount: full.filter((entry) => entry.classification === 'quality_conflict').length,
    },
    pagination: { page: 1, pageSize: 100, total: full.length, totalPages: 1 },
    results: full,
  } as ReconciliationReport;
}

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MediaIdentityView />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.report.current = report([]);
  mocks.isLoading.current = false;
  mocks.isError.current = false;
  vi.clearAllMocks();
});

describe('media identity view', () => {
  it('shows both observations of one item side by side', () => {
    mocks.report.current = report([
      { local: localItem('Example Show/S01E01.mkv'), plex: plexItem('Pilot', 'plex-e1') },
    ]);
    renderView();
    expect(screen.getByTestId('text-identity-local-0')).toHaveTextContent('Example Show/S01E01.mkv');
    expect(screen.getByTestId('text-identity-plex-0')).toHaveTextContent('Pilot (2019)');
    expect(screen.getByTestId('badge-identity-classification-0')).toHaveTextContent('MATCHED');
  });

  it('surfaces ambiguous findings instead of dropping them, and names the candidates', () => {
    mocks.report.current = report([{
      classification: 'uncertain',
      matchingStrategy: 'ambiguous',
      candidateCount: 2,
      local: localItem('Example Show/S01E03.mkv'),
      plex: null,
      ambiguityCandidates: [plexItem('The Signal', 'plex-e3'), plexItem('The Signal (Remux)', 'plex-dup')],
    }]);
    renderView();
    const panel = screen.getByTestId('panel-identity-ambiguity-0');
    // The refusal is explained, not hidden.
    expect(panel).toHaveTextContent('NOT OFFERED AS AN ACTION');
    expect(panel).toHaveTextContent('confirming one would be a guess');
    expect(panel).toHaveTextContent('The Signal (Remux)');
  });

  it('states plainly when one side of the world is missing', () => {
    mocks.report.current = report([
      { classification: 'local_only', matchingStrategy: 'no_match', candidateCount: 0, local: localItem('Orphan.mkv'), plex: null },
      { classification: 'plex_only', matchingStrategy: 'no_match', candidateCount: 0, local: null, plex: plexItem('Ghost Episode', 'plex-x') },
    ]);
    renderView();
    expect(screen.getByTestId('text-identity-plex-0')).toHaveTextContent('Plex does not list this item');
    expect(screen.getByTestId('text-identity-local-1')).toHaveTextContent('No archive file backs this item');
  });

  it('shows the evidence behind each relationship rather than asserting it', () => {
    mocks.report.current = report([
      { local: localItem('Example Show/S01E01.mkv'), plex: plexItem('Pilot', 'plex-e1') },
    ]);
    renderView();
    expect(screen.getByTestId('text-identity-strategy-0')).toHaveTextContent('EVIDENCE / TV SHOW SEASON EPISODE');
  });

  it('filters the world without inventing counts', async () => {
    const user = userEvent.setup();
    mocks.report.current = report([
      { local: localItem('a.mkv'), plex: plexItem('A', 'a') },
      { classification: 'uncertain', matchingStrategy: 'ambiguous', candidateCount: 2, local: localItem('b.mkv'), plex: null },
    ]);
    renderView();
    expect(screen.getAllByTestId(/^row-media-identity-/).length).toBe(2);
    await user.click(screen.getByTestId('button-identity-filter-uncertain'));
    const rows = screen.getAllByTestId(/^row-media-identity-/);
    expect(rows.length).toBe(1);
    expect(screen.getByTestId('badge-identity-classification-0')).toHaveTextContent('AMBIGUOUS');
  });

  it('reports quality differences concretely', () => {
    mocks.report.current = report([{
      classification: 'quality_conflict',
      local: localItem('Example Show/S01E01.mkv'),
      plex: plexItem('Pilot', 'plex-e1'),
      quality: { status: 'metadata_conflict', differences: ['resolution', 'duration'] },
    }]);
    renderView();
    expect(screen.getByTestId('text-identity-differences-0')).toHaveTextContent('Differs on: resolution, duration.');
  });

  it('never claims understanding changes anything on its own', () => {
    mocks.report.current = report([
      { local: localItem('a.mkv'), plex: plexItem('A', 'a') },
    ]);
    renderView();
    expect(screen.getByTestId('panel-media-identity'))
      .toHaveTextContent('nothing here changes a file or a record until you approve an action');
  });

  it('refuses to infer relationships when the read fails', () => {
    mocks.isError.current = true;
    renderView();
    expect(screen.getByTestId('panel-media-identity-error'))
      .toHaveTextContent('No relationships are being inferred in the browser');
  });
});

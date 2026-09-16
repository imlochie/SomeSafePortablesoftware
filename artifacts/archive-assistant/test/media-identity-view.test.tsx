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
import type {
  IdentityAuditReport,
  IdentityAuditResult,
  ReconciliationReport,
  ReconciliationResult,
} from '@workspace/api-client-react';

const mocks = vi.hoisted(() => ({
  report: { current: null as ReconciliationReport | null },
  isLoading: { current: false },
  isError: { current: false },
  audit: { current: null as IdentityAuditReport | null },
  auditLoading: { current: false },
  auditError: { current: false },
}));

vi.mock('@workspace/api-client-react', () => ({
  useGetArchiveReconciliation: () => ({
    data: mocks.report.current,
    isLoading: mocks.isLoading.current,
    isError: mocks.isError.current,
    refetch: vi.fn(),
  }),
  useGetArchiveIdentityAudit: () => ({
    data: mocks.audit.current,
    isLoading: mocks.auditLoading.current,
    isError: mocks.auditError.current,
    refetch: vi.fn(),
  }),
}));

const { MediaIdentityView } = await import('../src/components/media-identity-view');

function localItem(path: string, fileRecordId = 1) {
  return {
    fileRecordId,
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

function auditResult(entry: Partial<IdentityAuditResult> = {}): IdentityAuditResult {
  return {
    fileRecordId: 1,
    path: '/archive/Example Show/S01E01.mkv',
    currentLocalIdentity: null,
    extractedCandidates: [],
    plexCandidates: [],
    reason: 'The durable identity title differs from the title extracted from the current path.',
    auditType: 'title_conflict',
    confidence: 'high',
    evidence: ['identity title: the signal', 'extracted titles: the signal s01e03'],
    recommendedInterpretation: 'Review the durable identity and path-derived title before changing either.',
    needsReview: true,
    mediaType: 'tv',
    ...entry,
  } as IdentityAuditResult;
}

function auditReport(results: IdentityAuditResult[]): IdentityAuditReport {
  return {
    summary: { totalCandidates: results.length, byAuditType: {}, byConfidence: {} },
    pagination: { page: 1, pageSize: 200, total: results.length, totalPages: 1 },
    results,
  } as IdentityAuditReport;
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
  mocks.audit.current = auditReport([]);
  mocks.auditLoading.current = false;
  mocks.auditError.current = false;
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

  /*
    The identity audit is folded into this view rather than living at its own
    URL. These tests hold the fold-in to the same standard as the rest of the
    surface: engine text only, and no implied verdict.
  */
  it('attaches an audit concern to the file it describes', () => {
    mocks.report.current = report([
      { classification: 'local_only', local: localItem('Example Show/S01E01.mkv', 7), plex: null },
    ]);
    mocks.audit.current = auditReport([auditResult({ fileRecordId: 7 })]);
    renderView();
    expect(screen.getByTestId('panel-identity-audit-0')).toHaveTextContent('1 CONCERN');
    expect(screen.getByTestId('badge-identity-audit-type-0-0')).toHaveTextContent('TITLE DISAGREES');
    expect(screen.getByTestId('row-identity-audit-0-0')).toHaveTextContent(
      'The durable identity title differs from the title extracted from the current path.',
    );
  });

  it('does not annotate a file the audit did not flag', () => {
    mocks.report.current = report([
      { classification: 'local_only', local: localItem('Example Show/S01E01.mkv', 7), plex: null },
    ]);
    mocks.audit.current = auditReport([auditResult({ fileRecordId: 999 })]);
    renderView();
    expect(screen.queryByTestId('panel-identity-audit-0')).toBeNull();
  });

  it('shows the engine evidence verbatim rather than a summary of it', () => {
    mocks.report.current = report([
      { classification: 'local_only', local: localItem('a.mkv', 7), plex: null },
    ]);
    mocks.audit.current = auditReport([
      auditResult({ fileRecordId: 7, evidence: ['identity title: alpha', 'extracted titles: beta'] }),
    ]);
    renderView();
    const evidence = screen.getByTestId('list-identity-audit-evidence-0-0');
    expect(evidence).toHaveTextContent('identity title: alpha');
    expect(evidence).toHaveTextContent('extracted titles: beta');
  });

  it('lists every concern when one file raises several', () => {
    mocks.report.current = report([
      { classification: 'local_only', local: localItem('a.mkv', 7), plex: null },
    ]);
    mocks.audit.current = auditReport([
      auditResult({ fileRecordId: 7, auditType: 'title_conflict' }),
      auditResult({ fileRecordId: 7, auditType: 'missing_year', confidence: 'medium' }),
    ]);
    renderView();
    expect(screen.getByTestId('panel-identity-audit-0')).toHaveTextContent('2 CONCERNS');
    expect(screen.getByTestId('badge-identity-audit-type-0-1')).toHaveTextContent('NO YEAR');
  });

  /*
    needsReview: false is the engine saying the evidence already settled it.
    Marking that as something to review would manufacture work.
  */
  it('marks a corroborated finding as resolved rather than pending', () => {
    mocks.report.current = report([
      { classification: 'local_only', local: localItem('a.mkv', 7), plex: null },
    ]);
    mocks.audit.current = auditReport([
      auditResult({ fileRecordId: 7, auditType: 'numeric_title', needsReview: false }),
    ]);
    renderView();
    expect(screen.getByTestId('row-identity-audit-0-0')).toHaveTextContent('RESOLVED BY EVIDENCE');
    expect(screen.getByTestId('text-identity-audit-summary')).toHaveTextContent('all resolved by evidence');
  });

  it('counts only findings the engine flagged for review', () => {
    mocks.report.current = report([
      { classification: 'local_only', local: localItem('a.mkv', 7), plex: null },
    ]);
    mocks.audit.current = auditReport([
      auditResult({ fileRecordId: 7 }),
      auditResult({ fileRecordId: 7, auditType: 'numeric_title', needsReview: false }),
    ]);
    renderView();
    expect(screen.getByTestId('text-identity-audit-summary')).toHaveTextContent('1 concern');
    expect(screen.getByTestId('text-identity-audit-summary')).toHaveTextContent('across 1 file');
  });

  it('filters to the files that need an identity review', async () => {
    mocks.report.current = report([
      { classification: 'local_only', local: localItem('flagged.mkv', 7), plex: null },
      { classification: 'local_only', local: localItem('clean.mkv', 8), plex: null },
    ]);
    mocks.audit.current = auditReport([auditResult({ fileRecordId: 7 })]);
    renderView();
    await userEvent.click(screen.getByTestId('button-identity-filter-concerns'));
    expect(screen.getByTestId('list-media-identity').textContent).toContain('flagged.mkv');
    expect(screen.getByTestId('list-media-identity').textContent).not.toContain('clean.mkv');
  });

  it('says so plainly when the audit found nothing', () => {
    mocks.report.current = report([
      { classification: 'local_only', local: localItem('a.mkv', 7), plex: null },
    ]);
    mocks.audit.current = auditReport([]);
    renderView();
    expect(screen.getByTestId('panel-identity-audit-clean')).toHaveTextContent('No identity problems found');
  });

  /*
    A failed audit must degrade the annotation, never the identity picture.
    Silently dropping it would let the view imply a clean audit that never ran.
  */
  it('keeps showing the world when the audit cannot be read', () => {
    mocks.report.current = report([
      { classification: 'local_only', local: localItem('a.mkv', 7), plex: null },
    ]);
    mocks.audit.current = null;
    mocks.auditError.current = true;
    renderView();
    expect(screen.getByTestId('panel-identity-audit-unavailable')).toHaveTextContent('could not be read');
    expect(screen.queryByTestId('panel-identity-audit-clean')).toBeNull();
    expect(screen.getByTestId('list-media-identity')).toHaveTextContent('a.mkv');
  });

  it('does not offer a fix from a read-only audit', () => {
    mocks.report.current = report([
      { classification: 'local_only', local: localItem('a.mkv', 7), plex: null },
    ]);
    mocks.audit.current = auditReport([auditResult({ fileRecordId: 7 })]);
    renderView();
    const panel = screen.getByTestId('panel-identity-audit-0');
    expect(panel).toHaveTextContent('Reading the evidence changed nothing.');
    expect(panel.querySelectorAll('button')).toHaveLength(0);
  });
});

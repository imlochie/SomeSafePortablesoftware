import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionProposal, ActionStep } from '@workspace/api-client-react';

// Hoisted so the vi.mock factory below can reference these safely.
const mocks = vi.hoisted(() => ({
  approveMutate: vi.fn(),
  executeMutate: vi.fn(),
  selectionMutate: vi.fn(),
  preflightMutate: vi.fn(),
  revertMutate: vi.fn(),
  cancelMutate: vi.fn(),
  retryMutate: vi.fn(),
  proposal: { current: null as ActionProposal | null },
}));
const { approveMutate, executeMutate, selectionMutate, preflightMutate } = mocks;

vi.mock('@workspace/api-client-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workspace/api-client-react')>();
  const mutation = (mutate: unknown) => () => ({ mutate, isPending: false });
  return {
    ...actual,
    getGetActionProposalQueryKey: (id: number) => ['action-proposal', id],
    getListActionProposalsQueryKey: () => ['action-proposals'],
    useGetActionProposal: () => ({
      data: mocks.proposal.current,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useUpdateActionStepSelection: mutation(mocks.selectionMutate),
    useApproveActionProposal: mutation(mocks.approveMutate),
    usePreflightActionProposal: mutation(mocks.preflightMutate),
    useExecuteActionProposal: mutation(mocks.executeMutate),
    useRevertActionProposal: mutation(mocks.revertMutate),
    useCancelActionProposal: mutation(mocks.cancelMutate),
    useRetryActionProposal: mutation(mocks.retryMutate),
  };
});

import { ActionProposalReview } from '../src/components/action-proposal-review';

function step(overrides: Partial<ActionStep> & { id: number; stepIndex: number }): ActionStep {
  return {
    proposalId: 7,
    type: 'rename',
    status: 'pending',
    selected: true,
    summary: 'before.mkv → after.mkv',
    target: { kind: 'file_record', id: String(overrides.id), path: null, label: null },
    before: { path: '/archive/Show/Season 01/01 - foo.mkv', filename: '01 - foo.mkv' },
    after: { path: '/archive/Show/Season 01/01 - Foo.mkv', filename: '01 - Foo.mkv' },
    preflight: {},
    execution: {},
    verification: {},
    revert: {},
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function proposal(overrides: Partial<ActionProposal> = {}): ActionProposal {
  const steps = overrides.steps ?? [
    step({ id: 101, stepIndex: 0 }),
    step({
      id: 102,
      stepIndex: 1,
      before: { path: '/archive/Show/Season 01/02 - bar.mkv', filename: '02 - bar.mkv' },
      after: { path: '/archive/Show/Season 01/02 - Bar.mkv', filename: '02 - Bar.mkv' },
    }),
  ];
  const selected = steps.filter((entry) => entry.selected).length;
  // Mirror how the engine derives revert availability so a fixture cannot
  // describe a state the real backend would never produce.
  const counts = overrides.counts
    ?? { total: steps.length, selected, pending: selected, completed: 0, failed: 0, skipped: steps.length - selected, reverted: 0 };
  const completedSteps = counts.completed;
  return {
    id: 7,
    proposalKey: 'key',
    type: 'rename',
    reversibility: {
      kind: 'conditional',
      strategy: 'Rename the file back to its original name.',
      explanation: 'The original name can be restored as long as nothing else has taken it.',
      conditions: ['The original path is still free'],
      available: completedSteps > 0,
      revertableSteps: completedSteps,
      blockedReason: completedSteps > 0 ? null : 'Nothing has been applied yet, so there is nothing to undo.',
      ...(overrides.reversibility ?? {}),
    },
    source: 'naming_intelligence',
    reason: 'Normalize 2 inconsistent filenames.',
    status: 'proposed',
    risk: 'low',
    requiresApproval: true,
    dryRun: false,
    allowCreateDirectories: false,
    reviewItemId: null,
    acquisitionJobId: null,
    downloadJobId: null,
    planHash: 'hash',
    target: { kind: 'archive_naming', id: null, path: null, label: '2 file(s)' },
    evidence: { inspected: 37, actionable: 2, skipped: 35, patterns: ['directory_show_season_episode_number'] },
    approval: {},
    preflight: {},
    execution: {},
    verification: {},
    revert: {},
    postflight: {},
    retryCount: 0,
    maxRetries: 3,
    errorCode: null,
    errorMessage: null,
    counts,
    steps,
    events: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    approvedAt: null,
    executedAt: null,
    completedAt: null,
    cancelledAt: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderReview() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ActionProposalReview proposalId={7} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.proposal.current = proposal();
});

describe('action proposal review surface', () => {
  it('shows what is changing as an explicit before → after mapping', () => {
    renderReview();
    expect(screen.getByText('OLD NAME')).toBeInTheDocument();
    expect(screen.getByText('NEW NAME')).toBeInTheDocument();
    expect(screen.getByTestId('text-step-before-101')).toHaveTextContent('01 - foo.mkv');
    expect(screen.getByTestId('text-step-after-101')).toHaveTextContent('01 - Foo.mkv');
    expect(screen.getByTestId('text-step-before-102')).toHaveTextContent('02 - bar.mkv');
    expect(screen.getByTestId('text-step-after-102')).toHaveTextContent('02 - Bar.mkv');
    // The full path stays available as the proof behind the friendly name.
    expect(screen.getByTitle('/archive/Show/Season 01/01 - foo.mkv')).toBeInTheDocument();
  });

  it('shows why it is changing using planner evidence', () => {
    renderReview();
    const evidence = screen.getByTestId('panel-action-evidence');
    expect(evidence).toHaveTextContent('INSPECTED 37');
    expect(evidence).toHaveTextContent('ACTIONABLE 2');
    expect(evidence).toHaveTextContent('directory_show_season_episode_number');
  });

  it('states the bounded scope of what is being authorized', () => {
    renderReview();
    expect(screen.getByTestId('text-action-selected-count')).toHaveTextContent('2 / 2');
    expect(screen.getByTestId('text-action-authorization-scope'))
      .toHaveTextContent('authorizes exactly the 2 selected changes listed above — not future renames');
    expect(screen.getByTestId('button-approve-action-proposal')).toHaveTextContent('APPROVE 2 SELECTED');
    expect(screen.getByTestId('text-action-footer-contract'))
      .toHaveTextContent('NO FILESYSTEM ACTION UNTIL APPROVED, PREFLIGHTED, AND CONFIRMED');
  });

  it('lets the operator deselect a single step before approving', async () => {
    renderReview();
    await userEvent.setup().click(screen.getByTestId('checkbox-action-step-102'));
    expect(selectionMutate).toHaveBeenCalledWith(
      { id: 7, data: { selections: [{ stepId: 102, selected: false }] } },
      expect.anything(),
    );
  });

  it('reflects a partially selected plan in the approval scope', () => {
    mocks.proposal.current = proposal({
      steps: [
        step({ id: 101, stepIndex: 0 }),
        step({ id: 102, stepIndex: 1, selected: false, status: 'skipped' }),
      ],
    });
    renderReview();
    expect(screen.getByTestId('text-action-selected-count')).toHaveTextContent('1 / 2');
    expect(screen.getByTestId('button-approve-action-proposal')).toHaveTextContent('APPROVE 1 SELECTED');
    expect(screen.getByTestId('badge-step-status-102')).toHaveTextContent('SKIPPED');
    // The still-selected row states its intent rather than rendering blank.
    expect(screen.getByTestId('badge-step-status-101')).toHaveTextContent('WILL RENAME');
  });

  it('marks a deselected step as excluded rather than leaving it ambiguous', async () => {
    renderReview();
    expect(screen.getByTestId('badge-step-status-101')).toHaveTextContent('WILL RENAME');
    mocks.proposal.current = proposal({
      steps: [step({ id: 101, stepIndex: 0 }), step({ id: 102, stepIndex: 1, selected: false })],
    });
    renderReview();
    expect(screen.getAllByTestId('badge-step-status-102')[1]).toHaveTextContent('EXCLUDED');
  });

  it('does not offer preflight or execute before approval', () => {
    renderReview();
    expect(screen.queryByTestId('button-preflight-action-proposal')).not.toBeInTheDocument();
    expect(screen.queryByTestId('button-execute-action-proposal')).not.toBeInTheDocument();
  });

  it('offers preflight after approval and states that nothing is written yet', () => {
    mocks.proposal.current = proposal({ status: 'approved', approvedAt: '2026-01-02T00:00:00.000Z', reviewItemId: 3 });
    renderReview();
    expect(screen.getByTestId('text-action-approval')).toHaveTextContent('RECORDED');
    expect(screen.getByTestId('button-preflight-action-proposal')).toBeInTheDocument();
    expect(screen.queryByTestId('button-execute-action-proposal')).not.toBeInTheDocument();
    expect(screen.getByTestId('text-action-narrative')).toHaveTextContent('No file has been touched');
  });

  it('requires a second explicit confirmation before executing', async () => {
    mocks.proposal.current = proposal({
      status: 'ready',
      approvedAt: '2026-01-02T00:00:00.000Z',
      preflight: { passed: 2, failed: 0 },
      steps: [step({ id: 101, stepIndex: 0, status: 'ready' }), step({ id: 102, stepIndex: 1, status: 'ready' })],
    });
    renderReview();
    const user = userEvent.setup();

    expect(screen.getByTestId('text-action-preflight')).toHaveTextContent('2 PASSED / 0 FAILED');
    await user.click(screen.getByTestId('button-execute-action-proposal'));
    // First click only reveals the confirmation; it must not execute.
    expect(executeMutate).not.toHaveBeenCalled();
    expect(within(screen.getByTestId('panel-confirm-execute')).getByText(/Write 2 verified changes/)).toBeInTheDocument();

    await user.click(screen.getByTestId('button-confirm-execute-action-proposal'));
    expect(executeMutate).toHaveBeenCalledWith({ id: 7, data: { confirmed: true } }, expect.anything());
  });

  it('tells the operator the story instead of dumping engine vocabulary', () => {
    renderReview();
    const narrative = screen.getByTestId('text-action-narrative');
    expect(narrative).toHaveTextContent('inspected 37 files and prepared 2 changes');
    expect(narrative).toHaveTextContent('Nothing will be written until you approve the selected changes.');
    expect(screen.getByTestId('badge-action-stage')).toHaveTextContent('UNDER REVIEW');
  });

  it('runs preflight automatically once approval is recorded, without writing anything', () => {
    mocks.proposal.current = proposal({ status: 'approved', approvedAt: '2026-01-02T00:00:00.000Z' });
    renderReview();
    // Approval hands straight off into checking; execution still needs a human.
    expect(preflightMutate).toHaveBeenCalledWith({ id: 7 }, expect.anything());
    expect(executeMutate).not.toHaveBeenCalled();
    expect(screen.queryByTestId('button-execute-action-proposal')).not.toBeInTheDocument();
  });

  it('groups steps so exceptions are read first and bulk routine work collapses', () => {
    const many = Array.from({ length: 10 }, (_, index) =>
      step({ id: 200 + index, stepIndex: index }));
    mocks.proposal.current = proposal({
      status: 'ready',
      steps: [
        ...many,
        step({ id: 300, stepIndex: 10, status: 'failed', errorMessage: 'Destination collision detected.' }),
        step({ id: 301, stepIndex: 11, selected: false }),
      ],
    });
    renderReview();

    // The exception group is present and expanded by default...
    expect(screen.getByTestId('group-action-steps-blocked')).toHaveTextContent('1 NEEDS YOUR ATTENTION');
    expect(screen.getByTestId('text-step-error-300')).toBeInTheDocument();
    // ...while ten identical renames are compressed behind a count.
    expect(screen.getByTestId('group-action-steps-routine')).toHaveTextContent('10 STRAIGHTFORWARD');
    expect(screen.queryByTestId('row-action-step-200')).not.toBeInTheDocument();
    expect(screen.getByTestId('group-action-steps-excluded')).toHaveTextContent('1 EXCLUDED BY YOU');
  });

  it('expands a collapsed group on demand', async () => {
    const many = Array.from({ length: 10 }, (_, index) =>
      step({ id: 400 + index, stepIndex: index }));
    mocks.proposal.current = proposal({ steps: many });
    renderReview();
    expect(screen.queryByTestId('row-action-step-400')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByTestId('button-toggle-group-routine'));
    expect(screen.getByTestId('row-action-step-400')).toBeInTheDocument();
  });

  it('reports preflight as named reassurances rather than a status code', () => {
    mocks.proposal.current = proposal({
      status: 'ready',
      preflight: {
        passed: 2,
        failed: 0,
        results: [
          { stepId: 101, ok: true, sourceExists: true, destinationExists: false, destinationDirectoryMissing: false },
          { stepId: 102, ok: true, sourceExists: true, destinationExists: false, destinationDirectoryMissing: false },
        ],
      },
    });
    renderReview();
    const panel = screen.getByTestId('panel-preflight-checks');
    expect(panel).toHaveTextContent('Source files still exist');
    expect(panel).toHaveTextContent('Destinations are free (nothing overwritten)');
    expect(screen.getByTestId('check-source-exists')).toHaveTextContent('2/2');
    expect(screen.getByTestId('badge-action-stage')).toHaveTextContent('CHECKING');
  });

  it('flags a step that would create a new folder instead of hiding it in the crowd', () => {
    mocks.proposal.current = proposal({
      status: 'ready',
      steps: [
        step({ id: 101, stepIndex: 0 }),
        step({ id: 102, stepIndex: 1, preflight: { destinationDirectoryMissing: true } }),
      ],
    });
    renderReview();
    expect(screen.getByTestId('group-action-steps-newFolder')).toHaveTextContent('1 CREATES A NEW FOLDER');
    expect(screen.getByTestId('row-action-step-102')).toBeInTheDocument();
  });

  it('carries the originating finding into the review', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ActionProposalReview proposalId={7} context={{ eyebrow: 'FROM FINDING', headline: '37 naming inconsistencies' }} />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('text-action-origin')).toHaveTextContent('37 naming inconsistencies');
  });

  it('explains a withdrawn approval as a human story, not an error code', () => {
    mocks.proposal.current = proposal({
      status: 'failed',
      errorCode: 'PLAN_CHANGED',
      errorMessage: 'The proposal changed after approval; re-approval is required.',
    });
    renderReview();
    const narrative = screen.getByTestId('text-action-narrative');
    expect(narrative).toHaveTextContent('This plan changed after you approved it');
    expect(narrative).toHaveTextContent('Nothing was written.');
    // And the way forward is offered, not just the complaint.
    expect(screen.getByTestId('button-preflight-action-proposal')).toHaveTextContent('RE-CHECK');
  });

  // --- second action family -------------------------------------------------
  // reconcile records an identity link and touches no file. These assertions
  // exist to catch the review surface quietly assuming every action is a
  // rename, which is exactly what the first family could not reveal.

  function reconcileProposal(overrides: Partial<ActionProposal> = {}) {
    const steps: ActionStep[] = [
      {
        ...step({ id: 501, stepIndex: 0 }),
        type: 'reconcile',
        summary: 'Example Show/S01E01.mkv ⇄ Pilot (2019)',
        before: { fileRecordId: 501, label: 'Example Show/S01E01.mkv', path: '/archive/Example Show/S01E01.mkv', linked: false },
        after: { ratingKey: 'plex-1', label: 'Pilot (2019)', title: 'Pilot (2019)', library: 'TV Shows', linked: true },
      },
    ];
    return proposal({
      type: 'reconcile',
      source: 'reconciliation',
      reason: 'Confirm 1 archive-to-Plex identity link.',
      steps,
      counts: { total: 1, selected: 1, pending: 1, completed: 0, failed: 0, skipped: 0, reverted: 0 },
      ...overrides,
    });
  }

  it('renders a record action with identity columns, not filename columns', () => {
    mocks.proposal.current = reconcileProposal();
    renderReview();
    expect(screen.getByText('LOCAL FILE')).toBeInTheDocument();
    expect(screen.getByText('PLEX ITEM')).toBeInTheDocument();
    expect(screen.queryByText('OLD NAME')).not.toBeInTheDocument();
    // The Plex side has no path, so the planner's label carries the identity.
    expect(screen.getByTestId('text-step-after-501')).toHaveTextContent('Pilot (2019)');
    expect(screen.getByTestId('text-step-before-501')).toHaveTextContent('Example Show/S01E01.mkv');
  });

  it('does not strike through the local file, because nothing is replaced', () => {
    mocks.proposal.current = reconcileProposal();
    renderReview();
    expect(screen.getByTestId('text-step-before-501').className).not.toContain('line-through');
  });

  it('never claims a record action writes to disk', () => {
    mocks.proposal.current = reconcileProposal();
    renderReview();
    expect(screen.getByTestId('text-action-narrative')).toHaveTextContent('Nothing will be recorded until you approve');
    expect(screen.getByTestId('text-action-authorization-scope'))
      .toHaveTextContent('not future identity links');
    expect(screen.getByTestId('text-action-footer-contract'))
      .toHaveTextContent('NO RECORD CHANGE UNTIL APPROVED');
    expect(screen.getByTestId('button-approve-action-proposal')).toHaveTextContent('APPROVE 1 SELECTED');
  });

  it('confirms a record action without promising a filesystem write', async () => {
    mocks.proposal.current = reconcileProposal({
      status: 'ready',
      approvedAt: '2026-01-02T00:00:00.000Z',
      preflight: { passed: 1, failed: 0 },
      steps: [{ ...reconcileProposal().steps[0], status: 'ready' }],
    });
    renderReview();
    await userEvent.setup().click(screen.getByTestId('button-execute-action-proposal'));
    const panel = screen.getByTestId('panel-confirm-execute');
    expect(panel).toHaveTextContent('Record 1 verified link now?');
    expect(panel).toHaveTextContent('no file on disk is modified');
  });

  it('reports preflight for a record action in record vocabulary', () => {
    mocks.proposal.current = reconcileProposal({
      status: 'ready',
      preflight: {
        passed: 1,
        failed: 0,
        results: [{ stepId: 501, ok: true, sourceExists: true, alreadyLinked: false }],
      },
    });
    renderReview();
    const panel = screen.getByTestId('panel-preflight-checks');
    expect(panel).toHaveTextContent('Both records still exist');
    expect(panel).toHaveTextContent('Neither side is already claimed by another link');
    // A folder-writability check would be meaningless here.
    expect(panel).not.toHaveTextContent('Destination folders are writable');
  });

  it('surfaces a withdrawn approval as a blocking reason instead of failing silently', () => {
    mocks.proposal.current = proposal({
      status: 'failed',
      errorCode: 'PLAN_CHANGED',
      errorMessage: 'The proposal changed after approval; re-approval is required.',
    });
    renderReview();
    const error = screen.getByTestId('text-action-error');
    expect(error).toHaveTextContent('The proposal changed after approval');
    expect(error).toHaveTextContent('must be approved again');
    // Execution must not be reachable from a withdrawn approval.
    expect(screen.queryByTestId('button-execute-action-proposal')).not.toBeInTheDocument();
    // And the footer must not imply work was recorded when nothing ran.
    expect(screen.getByTestId('text-action-footer-contract'))
      .toHaveTextContent('STOPPED BEFORE EXECUTION / NO CHANGES APPLIED');
  });

  it('does not claim history was written for a cancelled proposal', () => {
    mocks.proposal.current = proposal({ status: 'cancelled', cancelledAt: '2026-01-02T00:00:00.000Z' });
    renderReview();
    expect(screen.getByTestId('text-action-footer-contract'))
      .toHaveTextContent('CANCELLED / NO CHANGES APPLIED');
  });

  it('keeps uppercase labels uppercase when pluralising', () => {
    mocks.proposal.current = proposal({
      status: 'completed',
      counts: { total: 2, selected: 2, pending: 0, completed: 2, failed: 0, skipped: 0, reverted: 0 },
      steps: [step({ id: 101, stepIndex: 0, status: 'completed' }), step({ id: 102, stepIndex: 1, status: 'completed' })],
    });
    renderReview();
    const footer = screen.getByTestId('text-action-footer-contract');
    expect(footer).toHaveTextContent('2 CHANGES APPLIED');
    expect(footer.textContent).not.toMatch(/CHANGEs/);
  });

  it('reports verified results and offers revert once the work is recorded', () => {
    mocks.proposal.current = proposal({
      status: 'completed',
      approvedAt: '2026-01-02T00:00:00.000Z',
      executedAt: '2026-01-02T00:05:00.000Z',
      completedAt: '2026-01-02T00:05:02.000Z',
      verification: { total: 2, verified: 2, failed: 0 },
      counts: { total: 2, selected: 2, pending: 0, completed: 2, failed: 0, skipped: 0, reverted: 0 },
      steps: [step({ id: 101, stepIndex: 0, status: 'completed' }), step({ id: 102, stepIndex: 1, status: 'completed' })],
    });
    renderReview();
    expect(screen.getByTestId('text-action-verified')).toHaveTextContent('2 / 2');
    expect(screen.getByTestId('button-revert-action-proposal')).toBeInTheDocument();
    expect(screen.queryByTestId('button-approve-action-proposal')).not.toBeInTheDocument();
    // The applied rows are the result — visible without hunting for them.
    expect(screen.getByTestId('group-action-steps-done')).toHaveTextContent('2 APPLIED');
    expect(screen.getByTestId('row-action-step-101')).toBeInTheDocument();
  });

  it('shows per-step failure detail for a partially completed plan', () => {
    mocks.proposal.current = proposal({
      status: 'partially_completed',
      verification: { total: 2, verified: 1, failed: 1 },
      counts: { total: 2, selected: 2, pending: 0, completed: 1, failed: 1, skipped: 0, reverted: 0 },
      steps: [
        step({ id: 101, stepIndex: 0, status: 'completed' }),
        step({ id: 102, stepIndex: 1, status: 'failed', errorMessage: 'Source file no longer exists.' }),
      ],
    });
    renderReview();
    expect(screen.getByTestId('text-action-verified')).toHaveTextContent('1 / 2');
    expect(screen.getByTestId('text-step-error-102')).toHaveTextContent('Source file no longer exists.');
    // Revert is still offered, and it is scoped to what actually completed.
    expect(screen.getByTestId('button-revert-action-proposal')).toBeInTheDocument();
  });

  /* ------------------------------------------------- reversibility honesty -- */

  it('states conditional reversibility before approval, not after', () => {
    mocks.proposal.current = proposal();
    renderReview();
    const panel = screen.getByTestId('panel-action-reversibility');
    expect(panel).toHaveTextContent('REVERSIBLE — WITH CONDITIONS');
    // The caveat itself, not a bare "you can undo this".
    expect(panel).toHaveTextContent('as long as nothing else has taken it');
  });

  it('never promises an undo for a one-way action', async () => {
    const user = userEvent.setup();
    mocks.proposal.current = proposal({
      type: 'delete',
      status: 'ready',
      reversibility: {
        kind: 'irreversible',
        strategy: null,
        explanation: 'Deleted bytes cannot be brought back by this engine.',
        conditions: [],
        available: false,
        revertableSteps: 0,
        blockedReason: 'This action cannot be undone by Archive Assistant.',
      },
      preflight: { checkedAt: 'now', steps: 2, passed: 2, failed: 0 },
    });
    renderReview();

    await user.click(screen.getByTestId('button-execute-action-proposal'));
    const confirm = screen.getByTestId('panel-confirm-execute');
    // The decisive moment must carry the warning, not a reassurance.
    expect(confirm).toHaveTextContent('cannot be undone');
    expect(confirm).not.toHaveTextContent('can be undone afterwards');
    expect(confirm.textContent).not.toMatch(/proposal can be reverted/i);
  });

  it('withdraws the revert button when the engine says a revert is unavailable', () => {
    mocks.proposal.current = proposal({
      type: 'delete',
      status: 'completed',
      verification: { total: 2, verified: 2, failed: 0 },
      counts: { total: 2, selected: 2, pending: 0, completed: 2, failed: 0, skipped: 0, reverted: 0 },
      steps: [step({ id: 101, stepIndex: 0, status: 'completed' }), step({ id: 102, stepIndex: 1, status: 'completed' })],
      reversibility: {
        kind: 'irreversible',
        strategy: null,
        explanation: 'Deleted bytes cannot be brought back by this engine.',
        conditions: [],
        available: false,
        revertableSteps: 0,
        blockedReason: 'This action cannot be undone by Archive Assistant.',
      },
    });
    renderReview();
    // Completed with 2 applied steps — the old surface inferred revert purely
    // from that status and would have offered an impossible undo here.
    expect(screen.getByTestId('text-action-verified')).toHaveTextContent('2 / 2');
    expect(screen.queryByTestId('button-revert-action-proposal')).not.toBeInTheDocument();
  });

  it('describes the undo using the engine strategy rather than assuming file paths', async () => {
    const user = userEvent.setup();
    mocks.proposal.current = reconcileProposal({
      status: 'completed',
      verification: { total: 2, verified: 2, failed: 0 },
      counts: { total: 2, selected: 2, pending: 0, completed: 2, failed: 0, skipped: 0, reverted: 0 },
      reversibility: {
        kind: 'reversible',
        strategy: 'Remove the recorded link, or restore the link that existed before.',
        explanation: 'The link is a record this engine owns, so undoing it restores the exact prior state.',
        conditions: [],
        available: true,
        revertableSteps: 2,
        blockedReason: null,
      },
    });
    renderReview();
    await user.click(screen.getByTestId('button-revert-action-proposal'));
    const panel = screen.getByTestId('panel-confirm-revert');
    expect(panel).toHaveTextContent('Remove the recorded link');
    // The old copy claimed every revert "restores the original paths".
    expect(panel.textContent).not.toMatch(/original paths/i);
  });

  /* -------------------------------------------------------- loop closure -- */

  it('reports what the engine did after the action, only where it recorded doing it', () => {
    mocks.proposal.current = proposal({
      status: 'completed',
      verification: { total: 2, verified: 2, failed: 0 },
      counts: { total: 2, selected: 2, pending: 0, completed: 2, failed: 0, skipped: 0, reverted: 0 },
      steps: [step({ id: 101, stepIndex: 0, status: 'completed' }), step({ id: 102, stepIndex: 1, status: 'completed' })],
      postflight: {
        status: 'completed',
        errors: [],
        archiveScan: { status: 'completed', scannedFiles: 12 },
        plex: { configured: true, attempted: true, status: 'idle' },
        reconciliation: { summary: { matchedCount: 9 } },
      },
    });
    renderReview();
    const panel = screen.getByTestId('panel-action-loop-closure');
    expect(panel).toHaveTextContent('The archive was re-scanned (12 files seen).');
    expect(panel).toHaveTextContent('Plex was refreshed.');
    expect(panel).toHaveTextContent('9 items still line up with Plex');
    expect(screen.getByTestId('text-action-nothing-pending')).toHaveTextContent('Nothing else needs your attention');
  });

  it('does not claim a Plex sync that never happened', () => {
    mocks.proposal.current = proposal({
      status: 'completed',
      counts: { total: 1, selected: 1, pending: 0, completed: 1, failed: 0, skipped: 0, reverted: 0 },
      steps: [step({ id: 101, stepIndex: 0, status: 'completed' })],
      postflight: {
        status: 'completed',
        errors: [],
        archiveScan: { status: 'completed', scannedFiles: 3 },
        plex: { configured: false, attempted: false },
      },
    });
    renderReview();
    const panel = screen.getByTestId('panel-action-loop-closure');
    expect(panel).toHaveTextContent('Plex is not configured, so nothing was synced there.');
    expect(panel).not.toHaveTextContent('Plex was refreshed');
  });

  it('surfaces postflight errors and withholds the all-clear', () => {
    mocks.proposal.current = proposal({
      status: 'completed',
      counts: { total: 1, selected: 1, pending: 0, completed: 1, failed: 0, skipped: 0, reverted: 0 },
      steps: [step({ id: 101, stepIndex: 0, status: 'completed' })],
      postflight: {
        status: 'completed_with_errors',
        errors: ['Plex synchronization failed.'],
        archiveScan: { status: 'completed', scannedFiles: 3 },
        plex: { configured: true, attempted: true, status: 'sync_error' },
      },
    });
    renderReview();
    const panel = screen.getByTestId('panel-action-loop-closure');
    expect(panel).toHaveTextContent('Plex synchronization failed.');
    // The chain did not finish cleanly, so it must not say otherwise.
    expect(screen.queryByTestId('text-action-nothing-pending')).not.toBeInTheDocument();
  });

  it('says nothing about a loop that has not run yet', () => {
    mocks.proposal.current = proposal();
    renderReview();
    expect(screen.queryByTestId('panel-action-loop-closure')).not.toBeInTheDocument();
  });

  /*
    A failed proposal used to be a dead end: the engine could retry it, the UI
    never said so. These tests pin the recovery path to engine truth — the
    retry budget, what survives a retry, and the fact that retry re-checks
    rather than re-writes.
  */
  describe('recovering a stalled action', () => {
    it('offers retry as the obvious next move when a proposal failed', () => {
      mocks.proposal.current = proposal({
        status: 'failed',
        counts: { total: 2, selected: 2, pending: 0, completed: 0, failed: 2, skipped: 0, reverted: 0 },
      });
      renderReview();
      expect(screen.getByTestId('button-retry-action-proposal')).toHaveTextContent('RETRY 2 FAILED CHANGES');
    });

    it('states the retry budget the engine will actually honour', () => {
      mocks.proposal.current = proposal({
        status: 'failed',
        retryCount: 1,
        maxRetries: 3,
        counts: { total: 1, selected: 1, pending: 0, completed: 0, failed: 1, skipped: 0, reverted: 0 },
      });
      renderReview();
      expect(screen.getByTestId('text-action-retry-budget')).toHaveTextContent('2 OF 3 ATTEMPTS REMAINING');
    });

    /*
      The engine rejects a retry past maxRetries. Offering the button anyway
      would be a promise the API breaks.
    */
    it('withdraws retry once the engine would refuse it', () => {
      mocks.proposal.current = proposal({
        status: 'failed',
        retryCount: 3,
        maxRetries: 3,
        counts: { total: 1, selected: 1, pending: 0, completed: 0, failed: 1, skipped: 0, reverted: 0 },
      });
      renderReview();
      expect(screen.queryByTestId('button-retry-action-proposal')).toBeNull();
      expect(screen.getByTestId('text-action-next-exhausted')).toHaveTextContent('All 3 retry attempts have been used');
    });

    it('promises a re-check rather than a re-run, because that is what retry does', async () => {
      mocks.proposal.current = proposal({
        status: 'failed',
        counts: { total: 1, selected: 1, pending: 0, completed: 0, failed: 1, skipped: 0, reverted: 0 },
      });
      renderReview();
      expect(screen.getByTestId('text-action-next-retry')).toHaveTextContent('re-runs the safety checks');
      expect(screen.getByTestId('text-action-next-retry')).toHaveTextContent('Nothing is written until you approve');
      await userEvent.click(screen.getByTestId('button-retry-action-proposal'));
      expect(mocks.retryMutate).toHaveBeenCalledWith({ id: 7 }, expect.anything());
    });

    /*
      Retry resumes; it does not start over. A partially completed proposal has
      real work on disk already, and the operator must know it is not repeated.
    */
    it('reassures that applied changes survive a retry', () => {
      mocks.proposal.current = proposal({
        status: 'partially_completed',
        counts: { total: 3, selected: 3, pending: 0, completed: 2, failed: 1, skipped: 0, reverted: 0 },
      });
      renderReview();
      expect(screen.getByTestId('text-action-next-kept')).toHaveTextContent('2 changes already applied and verified stay applied');
      expect(screen.getByTestId('text-action-next-kept')).toHaveTextContent('resumes from there rather than starting over');
    });

    it('treats a cancelled proposal as recoverable, as the engine does', () => {
      mocks.proposal.current = proposal({
        status: 'cancelled',
        counts: { total: 1, selected: 1, pending: 1, completed: 0, failed: 0, skipped: 0, reverted: 0 },
      });
      renderReview();
      expect(screen.getByTestId('button-retry-action-proposal')).toHaveTextContent('RETRY');
    });

    /*
      Retry re-runs preflight against the plan hash recorded at approval, which
      is precisely what already mismatched. Offering retry here would spend a
      finite attempt on a guaranteed identical failure.
    */
    it('refuses to offer retry for a failure retry cannot fix', () => {
      mocks.proposal.current = proposal({
        status: 'failed',
        errorCode: 'PLAN_CHANGED',
        errorMessage: 'The proposal changed after approval; re-approval is required.',
        counts: { total: 1, selected: 1, pending: 1, completed: 0, failed: 0, skipped: 0, reverted: 0 },
      });
      renderReview();
      expect(screen.queryByTestId('button-retry-action-proposal')).toBeNull();
      expect(screen.getByTestId('text-action-next-plan-changed')).toHaveTextContent('would stop here again');
      expect(screen.getByTestId('button-preflight-action-proposal')).toHaveTextContent('RE-CHECK');
    });

    it('says nothing about next steps when the action simply succeeded', () => {
      mocks.proposal.current = proposal({
        status: 'completed',
        counts: { total: 1, selected: 1, pending: 0, completed: 1, failed: 0, skipped: 0, reverted: 0 },
      });
      renderReview();
      expect(screen.queryByTestId('panel-action-next-steps')).toBeNull();
    });
  });
});

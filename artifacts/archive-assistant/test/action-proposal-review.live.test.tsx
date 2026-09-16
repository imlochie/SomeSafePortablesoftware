/**
 * Live integration check for the Before → After review surface.
 *
 * Unlike action-proposal-review.test.tsx this mocks nothing: it renders the real
 * component against a real api-server over HTTP and drives the whole lifecycle
 * (propose → deselect → approve → preflight → execute → verify) to prove the
 * surface reflects real engine state and that real files move on disk.
 *
 * Skipped unless ARCHIVE_LIVE_API points at a running server, so the normal
 * `pnpm test` run stays hermetic.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { setBaseUrl } from '@workspace/api-client-react';

import { ActionProposalReview } from '../src/components/action-proposal-review';

const baseUrl = process.env.ARCHIVE_LIVE_API;
const archiveDir = process.env.ARCHIVE_LIVE_DIR ?? '/tmp/ui/archive';
const suite = baseUrl ? describe : describe.skip;

async function seedProposal(): Promise<number> {
  const response = await fetch(`${baseUrl}/api/action-proposals`);
  const proposals = (await response.json()) as Array<{ id: number; status: string }>;
  const open = proposals.find((entry) => entry.status === 'proposed');
  if (!open) throw new Error('Expected a seeded proposal in "proposed" state.');
  return open.id;
}

function renderReview(proposalId: number) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ActionProposalReview proposalId={proposalId} />
    </QueryClientProvider>,
  );
}

suite('action proposal review against a live engine', () => {
  let proposalId: number;

  beforeAll(async () => {
    setBaseUrl(baseUrl!);
    proposalId = await seedProposal();
  });

  it('walks a real proposal from review to verified execution', async () => {
    const user = userEvent.setup();
    renderReview(proposalId);

    // 1. WHAT IS CHANGING — the real plan renders as before → after.
    await waitFor(() => expect(screen.getByTestId('list-action-steps')).toBeInTheDocument());
    const rows = screen.getAllByTestId(/^row-action-step-/);
    expect(rows).toHaveLength(3);
    expect(screen.getByText('01 - pilot.mkv')).toBeInTheDocument();
    expect(screen.getByText('01 - Pilot.mkv')).toBeInTheDocument();

    // 2. WHY — evidence comes from the planner, not the UI.
    expect(screen.getByTestId('panel-action-evidence')).toHaveTextContent('INSPECTED 37');

    // 3. WHAT AM I AUTHORIZING — a bounded, editable list.
    expect(screen.getByTestId('button-approve-action-proposal')).toHaveTextContent('APPROVE 3 SELECTED');

    // Deselect one step; the authorization scope must shrink with it.
    const stepIds = rows.map((row) => row.getAttribute('data-testid')!.replace('row-action-step-', ''));
    await user.click(screen.getByTestId(`checkbox-action-step-${stepIds[2]}`));
    await waitFor(() =>
      expect(screen.getByTestId('button-approve-action-proposal')).toHaveTextContent('APPROVE 2 SELECTED'),
    );
    expect(screen.getByTestId('text-action-authorization-scope')).toHaveTextContent('exactly the 2 selected changes');

    // Approve — this must not touch the filesystem.
    await user.click(screen.getByTestId('button-approve-action-proposal'));
    await waitFor(() => expect(screen.getByTestId('text-action-approval')).toHaveTextContent('RECORDED'));
    expect(existsSync(`${archiveDir}/01 - pilot.mkv`)).toBe(true);
    expect(existsSync(`${archiveDir}/01 - Pilot.mkv`)).toBe(false);
    expect(screen.queryByTestId('button-execute-action-proposal')).not.toBeInTheDocument();

    // Preflight must come before execute is even offered.
    await user.click(screen.getByTestId('button-preflight-action-proposal'));
    await waitFor(() => expect(screen.getByTestId('text-action-preflight')).toHaveTextContent('2 PASSED'));
    expect(existsSync(`${archiveDir}/01 - pilot.mkv`)).toBe(true);

    // Execute is gated behind an explicit second confirmation.
    await user.click(screen.getByTestId('button-execute-action-proposal'));
    expect(existsSync(`${archiveDir}/01 - Pilot.mkv`)).toBe(false);
    await user.click(screen.getByTestId('button-confirm-execute-action-proposal'));

    // Verified result, and the deselected step was genuinely left alone.
    await waitFor(() => expect(screen.getByTestId('text-action-verified')).toHaveTextContent('2 / 2'), {
      timeout: 10_000,
    });
    expect(existsSync(`${archiveDir}/01 - Pilot.mkv`)).toBe(true);
    expect(existsSync(`${archiveDir}/02 - Second Contact.mkv`)).toBe(true);
    expect(existsSync(`${archiveDir}/03 - the signal.mkv`)).toBe(true);
    expect(existsSync(`${archiveDir}/03 - The Signal.mkv`)).toBe(false);

    // Completed work is revertible.
    expect(screen.getByTestId('button-revert-action-proposal')).toBeInTheDocument();
  }, 30_000);
});

suite('action proposal review reverts completed work', () => {
  it('restores the original filenames from the review surface', async () => {
    setBaseUrl(baseUrl!);
    const response = await fetch(`${baseUrl}/api/action-proposals`);
    const proposals = (await response.json()) as Array<{ id: number; status: string }>;
    const done = proposals.find((entry) => entry.status === 'completed');
    if (!done) throw new Error('Expected a completed proposal to revert.');

    const user = userEvent.setup();
    renderReview(done.id);

    await waitFor(() => expect(screen.getByTestId('button-revert-action-proposal')).toBeInTheDocument());
    await user.click(screen.getByTestId('button-revert-action-proposal'));
    // Revert is also two-step: the first click only arms it.
    expect(existsSync(`${archiveDir}/01 - Pilot.mkv`)).toBe(true);
    await user.click(screen.getByTestId('button-confirm-revert-action-proposal'));

    await waitFor(() => expect(screen.getByTestId('badge-action-status')).toHaveTextContent('REVERTED'), {
      timeout: 10_000,
    });
    expect(existsSync(`${archiveDir}/01 - pilot.mkv`)).toBe(true);
    expect(existsSync(`${archiveDir}/01 - Pilot.mkv`)).toBe(false);
  }, 30_000);
});

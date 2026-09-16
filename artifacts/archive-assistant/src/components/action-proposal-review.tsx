import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, ArrowRight, Check, CheckSquare, ChevronDown, ChevronRight,
  CloudOff, FolderPlus, Loader2, RefreshCw, RotateCcw, Square, X,
} from 'lucide-react';
import {
  getGetActionProposalQueryKey,
  getListActionProposalsQueryKey,
  useApproveActionProposal,
  useCancelActionProposal,
  useExecuteActionProposal,
  useGetActionProposal,
  usePreflightActionProposal,
  useRevertActionProposal,
  useUpdateActionStepSelection,
} from '@workspace/api-client-react';
import type { ActionProposal, ActionStep } from '@workspace/api-client-react';

/**
 * Before → After review surface for the Universal Action Engine.
 *
 * This is a trust surface, not an intelligence layer. Everything rendered here
 * is a restatement of something the engine reported. The component groups,
 * counts and phrases those facts so a human can absorb them quickly — it never
 * infers a new conclusion about the archive, and it never decides anything.
 *
 * The surface is one object that changes character as the proposal moves
 * through its lifecycle:
 *   UNDER REVIEW → CHECKING → APPLYING → COMPLETED
 * so the operator keeps their mental context instead of being handed from one
 * screen to the next.
 */

function errorText(error: unknown) {
  if (error && typeof error === 'object') {
    const data = (error as { data?: { error?: string } }).data;
    if (data?.error) return data.error;
    const message = (error as { message?: string }).message;
    if (message) return message;
  }
  return 'The local node rejected this request.';
}

type Bag = Record<string, unknown>;

function readString(source: Bag | undefined, key: string) {
  const value = source?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function readNumber(source: Bag | undefined, key: string) {
  const value = Number(source?.[key]);
  return Number.isFinite(value) ? value : 0;
}

function plural(count: number, one: string, many?: string) {
  if (count === 1) return one;
  if (many) return many;
  // Match the case of the singular so uppercase labels stay uppercase.
  return one === one.toUpperCase() ? `${one}S` : `${one}s`;
}

/**
 * What the two sides of a step are called.
 *
 * Not every action family renames a file. `reconcile` links a local file to a
 * Plex item, so "OLD NAME → NEW NAME" would be a lie. The column headings come
 * from the action type; the row renderer stays generic.
 */
const stepColumns: Record<string, {
  before: string; after: string; changeNoun: string; futureNoun: string;
}> = {
  // futureNoun names the blanket permission the operator is NOT granting, so
  // the sentence stays as concrete as "not future renames".
  rename: { before: 'OLD NAME', after: 'NEW NAME', changeNoun: 'change', futureNoun: 'renames' },
  move: { before: 'CURRENT LOCATION', after: 'NEW LOCATION', changeNoun: 'move', futureNoun: 'moves' },
  import: { before: 'SOURCE FILE', after: 'ARCHIVE DESTINATION', changeNoun: 'import', futureNoun: 'imports' },
  reconcile: { before: 'LOCAL FILE', after: 'PLEX ITEM', changeNoun: 'link', futureNoun: 'identity links' },
};
const defaultColumns = { before: 'BEFORE', after: 'AFTER', changeNoun: 'change', futureNoun: 'changes' };
const routineBlurb: Record<string, string> = {
  rename: 'Same folder, same file, new name.',
  move: 'Relocated within the archive.',
  import: 'Copied into the archive; the source is left in place.',
  reconcile: 'One local file, one Plex item, no file touched.',
};
const columnsFor = (type: string) => stepColumns[type] ?? defaultColumns;

/**
 * Identify each side of a step.
 *
 * A filesystem step is identified by its filename, with the full path as the
 * proof underneath. A record step has no path at all, so it falls back to the
 * label the planner supplied. Both render through the same two-column layout.
 */
function stepLabels(step: ActionStep) {
  const before = step.before as Bag;
  const after = step.after as Bag;
  const beforePath = readString(before, 'path');
  const afterPath = readString(after, 'path');
  // An explicit label beats a derived basename: a planner that supplied
  // "Example Show/Season 01/S01E01.mkv" chose that context deliberately, and
  // collapsing it to "S01E01.mkv" would make rows indistinguishable.
  const beforeName = readString(before, 'filename')
    ?? readString(before, 'label')
    ?? beforePath?.split(/[\\/]/).pop()
    ?? step.summary;
  const afterName = readString(after, 'filename')
    ?? afterPath?.split(/[\\/]/).pop()
    ?? readString(after, 'label')
    ?? readString(after, 'title')
    ?? '—';
  // Secondary proof line: a path when there is one, otherwise the qualifying
  // detail the planner gave (e.g. which Plex library the item lives in).
  const afterDetail = afterPath ?? readString(after, 'library');
  return { beforeName, afterName, beforePath, afterDetail };
}

const statusTone: Record<string, string> = {
  completed: 'text-[#39736e]',
  reverted: 'text-[#80652e]',
  failed: 'text-[#994b43]',
  skipped: 'text-[#a0afaf]',
  ready: 'text-[#39736e]',
  executing: 'text-[#a77517]',
  pending: 'text-[#7f9194]',
};

function StepStatusBadge({ step }: { step: ActionStep }) {
  // Before anything runs, say plainly what this row would do rather than
  // leaving the column blank — the table is the authorization record.
  if (step.status === 'pending') {
    return (
      <span
        className={`archive-mono text-[9px] tracking-[.1em] ${step.selected ? 'text-[#7f9194]' : 'text-[#b3c0c0]'}`}
        data-testid={`badge-step-status-${step.id}`}
      >
        {step.selected ? `WILL ${step.type.toUpperCase()}` : 'EXCLUDED'}
      </span>
    );
  }
  return (
    <span
      className={`archive-mono text-[9px] tracking-[.1em] ${statusTone[step.status] ?? 'text-[#7f9194]'}`}
      data-testid={`badge-step-status-${step.id}`}
    >
      {step.status.toUpperCase()}
    </span>
  );
}

/* ---------------------------------------------------------------- stages -- */

type Stage = 'review' | 'checking' | 'applying' | 'closed';

const stageOf = (proposal: ActionProposal): Stage => {
  switch (proposal.status) {
    case 'draft':
    case 'proposed':
    case 'approved':
      return 'review';
    case 'preflight':
      return 'checking';
    case 'executing':
      return 'applying';
    case 'ready':
      return 'checking';
    default:
      return 'closed';
  }
};

const stageCopy: Record<Stage, { label: string; tone: string; hint: string }> = {
  review: {
    label: 'UNDER REVIEW',
    tone: 'border-[#d9bd77] bg-[#fff8e7] text-[#8d681d]',
    hint: 'Understanding what would change',
  },
  checking: {
    label: 'CHECKING',
    tone: 'border-[#b9d6cf] bg-[#eaf3ef] text-[#39736e]',
    hint: 'Re-verifying every condition before anything is written',
  },
  applying: {
    label: 'APPLYING',
    tone: 'border-[#d9bd77] bg-[#fff8e7] text-[#8d681d]',
    hint: 'Changes are being written now',
  },
  closed: {
    label: 'CLOSED',
    tone: 'border-[#d6dfdc] bg-[#f3f6f5] text-[#5a6d73]',
    hint: 'Recorded outcome',
  },
};

/**
 * The engine's state, told as a sentence.
 *
 * Every clause below is a direct restatement of a counter or status the engine
 * already reported. Nothing here is inferred about the archive itself.
 */
function narrate(proposal: ActionProposal): string[] {
  const { counts, status } = proposal;
  // A record action writes no bytes; the wording must not imply it does.
  const writes = proposal.type !== 'reconcile';
  const written = writes ? 'written' : 'recorded';
  const touched = writes ? 'No file has been touched.' : 'No record has been changed.';
  const evidence = proposal.evidence as Bag;
  const inspected = readNumber(evidence, 'inspected');
  const verified = readNumber(proposal.verification as Bag, 'verified');
  const noun = plural(counts.total, 'change');
  const lines: string[] = [];

  if (status === 'draft' || status === 'proposed') {
    lines.push(
      inspected
        ? `Archive Assistant inspected ${inspected} ${plural(inspected, 'file')} and prepared ${counts.total} ${noun}.`
        : `Archive Assistant prepared ${counts.total} ${noun}.`,
    );
    if (counts.total - counts.selected > 0) {
      lines.push(`${counts.selected} ${plural(counts.selected, 'is', 'are')} selected; ${counts.total - counts.selected} ${plural(counts.total - counts.selected, 'is', 'are')} excluded and will be left alone.`);
    }
    lines.push(`Nothing will be ${written} until you approve the selected changes.`);
    return lines;
  }
  if (status === 'approved') {
    lines.push(`You approved ${counts.selected} ${plural(counts.selected, 'change')}.`);
    lines.push(`${touched} Every condition is re-checked immediately before anything is ${written}.`);
    return lines;
  }
  if (status === 'preflight') {
    lines.push(`Checking ${counts.selected} ${plural(counts.selected, 'change')}. This only reads the archive.`);
    return lines;
  }
  if (status === 'ready') {
    lines.push(`All checks passed for ${counts.selected} ${plural(counts.selected, 'change')}.`);
    lines.push(`Nothing has been ${written} yet — applying is still your decision.`);
    return lines;
  }
  if (status === 'executing') {
    lines.push(`Applying ${counts.selected} ${plural(counts.selected, 'change')}.`);
    return lines;
  }
  if (status === 'completed') {
    lines.push(`${counts.completed} ${plural(counts.completed, 'change')} applied and verified.`);
    if (counts.skipped) lines.push(`${counts.skipped} excluded ${plural(counts.skipped, 'change was', 'changes were')} left untouched.`);
    return lines;
  }
  if (status === 'partially_completed') {
    lines.push(`${counts.completed} of ${counts.selected} ${plural(counts.selected, 'change')} applied and verified; ${counts.failed} did not.`);
    lines.push('The changes that failed are listed below with the reason the engine gave.');
    return lines;
  }
  if (status === 'reverted') {
    lines.push(`${counts.reverted || verified} ${plural(counts.reverted || verified, 'change')} reverted. The originals are back in place.`);
    return lines;
  }
  if (status === 'cancelled') {
    lines.push('This proposal was cancelled. Nothing was changed.');
    return lines;
  }
  if (status === 'failed') {
    if (proposal.errorCode === 'PLAN_CHANGED') {
      // The engine records that the plan hash moved, but not which step moved
      // it — so we say exactly that rather than inventing a filename.
      lines.push('This plan changed after you approved it, so your approval no longer covers it.');
      lines.push(`Nothing was ${written}. Re-read the changes below and approve again if they still look right.`);
      return lines;
    }
    lines.push(counts.completed
      ? `Stopped after applying ${counts.completed} ${plural(counts.completed, 'change')}.`
      : `Stopped before anything was ${written}.`);
    if (counts.failed) lines.push(`${counts.failed} ${plural(counts.failed, 'change')} could not pass the safety checks. The reason for each is shown below.`);
    return lines;
  }
  return lines;
}

/* ------------------------------------------------- progressive disclosure -- */

type GroupId = 'blocked' | 'newFolder' | 'routine' | 'excluded' | 'done';

const groupCopy: Record<GroupId, { label: string; blurb: string; tone: string; attention: boolean }> = {
  blocked: {
    label: 'NEEDS YOUR ATTENTION',
    blurb: 'The engine refused these. They are not included in any apply.',
    tone: 'border-[#e0b3ad] bg-[#fcedea]',
    attention: true,
  },
  newFolder: {
    label: 'CREATES A NEW FOLDER',
    blurb: 'The destination folder does not exist yet.',
    tone: 'border-[#d9bd77] bg-[#fff8e7]',
    attention: true,
  },
  routine: {
    label: 'STRAIGHTFORWARD',
    blurb: '',
    tone: 'border-[#e1e8e5] bg-white/60',
    attention: false,
  },
  excluded: {
    label: 'EXCLUDED BY YOU',
    blurb: 'Deselected, so these will be left exactly as they are.',
    tone: 'border-[#e1e8e5] bg-[#f6f8f7]',
    attention: false,
  },
  done: {
    label: 'APPLIED',
    blurb: 'Recorded and verified by the engine.',
    tone: 'border-[#b9d6cf] bg-[#eaf3ef]',
    // After execution this group is the result, so it stays open.
    attention: true,
  },
};

/**
 * Bucket steps so the operator reads the exceptions instead of scrolling past
 * thirty identical renames.
 *
 * Every rule below keys off a fact the engine set — step status, the operator's
 * own selection, or a preflight field. The UI is compressing, not judging.
 */
function groupSteps(steps: ActionStep[]): Array<{ id: GroupId; steps: ActionStep[] }> {
  const buckets: Record<GroupId, ActionStep[]> = {
    blocked: [], newFolder: [], routine: [], excluded: [], done: [],
  };
  for (const step of steps) {
    if (step.status === 'failed' || step.errorCode) buckets.blocked.push(step);
    else if (step.status === 'completed' || step.status === 'reverted') buckets.done.push(step);
    else if (!step.selected) buckets.excluded.push(step);
    else if ((step.preflight as Bag)?.destinationDirectoryMissing === true) buckets.newFolder.push(step);
    else buckets.routine.push(step);
  }
  const order: GroupId[] = ['blocked', 'newFolder', 'routine', 'done', 'excluded'];
  return order.filter((id) => buckets[id].length > 0).map((id) => ({ id, steps: buckets[id] }));
}

/** Collapse only long, unremarkable groups. Exceptions are always open. */
const COLLAPSE_THRESHOLD = 8;

/* ------------------------------------------------------ preflight report -- */

type PreflightCheck = { id: string; label: string; passed: number; total: number };

/**
 * Turn the engine's per-step preflight payloads into the named reassurances a
 * human actually wants ("are the files still there?"). Each check counts only
 * steps where the engine itself reported that field.
 */
function preflightChecks(proposal: ActionProposal): PreflightCheck[] {
  const raw = (proposal.preflight as Bag)?.results;
  if (!Array.isArray(raw)) return [];
  const results = raw.filter((entry): entry is Bag => !!entry && typeof entry === 'object');
  const ok = results.filter((entry) => entry.ok === true);
  if (!ok.length) return [];

  const checks: PreflightCheck[] = [];
  const count = (predicate: (entry: Bag) => boolean) => ok.filter(predicate).length;
  // Only claim a check the engine actually reported for these steps.
  const reported = (key: string) => ok.some((entry) => entry[key] !== undefined);

  if (proposal.type === 'reconcile') {
    checks.push({
      id: 'source-exists',
      label: 'Both records still exist',
      passed: count((entry) => entry.sourceExists === true),
      total: ok.length,
    });
    checks.push({
      id: 'link-free',
      label: 'Neither side is already claimed by another link',
      passed: ok.length,
      total: ok.length,
    });
  } else {
    if (reported('sourceExists')) {
      checks.push({
        id: 'source-exists',
        label: 'Source files still exist',
        passed: count((entry) => entry.sourceExists === true),
        total: ok.length,
      });
    }
    if (reported('destinationExists')) {
      checks.push({
        id: 'no-collision',
        label: 'Destinations are free (nothing overwritten)',
        passed: count((entry) => entry.destinationExists === false),
        total: ok.length,
      });
    }
    if (reported('destinationDirectoryMissing')) {
      checks.push({
        id: 'folder-ready',
        label: 'Destination folders are writable',
        passed: count((entry) => entry.destinationDirectoryMissing !== true),
        total: ok.length,
      });
    }
  }

  checks.push({
    id: 'plan-stable',
    label: 'Plan unchanged since you approved it',
    passed: ok.length,
    total: ok.length,
  });
  return checks;
}

/* ------------------------------------------------------------- component -- */

export function ActionProposalReview({
  proposalId,
  onClose,
  context,
}: {
  proposalId: number;
  onClose?: () => void;
  /** The finding the operator came from, so the thread of thought survives. */
  context?: { eyebrow: string; headline: string } | null;
}) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState('');
  const [noticeTone, setNoticeTone] = useState<'good' | 'bad'>('good');
  const [confirmingExecute, setConfirmingExecute] = useState(false);
  const [confirmingRevert, setConfirmingRevert] = useState(false);
  const [openGroups, setOpenGroups] = useState<Partial<Record<GroupId, boolean>>>({});
  const autoPreflighted = useRef<number | null>(null);

  const { data: proposal, isLoading, isError, refetch } = useGetActionProposal(proposalId);
  const selection = useUpdateActionStepSelection();
  const approve = useApproveActionProposal();
  const preflight = usePreflightActionProposal();
  const execute = useExecuteActionProposal();
  const revert = useRevertActionProposal();
  const cancel = useCancelActionProposal();

  const pending = selection.isPending || approve.isPending || preflight.isPending
    || execute.isPending || revert.isPending || cancel.isPending;

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getGetActionProposalQueryKey(proposalId) });
    queryClient.invalidateQueries({ queryKey: getListActionProposalsQueryKey() });
  };
  const report = (message: string, tone: 'good' | 'bad' = 'good') => {
    setNotice(message);
    setNoticeTone(tone);
  };
  const handle = (message: string) => ({
    onSuccess: () => {
      report(message);
      refresh();
    },
    onError: (error: unknown) => report(errorText(error), 'bad'),
  });

  const runPreflight = () => preflight.mutate(
    { id: proposalId },
    handle('Preflight complete. No files were modified.'),
  );

  /**
   * Approval hands off straight into preflight so the operator does not have to
   * ask "what now?". Preflight only reads the archive — the write still needs a
   * separate, explicit confirmation below.
   */
  useEffect(() => {
    if (!proposal || proposal.status !== 'approved' || pending) return;
    if (autoPreflighted.current === proposal.id) return;
    autoPreflighted.current = proposal.id;
    runPreflight();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposal?.status, proposal?.id]);

  const evidence = useMemo(() => {
    const source = (proposal?.evidence ?? {}) as Bag;
    const entries: Array<[string, string]> = [];
    const push = (label: string, value: unknown) => {
      if (value === null || value === undefined) return;
      if (Array.isArray(value)) {
        if (value.length) entries.push([label, value.join(', ')]);
        return;
      }
      if (typeof value === 'object') return;
      entries.push([label, String(value)]);
    };
    push('INSPECTED', source.inspected);
    push('ACTIONABLE', source.actionable);
    push('SKIPPED', source.skipped);
    push('PATTERNS', source.patterns);
    push('CONFIDENCE', source.confidences);
    return entries;
  }, [proposal?.evidence]);

  const groups = useMemo(() => groupSteps(proposal?.steps ?? []), [proposal?.steps]);
  const checks = useMemo(() => (proposal ? preflightChecks(proposal) : []), [proposal]);

  if (isLoading) {
    return (
      <div
        className="flex min-h-[260px] items-center justify-center archive-mono text-[10px] tracking-[.12em] text-[#7f9194]"
        data-testid="status-action-proposal-loading"
      >
        READING ACTION PROPOSAL...
      </div>
    );
  }

  if (isError || !proposal) {
    return (
      <div className="archive-panel flex min-h-[260px] flex-col items-center justify-center p-8 text-center">
        <CloudOff size={26} className="mb-4 text-[#c85b51]" />
        <h2 className="archive-display text-xl font-extrabold">Proposal unavailable</h2>
        <p className="mt-2 max-w-sm text-[13px] leading-6 text-[#77878b]">
          This action proposal could not be read from the local node. Nothing has been assumed.
        </p>
        <button
          onClick={() => refetch()}
          className="mt-5 inline-flex items-center gap-2 bg-[#1d2b38] px-4 py-2.5 text-[11px] font-bold tracking-[.1em] text-[#f5f6f3]"
          data-testid="button-retry-action-proposal"
        >
          <RefreshCw size={14} /> RETRY READ
        </button>
      </div>
    );
  }

  const { counts, status } = proposal;
  const editable = status === 'draft' || status === 'proposed';
  const canApprove = editable && counts.selected > 0;
  const canPreflight = status === 'approved' || status === 'ready' || status === 'failed';
  const canExecute = status === 'ready';
  const canRevert = status === 'completed' || status === 'partially_completed';
  const canCancel = editable || status === 'approved' || status === 'ready' || status === 'failed';
  const preflightPassed = readNumber(proposal.preflight as Bag, 'passed');
  const preflightFailed = readNumber(proposal.preflight as Bag, 'failed');
  const verification = proposal.verification as Bag;
  const stage = stageOf(proposal);
  const busy = pending || status === 'preflight' || status === 'executing';
  const story = narrate(proposal);
  const columns = columnsFor(proposal.type);
  // Only a filesystem action replaces its "before" side. A reconcile link adds
  // a record, so striking the local filename through would misrepresent it.
  const replacesBefore = proposal.type !== 'reconcile';
  // reconcile changes records, not bytes. Saying "written to disk" about it
  // would overstate what the operator is authorizing.
  const writesFiles = proposal.type !== 'reconcile';

  const toggleStep = (step: ActionStep) => {
    if (!editable || pending) return;
    selection.mutate(
      { id: proposal.id, data: { selections: [{ stepId: step.id, selected: !step.selected }] } },
      handle(`Step ${step.stepIndex + 1} ${step.selected ? 'removed from' : 'added to'} this authorization.`),
    );
  };
  const setAll = (selected: boolean) => {
    if (!editable || pending) return;
    selection.mutate(
      { id: proposal.id, data: { selections: proposal.steps.map((step) => ({ stepId: step.id, selected })) } },
      handle(selected ? 'All steps selected.' : 'All steps deselected.'),
    );
  };

  const isOpen = (id: GroupId, size: number) =>
    openGroups[id] ?? (groupCopy[id].attention || size <= COLLAPSE_THRESHOLD);

  /** One obvious next move at every stage — the operator never has to hunt. */
  const primaryAction = canApprove
    ? {
        testId: 'button-approve-action-proposal',
        label: `APPROVE ${counts.selected} SELECTED`,
        icon: CheckSquare,
        onClick: () => approve.mutate(
          { id: proposal.id, data: {} },
          handle('Approval recorded. Running preflight checks; still nothing written.'),
        ),
      }
    : canExecute
      ? {
          testId: 'button-execute-action-proposal',
          label: `APPLY ${counts.selected} ${plural(counts.selected, 'CHANGE')}`,
          icon: ArrowRight,
          onClick: () => setConfirmingExecute(true),
        }
      : status === 'failed' && counts.completed === 0
        ? {
            testId: 'button-preflight-action-proposal',
            label: 'RE-CHECK',
            icon: RefreshCw,
            onClick: runPreflight,
          }
        : null;

  return (
    <section className="archive-panel p-5 md:p-7" data-testid={`panel-action-proposal-${proposal.id}`}>
      {/* Where the operator came from, kept alive through the whole flow. */}
      {context && (
        <div className="mb-4 flex items-center gap-2 border-l-2 border-[#4e9690] bg-[#f4f8f6] px-3 py-2" data-testid="text-action-origin">
          <span className="archive-mono text-[9px] tracking-[.12em] text-[#7f9194]">{context.eyebrow}</span>
          <ChevronRight size={12} className="text-[#b3c0c0]" />
          <span className="text-[11px] font-semibold text-[#43545b]">{context.headline}</span>
        </div>
      )}

      <div className="flex flex-col justify-between gap-4 border-b border-[#e7ecea] pb-5 md:flex-row md:items-start">
        <div className="min-w-0">
          <div className="archive-mono text-[10px] tracking-[.14em] text-[#7f9194]">
            ACTION REVIEW / {proposal.type.toUpperCase()} / {proposal.source.replace(/_/g, ' ').toUpperCase()}
          </div>
          <h2 className="archive-display mt-1 text-[22px] font-extrabold text-[#21303d]" data-testid="text-action-proposal-reason">
            {proposal.reason}
          </h2>
          {/* The narrative: engine state, told as a sentence. */}
          <div className="mt-3 max-w-2xl space-y-1 text-[13px] leading-6 text-[#5c6d73]" data-testid="text-action-narrative">
            {story.map((line) => <p key={line}>{line}</p>)}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-start gap-2 md:items-end">
          <div className="flex items-center gap-2">
            <span
              className={`archive-mono inline-flex items-center gap-1.5 border px-2 py-1 text-[9px] font-bold tracking-[.1em] ${stageCopy[stage].tone}`}
              data-testid="badge-action-stage"
            >
              {busy && <Loader2 size={11} className="animate-spin" />}
              {stage === 'closed' ? status.replace(/_/g, ' ').toUpperCase() : stageCopy[stage].label}
            </span>
            {onClose && (
              <button
                onClick={onClose}
                className="border border-[#d6dfdc] bg-white p-1.5 text-[#7f9194] hover:border-[#81999a]"
                aria-label="Close proposal review"
                data-testid="button-close-action-proposal"
              >
                <X size={14} />
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`archive-mono border px-2 py-1 text-[9px] font-bold tracking-[.1em] ${
                proposal.risk === 'high'
                  ? 'border-[#e0b3ad] bg-[#fcedea] text-[#994b43]'
                  : proposal.risk === 'medium'
                    ? 'border-[#d9bd77] bg-[#fff8e7] text-[#8d681d]'
                    : 'border-[#b9d6cf] bg-[#eaf3ef] text-[#39736e]'
              }`}
              data-testid="badge-action-risk"
            >
              RISK / {proposal.risk.toUpperCase()}
            </span>
            <span className="archive-mono border border-[#d6dfdc] bg-[#f3f6f5] px-2 py-1 text-[9px] font-bold tracking-[.1em] text-[#5a6d73]" data-testid="badge-action-status">
              {status.replace(/_/g, ' ').toUpperCase()}
            </span>
          </div>
        </div>
      </div>

      {/* Counters stay visible the whole way through, so nothing "resets". */}
      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="border border-[#e1e8e5] bg-white/60 p-3">
          <div className="archive-mono text-[9px] tracking-[.12em] text-[#7f9194]">SELECTED / TOTAL</div>
          <div className="archive-display mt-1 text-[20px] font-extrabold text-[#263844]" data-testid="text-action-selected-count">
            {counts.selected} / {counts.total}
          </div>
        </div>
        <div className="border border-[#e1e8e5] bg-white/60 p-3">
          <div className="archive-mono text-[9px] tracking-[.12em] text-[#7f9194]">APPROVAL</div>
          <div className="mt-1 text-[12px] font-semibold text-[#43545b]" data-testid="text-action-approval">
            {proposal.approvedAt ? 'RECORDED' : proposal.requiresApproval ? 'REQUIRED' : 'NOT REQUIRED'}
          </div>
        </div>
        <div className="border border-[#e1e8e5] bg-white/60 p-3">
          <div className="archive-mono text-[9px] tracking-[.12em] text-[#7f9194]">PREFLIGHT</div>
          <div className="mt-1 text-[12px] font-semibold text-[#43545b]" data-testid="text-action-preflight">
            {status === 'ready' || preflightPassed || preflightFailed
              ? `${preflightPassed} PASSED / ${preflightFailed} FAILED`
              : 'NOT RUN'}
          </div>
        </div>
        <div className="border border-[#e1e8e5] bg-white/60 p-3">
          <div className="archive-mono text-[9px] tracking-[.12em] text-[#7f9194]">VERIFIED</div>
          <div className="mt-1 text-[12px] font-semibold text-[#43545b]" data-testid="text-action-verified">
            {readNumber(verification, 'total')
              ? `${readNumber(verification, 'verified')} / ${readNumber(verification, 'total')}`
              : '—'}
          </div>
        </div>
      </div>

      {/* WHY — the planner's own evidence, unreinterpreted. */}
      {evidence.length > 0 && (
        <div className="mt-5 border-l-2 border-[#f4b942] bg-[#fff8e7] p-4" data-testid="panel-action-evidence">
          <div className="archive-mono text-[9px] font-bold tracking-[.12em] text-[#80652e]">WHY / EVIDENCE FROM THE PLANNER</div>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[11px] leading-5 text-[#80652e]">
            {evidence.map(([label, value]) => (
              <span key={label}><span className="archive-mono text-[9px] tracking-[.1em] opacity-70">{label}</span> {value}</span>
            ))}
          </div>
        </div>
      )}

      {/* Blocking reason, translated out of engine vocabulary. */}
      {proposal.errorMessage && (
        <div className="mt-5 border-l-2 border-[#c85b51] bg-[#fcedea] p-4 text-[12px] leading-6 text-[#994b43]" data-testid="text-action-error">
          <div className="archive-mono text-[9px] font-bold tracking-[.12em]">BLOCKED / {proposal.errorCode ?? 'ERROR'}</div>
          <div className="mt-1">{proposal.errorMessage}</div>
          {proposal.errorCode === 'PLAN_CHANGED' && (
            <div className="mt-1">
              The plan changed after approval, so it must be approved again. Nothing was written.
            </div>
          )}
        </div>
      )}

      {/* Preflight, as named reassurances rather than a status code. */}
      {checks.length > 0 && (
        <div className="mt-5 border border-[#d7e6e1] bg-[#f4f9f7] p-4" data-testid="panel-preflight-checks">
          <div className="archive-mono text-[9px] font-bold tracking-[.12em] text-[#39736e]">
            PREFLIGHT / {preflightPassed} OF {preflightPassed + preflightFailed} {plural(preflightPassed + preflightFailed, 'CHANGE')} CLEARED
          </div>
          <ul className="mt-2 grid gap-1 sm:grid-cols-2">
            {checks.map((check) => (
              <li key={check.id} className="flex items-center gap-2 text-[11px] text-[#39736e]" data-testid={`check-${check.id}`}>
                {check.passed === check.total
                  ? <Check size={13} className="shrink-0" />
                  : <AlertTriangle size={13} className="shrink-0 text-[#a77517]" />}
                <span className={check.passed === check.total ? '' : 'text-[#8d681d]'}>{check.label}</span>
                <span className="archive-mono text-[9px] opacity-60">{check.passed}/{check.total}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* WHAT IS CHANGING — grouped so exceptions surface first. */}
      <div className="mt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="archive-mono text-[10px] tracking-[.14em] text-[#7f9194]">WHAT WOULD CHANGE</div>
            <h3 className="archive-display mt-1 text-[16px] font-extrabold text-[#21303d]" data-testid="text-action-change-summary">
              {counts.total} proposed {plural(counts.total, 'change')}
              {counts.total !== counts.selected && ` · ${counts.selected} selected · ${counts.total - counts.selected} excluded`}
            </h3>
          </div>
          {editable && (
            <div className="flex gap-2">
              <button
                onClick={() => setAll(true)}
                disabled={pending}
                className="border border-[#d7e1de] bg-white/70 px-2.5 py-1.5 text-[9px] font-bold tracking-[.08em] text-[#607379] hover:border-[#8fb3ac] disabled:opacity-50"
                data-testid="button-select-all-steps"
              >
                SELECT ALL
              </button>
              <button
                onClick={() => setAll(false)}
                disabled={pending}
                className="border border-[#d7e1de] bg-white/70 px-2.5 py-1.5 text-[9px] font-bold tracking-[.08em] text-[#607379] hover:border-[#8fb3ac] disabled:opacity-50"
                data-testid="button-deselect-all-steps"
              >
                CLEAR
              </button>
            </div>
          )}
        </div>

        <div className="mt-3 space-y-3" data-testid="list-action-steps">
          {groups.map(({ id, steps }) => {
            const open = isOpen(id, steps.length);
            const copy = groupCopy[id];
            const blurb = copy.blurb || (id === 'routine' ? routineBlurb[proposal.type] ?? '' : '');
            return (
              <div key={id} className={`border ${copy.tone}`} data-testid={`group-action-steps-${id}`}>
                <button
                  onClick={() => setOpenGroups((current) => ({ ...current, [id]: !open }))}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
                  data-testid={`button-toggle-group-${id}`}
                  aria-expanded={open}
                >
                  {open ? <ChevronDown size={13} className="shrink-0 text-[#7f9194]" /> : <ChevronRight size={13} className="shrink-0 text-[#7f9194]" />}
                  {id === 'blocked' && <AlertTriangle size={13} className="shrink-0 text-[#994b43]" />}
                  {id === 'newFolder' && <FolderPlus size={13} className="shrink-0 text-[#8d681d]" />}
                  <span className="archive-mono text-[10px] font-bold tracking-[.1em] text-[#43545b]">
                    {steps.length} {copy.label}
                  </span>
                  <span className="truncate text-[11px] text-[#7f9194]">{blurb}</span>
                </button>

                {open && (
                  <div className="border-t border-white/60">
                    <div className="hidden px-3 py-2 md:grid md:grid-cols-[28px_minmax(0,1fr)_20px_minmax(0,1fr)_92px] md:gap-3">
                      <span />
                      <span className="archive-mono text-[9px] tracking-[.12em] text-[#7f9194]">{columns.before}</span>
                      <span />
                      <span className="archive-mono text-[9px] tracking-[.12em] text-[#7f9194]">{columns.after}</span>
                      <span className="archive-mono text-[9px] tracking-[.12em] text-[#7f9194]">STATUS</span>
                    </div>
                    {steps.map((step) => {
                      const { beforeName, afterName, beforePath, afterDetail } = stepLabels(step);
                      return (
                        <div
                          key={step.id}
                          className="grid gap-2 border-t border-white/70 px-3 py-2.5 md:grid-cols-[28px_minmax(0,1fr)_20px_minmax(0,1fr)_92px] md:items-center md:gap-3"
                          data-testid={`row-action-step-${step.id}`}
                        >
                          <button
                            onClick={() => toggleStep(step)}
                            disabled={!editable || pending}
                            className={`grid h-5 w-5 place-items-center border ${
                              step.selected ? 'border-[#4e9690] bg-[#4e9690] text-white' : 'border-[#c3d0cd] bg-white text-transparent'
                            } ${editable ? 'hover:border-[#39736e]' : 'cursor-default opacity-60'}`}
                            aria-label={step.selected ? `Exclude ${beforeName}` : `Include ${beforeName}`}
                            aria-pressed={step.selected}
                            data-testid={`checkbox-action-step-${step.id}`}
                          >
                            {step.selected ? <Check size={12} /> : <Square size={12} className="opacity-0" />}
                          </button>
                          <div className="min-w-0">
                            <div className={`truncate text-[12px] text-[#5c6d73] ${replacesBefore ? 'line-through decoration-[#c0cbc9]' : ''}`} data-testid={`text-step-before-${step.id}`}>
                              {beforeName}
                            </div>
                            {beforePath && <div className="archive-mono mt-0.5 truncate text-[9px] text-[#a0afaf]" title={beforePath}>{beforePath}</div>}
                          </div>
                          <ArrowRight size={13} className="hidden shrink-0 text-[#9fb0ae] md:block" />
                          <div className="min-w-0">
                            <div className="truncate text-[12px] font-semibold text-[#21303d]" data-testid={`text-step-after-${step.id}`}>
                              {afterName}
                            </div>
                            {afterDetail && <div className="archive-mono mt-0.5 truncate text-[9px] text-[#a0afaf]" title={afterDetail}>{afterDetail}</div>}
                          </div>
                          <div className="md:text-right">
                            <StepStatusBadge step={step} />
                            {step.errorMessage && (
                              <div className="mt-1 text-[10px] leading-4 text-[#994b43]" data-testid={`text-step-error-${step.id}`}>
                                {step.errorMessage}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {notice && (
        <div
          className={`mt-5 border-l-2 p-3 text-[11px] leading-5 ${
            noticeTone === 'bad' ? 'border-[#c85b51] bg-[#fcedea] text-[#994b43]' : 'border-[#4e9690] bg-[#eaf3ef] text-[#39736e]'
          }`}
          data-testid="status-action-proposal"
        >
          {notice}
        </div>
      )}

      {/* The authorization boundary, stated in words before the buttons. */}
      <div className="mt-6 border-t border-[#e7ecea] pt-5">
        {editable && (
          <p className="mb-4 max-w-3xl text-[12px] leading-6 text-[#5c6d73]" data-testid="text-action-authorization-scope">
            Approving authorizes exactly the {counts.selected} selected {plural(counts.selected, columns.changeNoun)} listed
            above — not future {columns.futureNoun}. Preflight re-checks every condition immediately before
            anything is {writesFiles ? 'written' : 'recorded'}.
          </p>
        )}

        {confirmingExecute && canExecute && (
          <div className="mb-4 border-l-2 border-[#c85b51] bg-[#fcedea] p-4" data-testid="panel-confirm-execute">
            <div className="text-[12px] font-bold text-[#994b43]">
              {writesFiles ? 'Write' : 'Record'} {counts.selected} verified {plural(counts.selected, columns.changeNoun)} now?
            </div>
            <p className="mt-1 text-[11px] leading-5 text-[#994b43]">
              {writesFiles
                ? 'This modifies files in the archive.'
                : 'This changes archive records only; no file on disk is modified.'}{' '}
              Each change is verified afterwards, and the proposal can be reverted.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                onClick={() => {
                  setConfirmingExecute(false);
                  execute.mutate({ id: proposal.id, data: { confirmed: true } }, handle('Execution finished. Every change was verified.'));
                }}
                disabled={pending}
                className="inline-flex items-center gap-2 bg-[#994b43] px-4 py-2.5 text-[10px] font-bold tracking-[.1em] text-white disabled:opacity-50"
                data-testid="button-confirm-execute-action-proposal"
              >
                <Check size={14} /> YES, APPLY {counts.selected}
              </button>
              <button
                onClick={() => setConfirmingExecute(false)}
                className="border border-[#d6dfdc] bg-white px-4 py-2.5 text-[10px] font-bold tracking-[.1em] text-[#5a6d73]"
                data-testid="button-cancel-execute-action-proposal"
              >
                NOT YET
              </button>
            </div>
          </div>
        )}

        {confirmingRevert && canRevert && (
          <div className="mb-4 border-l-2 border-[#a77517] bg-[#fff8e7] p-4" data-testid="panel-confirm-revert">
            <div className="text-[12px] font-bold text-[#80652e]">Put {counts.completed} applied {plural(counts.completed, 'change')} back?</div>
            <p className="mt-1 text-[11px] leading-5 text-[#80652e]">
              This restores the original paths recorded at execution time.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                onClick={() => {
                  setConfirmingRevert(false);
                  revert.mutate({ id: proposal.id, data: { confirmed: true } }, handle('Revert finished. The originals are back in place.'));
                }}
                disabled={pending}
                className="inline-flex items-center gap-2 bg-[#a77517] px-4 py-2.5 text-[10px] font-bold tracking-[.1em] text-white disabled:opacity-50"
                data-testid="button-confirm-revert-action-proposal"
              >
                <RotateCcw size={14} /> YES, REVERT
              </button>
              <button
                onClick={() => setConfirmingRevert(false)}
                className="border border-[#d6dfdc] bg-white px-4 py-2.5 text-[10px] font-bold tracking-[.1em] text-[#5a6d73]"
                data-testid="button-cancel-revert-action-proposal"
              >
                KEEP CHANGES
              </button>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {/* One obvious next move, sized and coloured to be the obvious one. */}
          {primaryAction && !confirmingExecute && (
            <button
              onClick={primaryAction.onClick}
              disabled={busy}
              className="inline-flex items-center gap-2 bg-[#1d2b38] px-5 py-3 text-[11px] font-bold tracking-[.1em] text-[#f5f6f3] hover:bg-[#263844] disabled:opacity-50"
              data-testid={primaryAction.testId}
            >
              <primaryAction.icon size={14} /> {primaryAction.label}
            </button>
          )}

          {/* Preflight stays reachable on its own for an already-checked plan. */}
          {canPreflight && !(status === 'failed' && counts.completed === 0) && (
            <button
              onClick={runPreflight}
              disabled={busy}
              className="inline-flex items-center gap-2 border border-[#4e9690] bg-white px-4 py-2.5 text-[10px] font-bold tracking-[.1em] text-[#39736e] hover:bg-[#eaf3ef] disabled:opacity-50"
              data-testid="button-preflight-action-proposal"
            >
              <RefreshCw size={14} /> RE-RUN CHECKS
            </button>
          )}

          {canRevert && !confirmingRevert && (
            <button
              onClick={() => setConfirmingRevert(true)}
              disabled={pending}
              className="inline-flex items-center gap-2 border border-[#d9bd77] bg-[#fff8e7] px-4 py-2.5 text-[10px] font-bold tracking-[.1em] text-[#8d681d] disabled:opacity-50"
              data-testid="button-revert-action-proposal"
            >
              <RotateCcw size={14} /> REVERT
            </button>
          )}

          {canCancel && (
            <button
              onClick={() => cancel.mutate({ id: proposal.id }, handle('Proposal cancelled. Nothing was changed.'))}
              disabled={pending}
              className="inline-flex items-center gap-2 border border-[#d6dfdc] bg-white px-4 py-2.5 text-[10px] font-bold tracking-[.1em] text-[#5a6d73] hover:border-[#81999a] disabled:opacity-50"
              data-testid="button-cancel-action-proposal"
            >
              <X size={14} /> CANCEL
            </button>
          )}
          {onClose && (
            <button
              onClick={onClose}
              className="inline-flex items-center gap-2 border border-[#d6dfdc] bg-white px-4 py-2.5 text-[10px] font-bold tracking-[.1em] text-[#5a6d73] hover:border-[#81999a]"
              data-testid="button-back-action-proposal"
            >
              BACK
            </button>
          )}
        </div>

        <div className="mt-4 archive-mono text-[9px] tracking-[.08em] text-[#a0afaf]" data-testid="text-action-footer-contract">
          {status === 'proposed' || status === 'draft'
            ? `PROPOSAL ONLY / NO ${writesFiles ? 'FILESYSTEM ACTION' : 'RECORD CHANGE'} UNTIL APPROVED, PREFLIGHTED, AND CONFIRMED`
            : status === 'approved'
              ? `APPROVED / NO ${writesFiles ? 'FILESYSTEM ACTION' : 'RECORD CHANGE'} UNTIL PREFLIGHT AND EXPLICIT CONFIRMATION`
              : status === 'ready'
                ? 'PREFLIGHT PASSED / EXECUTION REQUIRES EXPLICIT CONFIRMATION'
                : status === 'cancelled'
                  ? `CANCELLED / NO CHANGES APPLIED / ${proposal.events.length} LIFECYCLE EVENTS`
                  : status === 'failed' && counts.completed === 0
                    ? `STOPPED BEFORE EXECUTION / NO CHANGES APPLIED / ${proposal.events.length} LIFECYCLE EVENTS`
                    : `RECORDED IN HISTORY / ${counts.completed} ${plural(counts.completed, 'CHANGE')} APPLIED / ${proposal.events.length} LIFECYCLE EVENTS`}
        </div>
      </div>
    </section>
  );
}

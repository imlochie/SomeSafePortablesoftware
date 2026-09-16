import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, ArrowRight, Check, CheckSquare, CircleHelp, CloudOff,
  FileCheck2, RefreshCw, RotateCcw, ShieldCheck, Square, X,
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
 * This is a trust surface, not an intelligence layer. It renders only what the
 * engine reports and must make three things unambiguous:
 *   1. What is changing?      — the exact per-step Before → After mapping
 *   2. Why is it changing?    — evidence and confidence from the planner
 *   3. What am I authorizing? — a bounded, counted list of selected steps
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

function readString(source: Record<string, unknown> | undefined, key: string) {
  const value = source?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

/** Filenames are the operator's mental model; full paths are the proof. */
function stepLabels(step: ActionStep) {
  const before = step.before as Record<string, unknown>;
  const after = step.after as Record<string, unknown>;
  const beforePath = readString(before, 'path');
  const afterPath = readString(after, 'path');
  const beforeName = readString(before, 'filename')
    ?? beforePath?.split(/[\\/]/).pop()
    ?? step.summary;
  const afterName = readString(after, 'filename')
    ?? afterPath?.split(/[\\/]/).pop()
    ?? '—';
  return { beforeName, afterName, beforePath, afterPath };
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

/** The lifecycle, always visible, so "what happens after Execute" is never a surprise. */
function LifecycleTrail({ proposal }: { proposal: ActionProposal }) {
  const reached = (phase: string) => {
    const order = ['propose', 'approve', 'preflight', 'execute', 'verify', 'record'];
    const statusPhase: Record<string, number> = {
      draft: 0, proposed: 0, approved: 1, preflight: 2, ready: 2,
      executing: 3, completed: 5, partially_completed: 5, failed: 2,
      cancelled: 0, reverted: 5,
    };
    return (statusPhase[proposal.status] ?? 0) >= order.indexOf(phase);
  };
  const phases = [
    { id: 'propose', label: 'PROPOSE' },
    { id: 'approve', label: 'APPROVE' },
    { id: 'preflight', label: 'PREFLIGHT' },
    { id: 'execute', label: 'EXECUTE' },
    { id: 'verify', label: 'VERIFY' },
    { id: 'record', label: 'RECORD' },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="trail-action-lifecycle">
      {phases.map((phase, index) => (
        <span key={phase.id} className="flex items-center gap-2">
          <span className={`archive-mono text-[9px] tracking-[.1em] ${reached(phase.id) ? 'text-[#39736e]' : 'text-[#b3bfbf]'}`}>
            {phase.label}
          </span>
          {index < phases.length - 1 && <span className="text-[#cfd8d6]">›</span>}
        </span>
      ))}
    </div>
  );
}

export function ActionProposalReview({
  proposalId,
  onClose,
}: {
  proposalId: number;
  onClose?: () => void;
}) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState('');
  const [noticeTone, setNoticeTone] = useState<'good' | 'bad'>('good');
  const [confirmingExecute, setConfirmingExecute] = useState(false);
  const [confirmingRevert, setConfirmingRevert] = useState(false);

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

  const evidence = useMemo(() => {
    const source = (proposal?.evidence ?? {}) as Record<string, unknown>;
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
  const preflightPassed = Number((proposal.preflight as Record<string, unknown>).passed ?? 0);
  const preflightFailed = Number((proposal.preflight as Record<string, unknown>).failed ?? 0);
  const verification = proposal.verification as Record<string, unknown>;

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

  return (
    <section className="archive-panel p-5 md:p-7" data-testid={`panel-action-proposal-${proposal.id}`}>
      <div className="flex flex-col justify-between gap-4 border-b border-[#e7ecea] pb-5 md:flex-row md:items-start">
        <div className="min-w-0">
          <div className="archive-mono text-[10px] tracking-[.14em] text-[#7f9194]">
            ACTION PROPOSAL / {proposal.type.toUpperCase()} / {proposal.source.replace(/_/g, ' ').toUpperCase()}
          </div>
          <h2 className="archive-display mt-1 text-[22px] font-extrabold text-[#21303d]" data-testid="text-action-proposal-reason">
            {proposal.reason}
          </h2>
          <div className="mt-3"><LifecycleTrail proposal={proposal} /></div>
        </div>
        <div className="flex shrink-0 items-start gap-2">
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
      </div>

      {/* WHAT AM I AUTHORIZING — a bounded count, never a blanket permission. */}
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
            {verification.verified !== undefined
              ? `${String(verification.verified)} / ${String(verification.total ?? counts.total)}`
              : '—'}
          </div>
        </div>
      </div>

      {/* WHY IS IT CHANGING */}
      {(evidence.length > 0 || proposal.errorMessage) && (
        <div className="mt-5 space-y-3">
          {evidence.length > 0 && (
            <div className="border-l-2 border-[#d9bd77] bg-[#fff8e7] p-3 text-[11px] leading-5 text-[#80652e]" data-testid="panel-action-evidence">
              <span className="font-bold">EVIDENCE / </span>
              {evidence.map(([label, value]) => `${label} ${value}`).join(' · ')}
            </div>
          )}
          {proposal.errorMessage && (
            <div className="border-l-2 border-[#c85b51] bg-[#fcedea] p-3 text-[11px] leading-5 text-[#994b43]" data-testid="text-action-error">
              <span className="font-bold">BLOCKED / </span>
              {proposal.errorMessage}
              {proposal.errorCode === 'PLAN_CHANGED' && ' The plan changed after approval, so it must be approved again.'}
            </div>
          )}
        </div>
      )}

      {/* WHAT IS CHANGING — the Before → After table. */}
      <div className="mt-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="archive-mono text-[10px] tracking-[.14em] text-[#7f9194]">
            {counts.total} PROPOSED CHANGE{counts.total === 1 ? '' : 'S'}
          </div>
          {editable && counts.total > 1 && (
            <div className="flex gap-2">
              <button
                onClick={() => setAll(true)}
                disabled={pending}
                className="border border-[#d6dfdc] bg-white px-2.5 py-1.5 archive-mono text-[9px] font-bold tracking-[.1em] text-[#5a6d73] hover:border-[#81999a] disabled:opacity-50"
                data-testid="button-select-all-steps"
              >
                SELECT ALL
              </button>
              <button
                onClick={() => setAll(false)}
                disabled={pending}
                className="border border-[#d6dfdc] bg-white px-2.5 py-1.5 archive-mono text-[9px] font-bold tracking-[.1em] text-[#5a6d73] hover:border-[#81999a] disabled:opacity-50"
                data-testid="button-deselect-all-steps"
              >
                CLEAR
              </button>
            </div>
          )}
        </div>

        <div className="hidden grid-cols-[28px_minmax(0,1fr)_20px_minmax(0,1fr)_92px] gap-3 border-b border-[#e7ecea] pb-2 md:grid">
          <span />
          <span className="archive-mono text-[9px] tracking-[.12em] text-[#7f9194]">OLD NAME</span>
          <span />
          <span className="archive-mono text-[9px] tracking-[.12em] text-[#39736e]">NEW NAME</span>
          <span className="archive-mono text-right text-[9px] tracking-[.12em] text-[#7f9194]">STATUS</span>
        </div>

        <div className="divide-y divide-[#edf1ef]" data-testid="list-action-steps">
          {proposal.steps.map((step) => {
            const { beforeName, afterName, beforePath, afterPath } = stepLabels(step);
            const muted = !step.selected || step.status === 'skipped';
            return (
              <div
                key={step.id}
                className={`grid grid-cols-1 gap-2 py-3 md:grid-cols-[28px_minmax(0,1fr)_20px_minmax(0,1fr)_92px] md:gap-3 ${muted ? 'opacity-45' : ''}`}
                data-testid={`row-action-step-${step.id}`}
              >
                <div className="flex items-start">
                  <button
                    onClick={() => toggleStep(step)}
                    disabled={!editable || pending}
                    className="text-[#4e9690] disabled:cursor-not-allowed disabled:text-[#b3bfbf]"
                    aria-label={`${step.selected ? 'Deselect' : 'Select'} ${beforeName}`}
                    aria-pressed={step.selected}
                    data-testid={`checkbox-action-step-${step.id}`}
                  >
                    {step.selected ? <CheckSquare size={15} /> : <Square size={15} />}
                  </button>
                </div>
                <div className="min-w-0">
                  <div className="break-all text-[12px] font-semibold text-[#43545b]" data-testid={`text-step-before-${step.id}`}>
                    {beforeName}
                  </div>
                  {beforePath && (
                    <div className="mt-0.5 break-all archive-mono text-[9px] text-[#a0afaf]" title={beforePath}>{beforePath}</div>
                  )}
                </div>
                <div className="hidden items-start justify-center pt-0.5 text-[#9fb0ae] md:flex">
                  <ArrowRight size={13} />
                </div>
                <div className="min-w-0">
                  <div className="break-all text-[12px] font-semibold text-[#344851]" data-testid={`text-step-after-${step.id}`}>
                    {afterName}
                  </div>
                  {afterPath && (
                    <div className="mt-0.5 break-all archive-mono text-[9px] text-[#a0afaf]" title={afterPath}>{afterPath}</div>
                  )}
                  {step.errorMessage && (
                    <div className="mt-1 text-[10px] leading-4 text-[#994b43]" data-testid={`text-step-error-${step.id}`}>
                      {step.errorMessage}
                    </div>
                  )}
                </div>
                <div className="flex items-start md:justify-end">
                  <StepStatusBadge step={step} />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {notice && (
        <div
          className={`mt-5 flex gap-2 border-l-2 p-3 text-[11px] leading-5 ${
            noticeTone === 'bad'
              ? 'border-[#c85b51] bg-[#fcedea] text-[#994b43]'
              : 'border-[#4e9690] bg-[#eaf3ef] text-[#39736e]'
          }`}
          role="status"
          data-testid="status-action-proposal"
        >
          <FileCheck2 size={14} className="mt-0.5 shrink-0" />
          {notice}
        </div>
      )}

      {/* The operator contract, stated before the buttons that act on it. */}
      <div className="mt-6 border-t border-[#e7ecea] pt-5">
        {editable && (
          <div className="mb-4 flex gap-2 border-l-2 border-[#f4b942] bg-[#fff8e7] p-3 text-[11px] leading-5 text-[#80652e]" data-testid="text-action-authorization-scope">
            <CircleHelp size={14} className="mt-0.5 shrink-0" />
            <span>
              Approving authorizes exactly the {counts.selected} selected change
              {counts.selected === 1 ? '' : 's'} listed above — not future renames. Preflight re-checks every
              condition immediately before anything is written.
            </span>
          </div>
        )}
        {status === 'approved' && (
          <div className="mb-4 flex gap-2 border-l-2 border-[#4e9690] bg-[#eaf3ef] p-3 text-[11px] leading-5 text-[#39736e]" data-testid="text-action-next-step">
            <ShieldCheck size={14} className="mt-0.5 shrink-0" />
            Approval is recorded. Run preflight to re-check the archive before execution. No file has been touched.
          </div>
        )}
        {canExecute && (
          <div className="mb-4 flex gap-2 border-l-2 border-[#4e9690] bg-[#eaf3ef] p-3 text-[11px] leading-5 text-[#39736e]" data-testid="text-action-execute-ready">
            <Check size={14} className="mt-0.5 shrink-0" />
            Preflight passed for {preflightPassed} step{preflightPassed === 1 ? '' : 's'}. Executing writes to the
            archive, verifies each change, and records it in history. It can be reverted afterwards.
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {editable && (
            <button
              onClick={() => approve.mutate(
                { id: proposal.id, data: {} },
                handle(`Approved ${counts.selected} change${counts.selected === 1 ? '' : 's'}. Nothing has been written yet.`),
              )}
              disabled={!canApprove || pending}
              className="inline-flex items-center gap-2 bg-[#1d2b38] px-4 py-2.5 text-[10px] font-bold tracking-[.1em] text-[#f5f6f3] disabled:opacity-50"
              data-testid="button-approve-action-proposal"
            >
              <ShieldCheck size={14} />
              APPROVE {counts.selected} SELECTED
            </button>
          )}
          {canPreflight && (
            <button
              onClick={() => preflight.mutate(
                { id: proposal.id },
                handle('Preflight complete. No files were modified.'),
              )}
              disabled={pending}
              className="inline-flex items-center gap-2 bg-[#1d2b38] px-4 py-2.5 text-[10px] font-bold tracking-[.1em] text-[#f5f6f3] disabled:opacity-50"
              data-testid="button-preflight-action-proposal"
            >
              {preflight.isPending ? <RefreshCw size={13} className="animate-spin" /> : <FileCheck2 size={14} />}
              RUN PREFLIGHT
            </button>
          )}
          {canExecute && !confirmingExecute && (
            <button
              onClick={() => setConfirmingExecute(true)}
              disabled={pending}
              className="inline-flex items-center gap-2 bg-[#39736e] px-4 py-2.5 text-[10px] font-bold tracking-[.1em] text-[#f5f6f3] disabled:opacity-50"
              data-testid="button-execute-action-proposal"
            >
              <Check size={14} /> EXECUTE
            </button>
          )}
          {/* Execution is never one click from a list view. */}
          {canExecute && confirmingExecute && (
            <div className="flex w-full flex-wrap items-center gap-2 border border-[#d9bd77] bg-[#fff8e7] p-3" data-testid="panel-confirm-execute">
              <AlertTriangle size={14} className="shrink-0 text-[#8d681d]" />
              <span className="mr-1 text-[11px] leading-5 text-[#80652e]">
                Write {preflightPassed} verified change{preflightPassed === 1 ? '' : 's'} to the archive?
              </span>
              <button
                onClick={() => {
                  setConfirmingExecute(false);
                  execute.mutate(
                    { id: proposal.id, data: { confirmed: true } },
                    handle('Execution finished. Every change was verified and recorded.'),
                  );
                }}
                disabled={pending}
                className="inline-flex items-center gap-2 bg-[#39736e] px-3.5 py-2 text-[10px] font-bold tracking-[.1em] text-[#f5f6f3] disabled:opacity-50"
                data-testid="button-confirm-execute-action-proposal"
              >
                {execute.isPending ? <RefreshCw size={13} className="animate-spin" /> : <Check size={13} />}
                CONFIRM EXECUTE
              </button>
              <button
                onClick={() => setConfirmingExecute(false)}
                className="border border-[#d6dfdc] bg-white px-3.5 py-2 text-[10px] font-bold tracking-[.1em] text-[#5a6d73]"
                data-testid="button-cancel-execute-action-proposal"
              >
                BACK
              </button>
            </div>
          )}
          {canRevert && !confirmingRevert && (
            <button
              onClick={() => setConfirmingRevert(true)}
              disabled={pending}
              className="inline-flex items-center gap-2 border border-[#d6dfdc] bg-white px-4 py-2.5 text-[10px] font-bold tracking-[.1em] text-[#5a6d73] hover:border-[#81999a] disabled:opacity-50"
              data-testid="button-revert-action-proposal"
            >
              <RotateCcw size={14} /> REVERT
            </button>
          )}
          {canRevert && confirmingRevert && (
            <div className="flex w-full flex-wrap items-center gap-2 border border-[#d9bd77] bg-[#fff8e7] p-3" data-testid="panel-confirm-revert">
              <AlertTriangle size={14} className="shrink-0 text-[#8d681d]" />
              <span className="mr-1 text-[11px] leading-5 text-[#80652e]">
                Restore {counts.completed} completed change{counts.completed === 1 ? '' : 's'} to their original state?
              </span>
              <button
                onClick={() => {
                  setConfirmingRevert(false);
                  revert.mutate(
                    { id: proposal.id, data: { confirmed: true } },
                    handle('Revert finished. The archive was restored.'),
                  );
                }}
                disabled={pending}
                className="inline-flex items-center gap-2 bg-[#1d2b38] px-3.5 py-2 text-[10px] font-bold tracking-[.1em] text-[#f5f6f3] disabled:opacity-50"
                data-testid="button-confirm-revert-action-proposal"
              >
                {revert.isPending ? <RefreshCw size={13} className="animate-spin" /> : <RotateCcw size={13} />}
                CONFIRM REVERT
              </button>
              <button
                onClick={() => setConfirmingRevert(false)}
                className="border border-[#d6dfdc] bg-white px-3.5 py-2 text-[10px] font-bold tracking-[.1em] text-[#5a6d73]"
                data-testid="button-cancel-revert-action-proposal"
              >
                BACK
              </button>
            </div>
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
            ? 'PROPOSAL ONLY / NO FILESYSTEM ACTION UNTIL APPROVED, PREFLIGHTED, AND CONFIRMED'
            : status === 'approved'
              ? 'APPROVED / NO FILESYSTEM ACTION UNTIL PREFLIGHT AND EXPLICIT CONFIRMATION'
              : status === 'ready'
                ? 'PREFLIGHT PASSED / EXECUTION REQUIRES EXPLICIT CONFIRMATION'
                : status === 'cancelled'
                  ? `CANCELLED / NO CHANGES APPLIED / ${proposal.events.length} LIFECYCLE EVENTS`
                  : status === 'failed' && counts.completed === 0
                    ? `STOPPED BEFORE EXECUTION / NO CHANGES APPLIED / ${proposal.events.length} LIFECYCLE EVENTS`
                    : `RECORDED IN HISTORY / ${counts.completed} CHANGE(S) APPLIED / ${proposal.events.length} LIFECYCLE EVENTS`}
        </div>
      </div>
    </section>
  );
}

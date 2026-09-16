/**
 * Acquisition jobs — the missing door.
 *
 * The backend runs a full ten-state acquisition lifecycle and records an event
 * for every transition, but until now nothing rendered it: an operator could
 * approve a recommendation, create a job, and then never see that job again.
 * The work continued in the dark.
 *
 * This surface follows the same contract as the action review surface. It
 * reports only what the engine reports, it does not invent progress or
 * outcomes, and where the operator can act it says exactly what the action
 * will do. Where provider work is out of our hands, it says that too.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  Ban,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  PackageCheck,
  RefreshCw,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import {
  useGetAcquisitionJobs,
  useCancelAcquisitionJob,
  useRetryAcquisitionJob,
  useRefreshAcquisitionJob,
  useListActionProposals,
  getGetAcquisitionJobsQueryKey,
  type AcquisitionJob,
  type AcquisitionJobState,
  type ActionProposal,
} from '@workspace/api-client-react';

function errorText(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String((error as Error).message);
  return 'The request failed.';
}

/**
 * The lifecycle as the operator experiences it. `planned` through `complete`
 * is the happy path; failed and cancelled are terminal exits from it.
 */
const PIPELINE: readonly AcquisitionJobState[] = [
  'planned',
  'searching',
  'source_selected',
  'downloading',
  'processing',
  'verifying',
  'importing',
  'complete',
];

/**
 * What each state means in operator language, and crucially who is acting.
 * "Waiting on the provider" is a different kind of waiting than "waiting on
 * you", and conflating them is how a queue starts feeling stuck.
 */
const stateCopy: Record<AcquisitionJobState, { label: string; actor: string; blurb: string }> = {
  planned: { label: 'PLANNED', actor: 'Archive Assistant', blurb: 'Recorded as intent. No provider has been contacted.' },
  searching: { label: 'SEARCHING', actor: 'Provider', blurb: 'The provider is looking for a usable source.' },
  source_selected: { label: 'SOURCE FOUND', actor: 'Provider', blurb: 'A source was chosen and is queued to download.' },
  downloading: { label: 'DOWNLOADING', actor: 'Provider', blurb: 'Bytes are arriving. Nothing has entered the archive yet.' },
  processing: { label: 'PROCESSING', actor: 'Provider', blurb: 'The download is being prepared for verification.' },
  verifying: { label: 'VERIFYING', actor: 'Archive Assistant', blurb: 'Checking the file before it is allowed near the archive.' },
  importing: { label: 'IMPORTING', actor: 'Action engine', blurb: 'A reviewed import action is placing the file into the archive.' },
  complete: { label: 'COMPLETE', actor: '—', blurb: 'The file is in the archive and was verified on arrival.' },
  failed: { label: 'FAILED', actor: 'You', blurb: 'This stopped before the archive changed.' },
  // Cancelled is finished, not waiting. Saying "waiting on you" about a closed
  // job invents an obligation that does not exist.
  cancelled: { label: 'CANCELLED', actor: '—', blurb: 'Stopped on purpose. Nothing was imported.' },
};

const stateTone: Record<AcquisitionJobState, string> = {
  planned: 'border-[#d6dfdc] bg-white text-[#5c6d73]',
  searching: 'border-[#b9d6cf] bg-[#eaf3ef] text-[#39736e]',
  source_selected: 'border-[#b9d6cf] bg-[#eaf3ef] text-[#39736e]',
  downloading: 'border-[#b9d6cf] bg-[#eaf3ef] text-[#39736e]',
  processing: 'border-[#b9d6cf] bg-[#eaf3ef] text-[#39736e]',
  verifying: 'border-[#d9bd77] bg-[#fff8e7] text-[#8d681d]',
  importing: 'border-[#d9bd77] bg-[#fff8e7] text-[#8d681d]',
  complete: 'border-[#b9d6cf] bg-[#eaf3ef] text-[#39736e]',
  failed: 'border-[#e0b3ad] bg-[#fcedea] text-[#994b43]',
  cancelled: 'border-[#d6dfdc] bg-[#f4f9f7] text-[#5c6d73]',
};

function timestampFor(job: AcquisitionJob, state: AcquisitionJobState): string | null {
  const map: Partial<Record<AcquisitionJobState, string | null | undefined>> = {
    planned: job.plannedAt,
    searching: job.searchingAt,
    source_selected: job.sourceSelectedAt,
    downloading: job.downloadingAt,
    processing: job.processingAt,
    verifying: job.verifyingAt,
    importing: job.importingAt,
    complete: job.completedAt,
    failed: job.failedAt,
    cancelled: job.cancelledAt,
  };
  return map[state] ?? null;
}

function shortTime(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * The pipeline as a row of stages, driven entirely by which phase timestamps
 * the backend has actually recorded. A stage is "done" because the engine
 * stamped it, never because a later stage implies it.
 */
function Pipeline({ job }: { job: AcquisitionJob }) {
  const terminated = job.state === 'failed' || job.state === 'cancelled';
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid={`pipeline-acquisition-${job.id}`}>
      {PIPELINE.map((stage) => {
        const at = timestampFor(job, stage);
        const isCurrent = job.state === stage;
        const reached = Boolean(at);
        return (
          <div
            key={stage}
            title={`${stateCopy[stage].label}${at ? ` · ${shortTime(at)}` : ''}`}
            className={`h-1.5 w-8 rounded-full ${
              isCurrent ? 'bg-[#4e9690]' : reached ? 'bg-[#b9d6cf]' : 'bg-[#e7ecea]'
            }`}
            data-testid={`stage-${stage}-${reached ? 'reached' : 'pending'}`}
          />
        );
      })}
      {terminated && <div className="h-1.5 w-8 rounded-full bg-[#e0b3ad]" />}
    </div>
  );
}

function JobCard({ job, importProposal, onReviewImport }: {
  job: AcquisitionJob;
  /** The import proposal this job produced, if the engine has planned one. */
  importProposal?: ActionProposal;
  onReviewImport?: (proposalId: number, job: AcquisitionJob) => void;
}) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [notice, setNotice] = useState('');
  const cancel = useCancelAcquisitionJob();
  const retry = useRetryAcquisitionJob();
  const refresh = useRefreshAcquisitionJob();

  const copy = stateCopy[job.state];
  const pending = cancel.isPending || retry.isPending || refresh.isPending;
  const terminal = job.state === 'complete' || job.state === 'cancelled';
  // Only ask the provider for news while the provider is the one acting.
  const providerDriven = ['searching', 'source_selected', 'downloading', 'processing'].includes(job.state);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getGetAcquisitionJobsQueryKey() });
  const run = (
    mutation: { mutate: (vars: { id: number }, opts: { onSuccess: () => void; onError: (e: unknown) => void }) => void },
    message: string,
  ) => {
    setNotice('');
    mutation.mutate({ id: job.id }, {
      onSuccess: () => { setNotice(message); invalidate(); },
      onError: (error) => setNotice(errorText(error)),
    });
  };

  return (
    <div className="archive-panel p-4 md:p-5" data-testid={`card-acquisition-job-${job.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="archive-mono text-[9px] tracking-[.12em] text-[#7f9194]">
            ACQUISITION #{job.id}{job.providerId ? ` / ${job.providerId.toUpperCase()}` : ''}
          </div>
          <div className="mt-1 truncate text-[13px] font-semibold text-[#21303d]" data-testid={`text-acquisition-title-${job.id}`}>
            {job.title}{job.year ? ` (${job.year})` : ''}
          </div>
        </div>
        <span
          className={`shrink-0 border px-2.5 py-1.5 archive-mono text-[9px] font-bold tracking-[.1em] ${stateTone[job.state]}`}
          data-testid={`badge-acquisition-state-${job.id}`}
        >
          {copy.label}
        </span>
      </div>

      <p className="mt-2 text-[12px] leading-5 text-[#5c6d73]" data-testid={`text-acquisition-narrative-${job.id}`}>
        {copy.blurb}
        {providerDriven && ' Archive Assistant is waiting on the provider, not on you.'}
      </p>

      <div className="mt-3">
        <Pipeline job={job} />
        <div className="mt-2 flex flex-wrap items-center gap-3 archive-mono text-[9px] tracking-[.1em] text-[#8b999c]">
          <span data-testid={`text-acquisition-progress-${job.id}`}>{Math.round(job.progress)}% REPORTED</span>
          <span>WAITING ON / {copy.actor.toUpperCase()}</span>
          {job.downloadJobId && <span data-testid={`text-acquisition-download-link-${job.id}`}>DOWNLOAD #{job.downloadJobId}</span>}
          {job.retryCount > 0 && <span>RETRY {job.retryCount} / {job.maxRetries}</span>}
        </div>
      </div>

      {/*
        The engine's own words for a failure, not a generic apology. Nothing is
        in the archive when a job fails, and saying so is the point.
      */}
      {job.errorMessage && (
        <div className="mt-3 border-l-2 border-[#c85b51] bg-[#fcedea] p-3" data-testid={`text-acquisition-error-${job.id}`}>
          <div className="archive-mono text-[9px] tracking-[.12em] text-[#994b43]">
            {job.errorCode ?? 'FAILED'} / NOTHING WAS IMPORTED
          </div>
          <div className="mt-1 text-[11px] leading-5 text-[#994b43]">{job.errorMessage}</div>
        </div>
      )}

      {notice && (
        <div className="mt-3 border-l-2 border-[#4e9690] bg-[#eaf3ef] p-3 text-[11px] leading-5 text-[#39736e]" role="status" data-testid={`status-acquisition-job-${job.id}`}>
          {notice}
        </div>
      )}

      {/*
        The handoff. A verified download is not the end of anything — it is the
        moment the acquisition system hands ownership to the action engine. Left
        implicit, the operator finishes a download and thinks "now what?", then
        has to go find the Actions tab and recognise their own import there.
        Stating it here keeps one continuous thread.
      */}
      {importProposal && onReviewImport && (
        <div className="mt-3 border-l-2 border-[#4e9690] bg-[#f4f9f7] p-3" data-testid={`panel-import-ready-${job.id}`}>
          <div className="archive-mono text-[9px] tracking-[.12em] text-[#39736e]">
            {importProposal.status === 'completed' ? 'IMPORTED' : 'IMPORT READY'}
          </div>
          <p className="mt-1 text-[11px] leading-5 text-[#39736e]">
            {importProposal.status === 'completed'
              ? 'This file was reviewed, imported, and verified. It is part of the archive now.'
              : 'The download is verified and an import has been planned. Nothing is copied into the archive until you review and approve it.'}
          </p>
          <button
            onClick={() => onReviewImport(importProposal.id, job)}
            className="mt-2 inline-flex items-center gap-2 bg-[#1d2b38] px-3 py-2 text-[10px] font-bold tracking-[.08em] text-[#f5f6f3]"
            data-testid={`button-review-import-${job.id}`}
          >
            {importProposal.status === 'completed' ? 'VIEW IMPORT' : 'REVIEW IMPORT'} <ArrowRight size={13} />
          </button>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {providerDriven && (
          <button
            onClick={() => run(refresh, 'Asked the provider for the latest state.')}
            disabled={pending}
            className="inline-flex items-center gap-2 border border-[#d6dfdc] bg-white px-3 py-2 text-[10px] font-bold tracking-[.08em] text-[#53656b] disabled:opacity-50"
            data-testid={`button-refresh-acquisition-${job.id}`}
          >
            <RefreshCw size={13} className={refresh.isPending ? 'animate-spin' : ''} /> ASK PROVIDER
          </button>
        )}
        {job.state === 'failed' && (
          <button
            onClick={() => run(retry, 'Retry requested. Provider work starts again from planning.')}
            disabled={pending}
            className="inline-flex items-center gap-2 border border-[#d9bd77] bg-[#fff8e7] px-3 py-2 text-[10px] font-bold tracking-[.08em] text-[#8d681d] disabled:opacity-50"
            data-testid={`button-retry-acquisition-${job.id}`}
          >
            <RotateCcw size={13} /> TRY AGAIN
          </button>
        )}
        {!terminal && (
          <button
            onClick={() => run(cancel, 'Cancelled. Nothing was imported.')}
            disabled={pending}
            className="inline-flex items-center gap-2 border border-[#e0b3ad] bg-white px-3 py-2 text-[10px] font-bold tracking-[.08em] text-[#994b43] disabled:opacity-50"
            data-testid={`button-cancel-acquisition-${job.id}`}
          >
            <Ban size={13} /> STOP
          </button>
        )}
        <button
          onClick={() => setExpanded((value) => !value)}
          className="ml-auto inline-flex items-center gap-1.5 archive-mono text-[9px] font-bold tracking-[.1em] text-[#7f9194]"
          data-testid={`button-toggle-acquisition-events-${job.id}`}
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {job.events.length} {job.events.length === 1 ? 'EVENT' : 'EVENTS'}
        </button>
      </div>

      {/* Progressive disclosure: the full provenance is one click away. */}
      {expanded && (
        <ol className="mt-3 space-y-1.5 border-t border-[#e7ecea] pt-3" data-testid={`list-acquisition-events-${job.id}`}>
          {job.events.map((event) => (
            <li key={event.id} className="flex flex-wrap items-baseline gap-2 text-[11px] leading-5 text-[#5c6d73]">
              <span className="archive-mono text-[9px] tracking-[.08em] text-[#a0afaf]">{shortTime(event.createdAt)}</span>
              {event.fromState && (
                <span className="archive-mono text-[9px] tracking-[.08em] text-[#8b999c]">
                  {event.fromState.toUpperCase()} → {String(event.toState).toUpperCase()}
                </span>
              )}
              <span>{event.detail}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function AcquisitionJobsPanel({ onReviewImport }: {
  /** Opens the standard action review surface, so import has no second UI. */
  onReviewImport?: (proposalId: number, job: AcquisitionJob) => void;
} = {}) {
  const { data: jobs, isLoading, isError, refetch } = useGetAcquisitionJobs();
  // An import proposal records the acquisition job it came from, so the two
  // halves of the chain can be joined without a new endpoint.
  const { data: proposals } = useListActionProposals({ type: 'import' });
  const importByJob = new Map<number, ActionProposal>();
  for (const proposal of proposals ?? []) {
    if (typeof proposal.acquisitionJobId === 'number') importByJob.set(proposal.acquisitionJobId, proposal);
  }

  if (isLoading) {
    return (
      <section className="archive-panel p-5" data-testid="panel-acquisition-jobs-loading">
        <div className="h-24 animate-pulse bg-[#f4f9f7]" />
      </section>
    );
  }

  if (isError) {
    return (
      <section className="archive-panel p-6 text-center" data-testid="panel-acquisition-jobs-error">
        <CircleAlert size={22} className="mx-auto mb-3 text-[#c85b51]" />
        <h3 className="archive-display text-lg font-extrabold text-[#21303d]">Acquisition jobs could not be read</h3>
        <p className="mx-auto mt-2 max-w-sm text-[12px] leading-5 text-[#7d8c8f]">
          No job state is being guessed in the browser. Retry the read to see the current truth.
        </p>
        <button
          onClick={() => refetch()}
          className="mt-4 inline-flex items-center gap-2 bg-[#1d2b38] px-4 py-2.5 text-[10px] font-bold tracking-[.1em] text-[#f5f6f3]"
          data-testid="button-retry-acquisition-jobs"
        >
          <RefreshCw size={13} /> RETRY
        </button>
      </section>
    );
  }

  const list = jobs ?? [];
  if (!list.length) {
    return (
      <section className="archive-panel flex min-h-[220px] flex-col items-center justify-center p-8 text-center" data-testid="panel-acquisition-jobs-empty">
        <Sparkles size={24} className="mb-3 text-[#4e9690]" />
        <h3 className="archive-display text-xl font-extrabold text-[#21303d]">No acquisitions in flight</h3>
        <p className="mt-2 max-w-md text-[12px] leading-6 text-[#7d8c8f]">
          Approved acquisition recommendations appear here as jobs, and stay visible through
          searching, downloading, verification, and import. Nothing reaches the archive without
          a reviewed import action.
        </p>
      </section>
    );
  }

  const active = list.filter((job) => !['complete', 'failed', 'cancelled'].includes(job.state));
  const needsYou = list.filter((job) => job.state === 'failed');
  const done = list.filter((job) => job.state === 'complete');

  return (
    <section className="space-y-4" data-testid="panel-acquisition-jobs">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="archive-mono text-[9px] tracking-[.12em] text-[#7f9194]">ACQUISITION / IN FLIGHT</div>
          <h3 className="archive-display mt-1 text-lg font-extrabold text-[#21303d]">
            {active.length ? `${active.length} acquisition${active.length === 1 ? '' : 's'} in progress` : 'No acquisitions in progress'}
          </h3>
        </div>
        <div className="flex flex-wrap gap-2 archive-mono text-[9px] tracking-[.08em] text-[#7d8d90]">
          <span className="border border-[#d8e1de] bg-white/60 px-2 py-1" data-testid="text-acquisition-count-active">{active.length} ACTIVE</span>
          {needsYou.length > 0 && (
            <span className="border border-[#e0b3ad] bg-[#fcedea] px-2 py-1 text-[#994b43]" data-testid="text-acquisition-count-failed">
              {needsYou.length} NEEDS YOU
            </span>
          )}
          <span className="border border-[#d8e1de] bg-white/60 px-2 py-1" data-testid="text-acquisition-count-total">{list.length} TOTAL</span>
        </div>
      </div>

      {done.length > 0 && (
        <div className="flex items-center gap-2 border-l-2 border-[#4e9690] bg-[#f4f9f7] p-3 text-[11px] leading-5 text-[#39736e]" data-testid="text-acquisition-completed-summary">
          <PackageCheck size={14} className="shrink-0" />
          {done.length} completed {done.length === 1 ? 'acquisition is' : 'acquisitions are'} now part of the archive and
          appear in the inventory and history.
        </div>
      )}

      <div className="space-y-3">
        {[...needsYou, ...active, ...list.filter((job) => job.state === 'complete' || job.state === 'cancelled')].map((job) => (
          <JobCard
            key={job.id}
            job={job}
            importProposal={importByJob.get(job.id)}
            onReviewImport={onReviewImport}
          />
        ))}
      </div>
    </section>
  );
}

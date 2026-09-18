import { useState } from 'react';
import { Boxes, Link2, PackageCheck } from 'lucide-react';
import type { AcquisitionJob, DownloadJob } from '@workspace/api-client-react';

// ---------------------------------------------------------------------------
// Acquisition jobs panel
//
// The back half of the acquisition lifecycle already existed as services and
// HTTP routes, but had no operator surface: a provider download could be
// tracked, yet nothing in the application could link it to its local download
// or plan its import into the archive. This panel is that missing connective
// tissue.
//
// It deliberately does not execute the import. Planning produces an archive
// operation, and that operation goes through the same preflight and explicit
// execution confirmation as every other filesystem mutation, in the SAFE
// OPERATIONS panel. Import is a file-creating operation, so it must not get a
// shortcut that renames and moves do not have.
// ---------------------------------------------------------------------------

export type AcquisitionJobsPanelProps = {
  jobs: AcquisitionJob[];
  downloads: DownloadJob[];
  busy?: boolean;
  onLinkDownload: (jobId: number, downloadJobId: number) => Promise<void> | void;
  onPlanImport: (jobId: number, destinationPath: string) => Promise<void> | void;
  onRefreshJob?: (jobId: number) => Promise<void> | void;
};

/**
 * planApprovedAcquisitionImport refuses anything that is not a complete,
 * verified download with a final path. Offering other downloads as link
 * candidates would only produce a server error later, so the same rule is
 * applied here.
 */
export function importableDownloads(downloads: DownloadJob[]): DownloadJob[] {
  return downloads.filter((download) =>
    download.status === 'complete'
    && download.verification === 'passed'
    && Boolean(download.finalPath));
}

function stateTone(state: AcquisitionJob['state']): string {
  if (state === 'complete') return 'text-[#39736e]';
  if (state === 'failed') return 'text-[#a24d46]';
  if (state === 'cancelled') return 'text-[#8b999c]';
  return 'text-[#80652e]';
}

export function AcquisitionJobsPanel({
  jobs,
  downloads,
  busy = false,
  onLinkDownload,
  onPlanImport,
  onRefreshJob,
}: AcquisitionJobsPanelProps) {
  const [selectedDownload, setSelectedDownload] = useState<Record<number, string>>({});
  const [destination, setDestination] = useState<Record<number, string>>({});
  const candidates = importableDownloads(downloads);

  return (
    <section className="archive-panel p-5" data-testid="panel-acquisition-jobs">
      <div className="flex items-center justify-between">
        <div className="archive-mono text-[9px] tracking-[.14em] text-[#7d9093]">ACQUISITION JOBS</div>
        <span className="archive-mono text-[9px] text-[#a0aaaa]">{jobs.length} TRACKED</span>
      </div>

      <div className="mt-4 space-y-4">
        {jobs.map((job) => {
          const linked = job.downloadJobId !== null;
          const chosen = selectedDownload[job.id] ?? '';
          const target = destination[job.id] ?? '';
          const linkedDownload = linked
            ? downloads.find((download) => download.id === job.downloadJobId)
            : undefined;
          // The server requires a complete, verified download before it will
          // plan an import. Reflect that here so the button is not offered in
          // a state the engine will reject.
          const importable = Boolean(
            linkedDownload
            && linkedDownload.status === 'complete'
            && linkedDownload.verification === 'passed'
            && linkedDownload.finalPath,
          );

          return (
            <article key={job.id} className="border-t border-[#e3e8e7] pt-3" data-testid={`row-acquisition-job-${job.id}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-[11px] font-bold text-[#42545b]">
                    {job.title}
                    {job.year ? ` (${job.year})` : ''}
                  </div>
                  <div className="archive-mono mt-1 text-[9px] text-[#8b999c]">
                    #{job.id} / {job.providerId ?? 'no provider'} / {job.progress}%
                  </div>
                </div>
                <span
                  className={`archive-mono shrink-0 text-[9px] font-bold uppercase ${stateTone(job.state)}`}
                  data-testid={`text-acquisition-state-${job.id}`}
                >
                  {job.state}
                </span>
              </div>

              {job.errorMessage && (
                <div className="mt-2 text-[10px] leading-5 text-[#a24d46]">{job.errorMessage}</div>
              )}

              {linked ? (
                <div className="mt-2 text-[10px] text-[#66787d]" data-testid={`text-linked-download-${job.id}`}>
                  Linked to download #{job.downloadJobId}
                  {linkedDownload ? ` · ${linkedDownload.status} / ${linkedDownload.verification}` : ''}
                  {linkedDownload?.finalPath ? (
                    <span className="archive-mono mt-1 block truncate text-[9px] text-[#8b999c]">
                      {linkedDownload.finalPath}
                    </span>
                  ) : null}
                </div>
              ) : (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <select
                    value={chosen}
                    disabled={busy || candidates.length === 0}
                    onChange={(event) => setSelectedDownload((current) => ({ ...current, [job.id]: event.target.value }))}
                    className="min-w-0 flex-1 border border-[#d7e1de] bg-white/60 px-2 py-2 text-[10px] text-[#43545b] disabled:opacity-50"
                    data-testid={`select-download-${job.id}`}
                  >
                    <option value="">
                      {candidates.length ? 'Select a verified download' : 'No verified downloads available'}
                    </option>
                    {candidates.map((download) => (
                      <option key={download.id} value={String(download.id)}>
                        #{download.id} {download.title}
                      </option>
                    ))}
                  </select>
                  <button
                    disabled={busy || !chosen}
                    onClick={() => onLinkDownload(job.id, Number(chosen))}
                    className="inline-flex items-center gap-1 border border-[#5a938a] px-3 py-2 text-[9px] font-bold tracking-[.1em] text-[#39736e] disabled:opacity-40"
                    data-testid={`button-link-download-${job.id}`}
                  >
                    <Link2 size={12} /> LINK DOWNLOAD
                  </button>
                </div>
              )}

              {linked && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    value={target}
                    disabled={busy || !importable}
                    placeholder="Archive destination path"
                    onChange={(event) => setDestination((current) => ({ ...current, [job.id]: event.target.value }))}
                    className="min-w-0 flex-1 border border-[#d7e1de] bg-white/60 px-2 py-2 text-[10px] text-[#43545b] disabled:opacity-50"
                    data-testid={`input-import-destination-${job.id}`}
                  />
                  <button
                    disabled={busy || !importable || !target.trim()}
                    onClick={() => onPlanImport(job.id, target.trim())}
                    className="inline-flex items-center gap-1 bg-[#1d2b38] px-3 py-2 text-[9px] font-bold tracking-[.1em] text-white disabled:opacity-40"
                    data-testid={`button-plan-import-${job.id}`}
                  >
                    <PackageCheck size={12} /> PLAN IMPORT
                  </button>
                </div>
              )}

              {linked && !importable && (
                <p className="mt-2 text-[9px] leading-4 text-[#8b999c]" data-testid={`text-import-blocked-${job.id}`}>
                  The linked download must be complete and verified before an import can be planned.
                </p>
              )}

              {linked && importable && (
                <p className="mt-2 text-[9px] leading-4 text-[#8b999c]">
                  Planning creates a safe operation. It still requires preflight and explicit execution
                  confirmation before any file is written.
                </p>
              )}

              {onRefreshJob && ['searching', 'source_selected', 'downloading', 'processing'].includes(job.state) && (
                <button
                  disabled={busy}
                  onClick={() => onRefreshJob(job.id)}
                  className="mt-2 border border-[#d7e1de] px-2 py-1 text-[8px] font-bold tracking-[.1em] text-[#6c7d81] disabled:opacity-40"
                  data-testid={`button-refresh-job-${job.id}`}
                >
                  REFRESH FROM PROVIDER
                </button>
              )}

              {job.events.length > 0 && (
                <details className="mt-2 text-[9px] text-[#75868a]">
                  <summary>{job.events.length} transitions</summary>
                  {job.events.map((event) => (
                    <div key={event.id} className="mt-1">
                      {event.fromState ? `${event.fromState} → ` : ''}
                      {event.toState}
                      {event.detail ? ` · ${event.detail}` : ''}
                    </div>
                  ))}
                </details>
              )}
            </article>
          );
        })}

        {jobs.length === 0 && (
          <div className="flex flex-col items-center py-6 text-center" data-testid="text-no-acquisition-jobs">
            <Boxes size={22} className="mb-2 text-[#9aa9aa]" />
            <p className="text-[11px] leading-5 text-[#829095]">
              No acquisition jobs. Approve an acquisition recommendation and create a job to begin.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

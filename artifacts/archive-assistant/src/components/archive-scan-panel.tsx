import { useEffect, useState } from 'react';
import { Activity, Check, X } from 'lucide-react';
import type { ScanActiveItem, ScanLiveState, ScanMetrics, ScanStageName } from '@/hooks/use-archive-scan-events';

// ---------------------------------------------------------------------------
// Live archive scan panel
//
// Renders the bounded working set streamed from /api/archive/scan/events:
// aggregate progress, the current in-flight file with its real scanner stages
// (inspect → probe → register), and the last 20 completed/failed files.
// ---------------------------------------------------------------------------

const STAGE_ORDER: ScanStageName[] = ['inspect', 'probe', 'register'];
const STAGE_LABELS: Record<ScanStageName, string> = {
  inspect: 'INSPECT',
  probe: 'FFPROBE',
  register: 'REGISTER',
};

type StageStatus = 'done' | 'active' | 'pending' | 'skipped';

function stageStatus(item: ScanActiveItem, stage: ScanStageName): StageStatus {
  const entry = item.stages.find((candidate) => candidate.stage === stage);
  if (entry) return entry.status;
  // The scanner skips FFprobe for unchanged files; the register boundary
  // arriving without a probe stage is the real signal of that skip.
  if (stage === 'probe' && item.stages.some((candidate) => candidate.stage === 'register')) {
    return 'skipped';
  }
  return 'pending';
}

function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const padded = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${padded(minutes)}:${padded(seconds)}` : `${padded(minutes)}:${padded(seconds)}`;
}

function formatClock(iso: string): string {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return '';
  return time.toLocaleTimeString([], { hour12: false });
}

function useElapsedTime(live: ScanLiveState): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (live.status !== 'scanning' || !live.startedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live.status, live.startedAt]);
  if (!live.startedAt) return '—';
  const end = live.status === 'scanning' ? now : live.completedAt ? Date.parse(live.completedAt) : now;
  return formatDuration(end - Date.parse(live.startedAt));
}

function StageRow({ index, label, status }: { index: number; label: string; status: StageStatus }) {
  const marker =
    status === 'done' ? <Check size={12} className="text-[#4e9690]" strokeWidth={3} />
    : status === 'active' ? <span className="block h-2 w-2 animate-pulse rounded-full bg-[#39736e]" />
    : status === 'skipped' ? <span className="archive-mono text-[8px] tracking-[.08em] text-[#a0afaf]">SKIP</span>
    : <span className="block h-2 w-2 rounded-full border border-[#c3d2cf] bg-transparent" />;
  return (
    <div className="flex items-center gap-3 border-b border-[#edf1ef] py-1.5 last:border-b-0">
      <span className="archive-mono w-4 text-[9px] text-[#a0afaf]">{String(index + 1).padStart(2, '0')}</span>
      <span className={`archive-mono flex-1 text-[9px] tracking-[.1em] ${status === 'pending' ? 'text-[#a0afaf]' : 'text-[#53656b]'}`}>{label}</span>
      <span className="grid h-4 w-4 place-items-center">{marker}</span>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = units[0];
  for (const candidate of units) {
    value /= 1024;
    unit = candidate;
    if (value < 1024 || candidate === units.at(-1)) break;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function formatMetricDuration(ms: number): string {
  return `${Number.isFinite(ms) ? Math.round(ms) : 0} ms`;
}

function ScanDiagnostics({ live, metrics }: { live: ScanLiveState; metrics: ScanMetrics }) {
  return (
    <details className="border-t border-[#e3e8e7] bg-[#fbfcfa]" data-testid="scan-diagnostics">
      <summary className="archive-mono cursor-pointer list-none px-4 py-3 text-[9px] font-bold tracking-[.14em] text-[#8a9b9e] md:px-6">
        SCAN DIAGNOSTICS <span className="ml-2 font-normal tracking-[.08em] text-[#a0afaf]">TEMPORARY</span>
      </summary>
      <div className="border-t border-[#edf1ef] px-4 pb-5 pt-4 md:px-6">
        <div className="grid gap-x-6 gap-y-2 text-[10px] text-[#53656b] sm:grid-cols-2 lg:grid-cols-3">
          <div><span className="archive-mono text-[8px] text-[#8a9b9e]">FILES PROCESSED</span><div>{metrics.files.toLocaleString()}</div></div>
          <div><span className="archive-mono text-[8px] text-[#8a9b9e]">TOTAL BYTES</span><div>{formatBytes(metrics.totalFileBytes)} <span className="text-[#a0afaf]">({metrics.totalFileBytes.toLocaleString()} B)</span></div></div>
          <div><span className="archive-mono text-[8px] text-[#8a9b9e]">UNCHANGED FILES</span><div>{metrics.unchangedFiles.toLocaleString()}</div></div>
          <div><span className="archive-mono text-[8px] text-[#8a9b9e]">STAT / INSPECT</span><div>{metrics.inspect.count.toLocaleString()} calls · {formatMetricDuration(metrics.inspect.durationMs)}</div></div>
          <div><span className="archive-mono text-[8px] text-[#8a9b9e]">FFPROBE</span><div>{metrics.ffprobe.invocations.toLocaleString()} calls · {formatMetricDuration(metrics.ffprobe.durationMs)}</div></div>
          <div><span className="archive-mono text-[8px] text-[#8a9b9e]">CHECKSUM</span><div>{metrics.checksum.invocations.toLocaleString()} calls · {formatMetricDuration(metrics.checksum.durationMs)} · {formatBytes(metrics.checksum.bytesHashed)} hashed</div></div>
          <div><span className="archive-mono text-[8px] text-[#8a9b9e]">REGISTRATION</span><div>{metrics.registration.files.toLocaleString()} files · {formatMetricDuration(metrics.registration.durationMs)}</div></div>
          <div><span className="archive-mono text-[8px] text-[#8a9b9e]">SQLITE STATEMENTS</span><div>{metrics.registration.sqliteStatements.toLocaleString()}</div></div>
          <div><span className="archive-mono text-[8px] text-[#8a9b9e]">FINAL INVENTORY</span><div>{metrics.finalInventory.rebuilds.toLocaleString()} rebuilds · {formatMetricDuration(metrics.finalInventory.durationMs)}</div></div>
        </div>
        <div className="mt-5">
          <div className="archive-mono text-[8px] font-bold tracking-[.12em] text-[#8a9b9e]">RECENT FILE SAMPLE</div>
          {live.recentItems.length === 0 ? (
            <div className="archive-mono mt-2 text-[9px] text-[#a0afaf]">NO RECENT FILES</div>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-[10px] text-[#53656b]" data-testid="scan-diagnostics-recent">
                <thead className="archive-mono text-[8px] tracking-[.08em] text-[#a0afaf]">
                  <tr><th className="pb-1 pr-3 font-normal">FILENAME</th><th className="pb-1 pr-3 font-normal">FILE BYTES</th><th className="pb-1 pr-3 font-normal">DURATION</th><th className="pb-1 font-normal">OUTCOME</th></tr>
                </thead>
                <tbody>
                  {live.recentItems.map((item) => (
                    <tr key={`${item.path}-${item.completedAt}`} className="border-t border-[#edf1ef]">
                      <td className="max-w-[260px] truncate py-1.5 pr-3" title={item.filename}>{item.filename}</td>
                      <td className="archive-mono py-1.5 pr-3">{item.fileBytes == null ? '—' : `${item.fileBytes.toLocaleString()} B`}</td>
                      <td className="archive-mono py-1.5 pr-3">{formatDuration(item.durationMs)}</td>
                      <td className="archive-mono py-1.5">{item.outcome.toUpperCase()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </details>
  );
}

export function ArchiveScanPanel({ live }: { live: ScanLiveState }) {
  const elapsed = useElapsedTime(live);
  const scanning = live.status === 'scanning';
  const hasSession = Boolean(live.sessionId) || live.status !== 'idle';

  if (!hasSession) {
    return (
      <section className="archive-panel mb-7 flex flex-wrap items-center justify-between gap-3 p-4 md:px-6" data-testid="panel-archive-scan">
        <div className="flex items-center gap-3">
          <Activity size={14} className={live.connected ? 'text-[#4e9690]' : 'text-[#a0afaf]'} />
          <span className="archive-mono text-[10px] tracking-[.12em] text-[#7f9194]">
            ARCHIVE SCAN / LIVE FEED {live.connected ? 'CONNECTED' : 'CONNECTING…'}
          </span>
        </div>
        <span className="archive-mono text-[9px] tracking-[.08em] text-[#a0afaf]">
          START A SCAN TO WATCH THE PIPELINE IN REAL TIME
        </span>
      </section>
    );
  }

  // Discovery and scanning run concurrently, so `discovered` keeps growing
  // while files are being scanned. Rendering "432 / 436" against a moving
  // denominator reads as a nearly-finished fixed-total progress bar when the
  // real total is still unknown — on a large archive that "436" became 37,739.
  //
  // A percentage is only honest once discovery has finished and the
  // denominator has stopped moving. Until then the two numbers are reported
  // side by side as what they actually are.
  const discoveryFinished = live.discoveryComplete;
  const denominator = live.discovered;
  const hasTrustworthyTotal = discoveryFinished && denominator > 0;
  const percent = hasTrustworthyTotal
    ? Math.min(100, Math.round((live.scanned / denominator) * 100))
    : null;
  const statusLabel = scanning ? 'SCANNING' : live.status === 'failed' ? 'FAILED' : 'COMPLETED';
  const statusTone = scanning ? 'bg-[#dcebe7] text-[#39736e]' : live.status === 'failed' ? 'bg-[#fcedea] text-[#994b43]' : 'bg-[#eaf3ef] text-[#39736e]';
  const current = live.currentItem;

  return (
    <section className="archive-panel mb-7" data-testid="panel-archive-scan">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e3e8e7] bg-[#fbfcfa] p-4 md:px-6">
        <div className="flex items-center gap-3">
          <Activity size={14} className={scanning ? 'animate-pulse text-[#39736e]' : 'text-[#7f9194]'} />
          <span className="archive-mono text-[10px] font-bold tracking-[.14em] text-[#53656b]">ARCHIVE SCAN</span>
          <span className={`grid h-6 place-items-center px-2 text-[9px] font-bold tracking-[.08em] ${statusTone}`} data-testid="status-archive-scan-live">
            {statusLabel}
          </span>
          {!live.connected && (
            <span className="archive-mono text-[9px] tracking-[.08em] text-[#a77517]" data-testid="status-archive-scan-reconnecting">
              FEED RECONNECTING
            </span>
          )}
        </div>
        <span className="archive-mono text-[9px] tracking-[.08em] text-[#a0afaf]">
          ELAPSED {elapsed}
        </span>
      </div>

      <div className="grid gap-6 p-4 md:p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
        <div data-testid="panel-archive-scan-progress">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="archive-display text-[30px] font-extrabold leading-none text-[#2b3d46]" data-testid="text-scan-counter">
                {hasTrustworthyTotal ? (
                  <>
                    {live.scanned.toLocaleString()}
                    <span className="text-[18px] font-bold text-[#8a9b9e]"> / {denominator.toLocaleString()}</span>
                  </>
                ) : (
                  <>
                    {live.scanned.toLocaleString()}
                    <span className="text-[18px] font-bold text-[#8a9b9e]"> scanned</span>
                    {denominator > 0 && (
                      <span className="text-[18px] font-bold text-[#8a9b9e]">
                        {' · '}
                        {denominator.toLocaleString()} discovered
                      </span>
                    )}
                  </>
                )}
              </div>
              <div className="archive-mono mt-2 text-[9px] tracking-[.1em] text-[#7f9194]" data-testid="text-scan-discovery-state">
                {hasTrustworthyTotal
                  ? 'FILES SCANNED / DISCOVERY COMPLETE'
                  : denominator > 0
                    ? 'DISCOVERING ARCHIVE / TOTAL NOT YET KNOWN'
                    : 'DISCOVERING ARCHIVE'}
              </div>
            </div>
            <div className="archive-mono text-right text-[9px] leading-5 tracking-[.08em]">
              <div className={live.failed > 0 ? 'text-[#994b43]' : 'text-[#7f9194]'}>FAILURES {live.failed}</div>
              <div className="text-[#7f9194]">IN FLIGHT {live.activeItems.length}</div>
            </div>
          </div>
          {percent === null ? (
            // An indeterminate bar: work is happening, but no fraction of it
            // is known. Reporting a percentage here would be a guess.
            <div
              className="mt-4 h-2 w-full overflow-hidden bg-[#e3e8e7]"
              role="progressbar"
              aria-label="Discovering archive files"
              data-testid="progress-archive-scan-indeterminate"
            >
              <div className={`h-full w-1/3 bg-[#39736e] ${scanning ? 'animate-pulse' : ''}`} />
            </div>
          ) : (
            <div
              className="mt-4 h-2 w-full bg-[#e3e8e7]"
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              data-testid="progress-archive-scan"
            >
              <div
                className={`h-full bg-[#39736e] transition-[width] duration-300 ${scanning ? 'animate-pulse' : ''}`}
                style={{ width: `${percent}%` }}
              />
            </div>
          )}
          {live.lastError && (
            <div className={`mt-4 border-l-2 p-3 text-[11px] leading-5 ${live.status === 'failed' ? 'border-[#c85b51] bg-[#fcedea] text-[#994b43]' : 'border-[#d9bd77] bg-[#fff8e7] text-[#80652e]'}`} data-testid="status-archive-scan-error">
              {live.lastError}
            </div>
          )}
        </div>

        <div data-testid="panel-archive-scan-current">
          <div className="flex items-center justify-between">
            <span className="archive-mono text-[9px] font-bold tracking-[.14em] text-[#7f9194]">CURRENT</span>
            {live.activeItems.length > 1 && (
              <span className="archive-mono text-[9px] tracking-[.08em] text-[#a0afaf]">+{live.activeItems.length - 1} MORE IN FLIGHT</span>
            )}
          </div>
          {current ? (
            <>
              <div className="mt-2 flex items-center gap-2">
                <span className="truncate text-[13px] font-bold text-[#344851]" title={current.filename}>{current.title}</span>
                {current.mediaType && (
                  <span className="grid h-5 shrink-0 place-items-center bg-[#eaf3ef] px-1.5 text-[8px] font-bold tracking-[.08em] text-[#39736e]">
                    {current.mediaType.toUpperCase()}
                  </span>
                )}
              </div>
              <div className="archive-mono mt-1 break-all text-[9px] leading-4 text-[#8a9b9e]">{current.path}</div>
              <div className="mt-3 border border-[#e1e8e5] bg-white/60 px-3 py-1">
                {STAGE_ORDER.map((stage, index) => (
                  <StageRow key={stage} index={index} label={STAGE_LABELS[stage]} status={stageStatus(current, stage)} />
                ))}
              </div>
            </>
          ) : (
            <div className="archive-mono mt-3 border border-dashed border-[#d6dfdc] bg-[#f8faf8] p-4 text-center text-[9px] tracking-[.1em] text-[#a0afaf]">
              {scanning ? 'AWAITING NEXT FILE…' : 'PIPELINE IDLE'}
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-[#e3e8e7] p-4 md:p-6" data-testid="panel-archive-scan-recent">
        <div className="flex items-center justify-between">
          <span className="archive-mono text-[9px] font-bold tracking-[.14em] text-[#7f9194]">RECENT</span>
          <span className="archive-mono text-[9px] tracking-[.08em] text-[#a0afaf]">LAST {live.recentItems.length}</span>
        </div>
        {live.recentItems.length === 0 ? (
          <div className="archive-mono mt-3 text-[9px] tracking-[.1em] text-[#a0afaf]">NO COMPLETED FILES YET</div>
        ) : (
          <div className="mt-3 max-h-[220px] space-y-1.5 overflow-y-auto pr-1">
            {live.recentItems.map((item) => (
              <div
                key={`${item.path}-${item.completedAt}`}
                className={`flex items-center gap-3 border px-3 py-2 ${item.outcome === 'failed' ? 'border-[#e2b9b4] bg-[#fcedea]' : 'border-[#e1e8e5] bg-white/50'}`}
                data-testid="row-archive-scan-recent"
              >
                <span className="grid h-4 w-4 shrink-0 place-items-center">
                  {item.outcome === 'failed'
                    ? <X size={12} className="text-[#c85b51]" strokeWidth={3} />
                    : <Check size={12} className={item.outcome === 'registered' ? 'text-[#4e9690]' : 'text-[#a0afaf]'} strokeWidth={3} />}
                </span>
                <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-[#43545b]" title={item.outcome === 'failed' ? `${item.path} — ${item.error ?? ''}` : item.path}>
                  {item.title}
                </span>
                {item.outcome === 'failed' ? (
                  <span className="archive-mono shrink-0 text-[8px] font-bold tracking-[.06em] text-[#994b43]" title={item.error ?? undefined}>FAILED</span>
                ) : item.outcome === 'unchanged' ? (
                  <span className="archive-mono shrink-0 text-[8px] tracking-[.06em] text-[#a0afaf]">UNCHANGED</span>
                ) : (
                  <span className="archive-mono shrink-0 text-[8px] tracking-[.06em] text-[#39736e]">REGISTERED</span>
                )}
                <span className="archive-mono shrink-0 text-[8px] text-[#a0afaf]">{formatClock(item.completedAt)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {live.metrics && <ScanDiagnostics live={live} metrics={live.metrics} />}
    </section>
  );
}

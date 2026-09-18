import { Database, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useGetStorageDiagnostics } from '@workspace/api-client-react';

/**
 * Storage diagnostics.
 *
 * A packaged Windows build came up with Plex unconfigured and an archive that
 * had to be rescanned, while the database at the expected AppData location
 * held almost nothing. Which file the running process actually opened cannot
 * be determined by reading source: ARCHIVE_DB_PATH decides it, and when that
 * variable does not arrive the server silently creates a fresh database under
 * its working directory and reports healthy.
 *
 * This panel puts that answer on screen so no future Windows build requires
 * guessing. It deliberately shows filesystem paths -- the surrounding
 * capability panel omits them by design, but here the path IS the diagnosis.
 * It never shows credentials: Plex appears as a configured/not-configured
 * state only.
 */

function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'unreadable';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export function StorageDiagnosticsPanel() {
  const { data, isLoading, isError } = useGetStorageDiagnostics();

  if (isLoading) {
    return (
      <section className="archive-panel mb-5 p-5 md:p-6" data-testid="panel-storage-diagnostics-loading">
        <div className="archive-mono text-[10px] tracking-[.14em] text-[#7f9194]">DATABASE</div>
        <div className="mt-2 text-[11px] text-[#879599]">Reading storage diagnostics from the local node.</div>
      </section>
    );
  }

  if (isError || !data) {
    return (
      <section className="archive-panel mb-5 p-5 md:p-6" data-testid="panel-storage-diagnostics-error">
        <div className="archive-mono text-[10px] tracking-[.14em] text-[#7f9194]">DATABASE</div>
        <div className="mt-2 text-[11px] text-[#c85b51]">
          Storage diagnostics could not be read from the local node.
        </div>
      </section>
    );
  }

  // The fallback source is the failure we are hunting: it means the process
  // never opened the persistent application database.
  const usingFallback = data.databasePathSource === 'working_directory_fallback';

  const counts: Array<[string, number]> = [
    ['LOCAL RECORDS', data.counts.fileRecords],
    ['ACTIVE', data.counts.activeFileRecords],
    ['PLEX RECORDS', data.counts.plexItems],
    ['REVIEW ITEMS', data.counts.reviewItems],
    ['OPERATIONS', data.counts.archiveOperations],
    ['SETTINGS', data.counts.settings],
  ];

  return (
    <section className="archive-panel mb-5 p-5 md:p-6" data-testid="panel-storage-diagnostics">
      <div className="flex items-center gap-3">
        <span className="grid h-8 w-8 place-items-center bg-[#e8efed] text-[#4e9690]">
          <Database size={15} />
        </span>
        <div>
          <div className="archive-mono text-[10px] tracking-[.14em] text-[#7f9194]">DATABASE</div>
          <h2 className="archive-display text-lg font-extrabold text-[#354851]">Active storage</h2>
        </div>
      </div>

      {usingFallback ? (
        <div
          className="mt-4 flex gap-3 border-l-2 border-[#c85b51] bg-[#fcedea] p-3"
          data-testid="status-storage-fallback"
        >
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-[#994b43]" />
          <div className="text-[11px] leading-5 text-[#994b43]">
            <strong>This is not the persistent application database.</strong> ARCHIVE_DB_PATH did not
            reach this process, so a database was created under the working directory. Anything saved
            here — including the Plex connection — will appear to vanish on the next launch.
          </div>
        </div>
      ) : (
        <div
          className="mt-4 flex gap-3 border-l-2 border-[#39736e] bg-[#eaf3ef] p-3"
          data-testid="status-storage-configured"
        >
          <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-[#39736e]" />
          <div className="text-[11px] leading-5 text-[#39736e]">
            The application database path was supplied explicitly by the desktop shell.
          </div>
        </div>
      )}

      <dl className="mt-4 space-y-3">
        <div>
          <dt className="archive-mono text-[9px] tracking-[.12em] text-[#879599]">PATH</dt>
          <dd
            className="archive-mono mt-1 break-all text-[11px] text-[#354851]"
            data-testid="text-storage-database-path"
          >
            {data.databasePath}
          </dd>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="archive-mono text-[9px] tracking-[.12em] text-[#879599]">SOURCE</dt>
            <dd
              className={`archive-mono mt-1 text-[11px] font-bold ${usingFallback ? 'text-[#994b43]' : 'text-[#39736e]'}`}
              data-testid="text-storage-path-source"
            >
              {data.databasePathSource === 'ARCHIVE_DB_PATH' ? 'ARCHIVE_DB_PATH' : 'WORKING_DIRECTORY_FALLBACK'}
            </dd>
          </div>
          <div>
            <dt className="archive-mono text-[9px] tracking-[.12em] text-[#879599]">SIZE ON DISK</dt>
            <dd className="archive-mono mt-1 text-[11px] text-[#354851]" data-testid="text-storage-size">
              {formatBytes(data.databaseSizeBytes)}
            </dd>
          </div>
        </div>
        <div>
          <dt className="archive-mono text-[9px] tracking-[.12em] text-[#879599]">WORKING DIRECTORY</dt>
          <dd
            className="archive-mono mt-1 break-all text-[11px] text-[#53656b]"
            data-testid="text-storage-cwd"
          >
            {data.workingDirectory}
          </dd>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="archive-mono text-[9px] tracking-[.12em] text-[#879599]">PLEX CONFIGURED</dt>
            <dd
              className="archive-mono mt-1 text-[11px] font-bold text-[#354851]"
              data-testid="text-storage-plex-configured"
            >
              {data.plexConfigured ? 'YES' : 'NO'}
            </dd>
          </div>
          <div>
            <dt className="archive-mono text-[9px] tracking-[.12em] text-[#879599]">JOURNAL MODE</dt>
            <dd className="archive-mono mt-1 text-[11px] text-[#53656b]" data-testid="text-storage-journal-mode">
              {(data.journalMode ?? 'unknown').toUpperCase()}
              {data.walSidecars.length > 0 && ` (${data.walSidecars.join(', ')})`}
            </dd>
          </div>
        </div>
      </dl>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {counts.map(([label, value]) => (
          <div
            key={label}
            className="border border-[#e3e8e7] bg-white/60 px-2.5 py-2"
            data-testid={`text-storage-count-${label.toLowerCase().replace(/\s/g, '-')}`}
          >
            <div className="archive-mono text-[9px] tracking-[.08em] text-[#879599]">{label}</div>
            <div className="archive-display mt-1 text-lg font-extrabold text-[#354851]">
              {value.toLocaleString()}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 border-t border-[#e3e8e7] pt-4 text-[10px] leading-5 text-[#879599]">
        Paths are shown here deliberately: when state goes missing, the path is the diagnosis.
        Credentials are never displayed — Plex appears only as a configured state.
      </div>
    </section>
  );
}

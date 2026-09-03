import re
import sys

with open('artifacts/archive-assistant/src/App.tsx', 'r', encoding='utf-8') as f:
    content = f.read()

# Add the new components just before `const settingsGroups`
components_code = """
function EmptyState({ icon: Icon, title, description }: { icon: typeof Activity; title: string; description: string }) {
  return (
    <div className="flex min-h-[250px] flex-col items-center justify-center text-center">
      <Icon size={24} className="mb-3 text-[#a0afaf]" />
      <div className="text-[13px] font-bold text-[#344851]">{title}</div>
      <div className="mt-1 text-[11px] text-[#8a9b9e]">{description}</div>
    </div>
  );
}

function ArchiveRecordPanel({ id, onClose }: { id: number; onClose: () => void }) {
  const { data: record, isLoading, isError, refetch } = useGetArchiveRecord(id);
  
  if (isLoading) return <aside className="archive-panel p-5"><Skeleton className="h-[400px]" /></aside>;
  if (isError || !record) return <aside className="archive-panel p-5"><ErrorState title="Read failed" message="Record not found." onRetry={() => refetch()} testId="button-retry-record" /></aside>;

  return (
    <aside className="archive-panel h-fit p-5 md:p-6" data-testid="panel-archive-record">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="archive-mono text-[10px] tracking-[.14em] text-[#7f9194]">RECORD INSPECTION</div>
          <h2 className="archive-display mt-1 text-lg font-extrabold text-[#263844] break-all">{record.filename}</h2>
          <div className="mt-1 archive-mono text-[9px] text-[#8a9b9e] break-all">{record.relativePath}</div>
        </div>
        <button onClick={onClose} className="grid h-8 w-8 shrink-0 place-items-center border border-[#e1e8e5] text-[#8a9b9e] hover:bg-[#f3f5f4] hover:text-[#21303d]" aria-label="Close" data-testid="button-close-record"><X size={14} /></button>
      </div>
      
      <div className="space-y-4 text-[12px]">
        <Readout label="Scan Status" value={record.scanStatus.toUpperCase()} tone={record.scanStatus === 'active' ? 'good' : 'warn'} />
        <Readout label="Quality" value={record.qualityStatus.replace(/_/g, ' ').toUpperCase()} tone={['duplicate', 'file_missing', 'needs_review'].includes(record.qualityStatus) ? 'warn' : 'neutral'} />
        <Readout label="Size" value={formatBytes(record.sizeBytes)} />
        {record.durationSeconds ? <Readout label="Duration" value={formatDuration(record.durationSeconds)} /> : null}
        <Readout label="Video" value={`${record.videoCodec || 'none'} ${record.width ? `(${record.width}x${record.height})` : ''}`} />
        <Readout label="Audio" value={`${record.audioCodec || 'none'} ${record.audioChannels ? `(${record.audioChannels}ch)` : ''}`} />
        {record.fps ? <Readout label="Framerate" value={`${record.fps} fps`} /> : null}
        {record.bitrate ? <Readout label="Bitrate" value={`${Math.round(record.bitrate / 1000)} kbps`} /> : null}
      </div>

      {record.qualitySummary && (
        <div className="mt-6 border-l-2 border-[#f4b942] bg-[#fff8e7] p-4 text-[11px] leading-5 text-[#80652e]">
          {record.qualitySummary}
        </div>
      )}

      {record.plexMatch && (
        <div className="mt-6 border-t border-[#e3e8e7] pt-5">
           <div className="archive-mono text-[10px] tracking-[.14em] text-[#7f9194] mb-3">PLEX MATCH</div>
           <div className="font-bold text-[#344851] text-[13px]">{record.plexMatch.title} {record.plexMatch.year ? `(${record.plexMatch.year})` : ''}</div>
           {record.plexMatch.qualityDifferences.length > 0 && (
             <div className="mt-3 space-y-2">
               {record.plexMatch.qualityDifferences.map((diff, i) => (
                 <div key={i} className="text-[11px] text-[#859296] flex items-start gap-2"><div className="mt-1.5 w-1 h-1 rounded-full bg-[#f4b942] shrink-0" /> <span className="min-w-0 flex-1 break-words">{diff}</span></div>
               ))}
             </div>
           )}
        </div>
      )}
      
      {record.duplicateOfId && (
        <div className="mt-6 border-t border-[#e3e8e7] pt-5">
           <div className="archive-mono text-[10px] tracking-[.14em] text-[#7f9194] mb-3">DUPLICATE OF</div>
           <div className="text-[11px] font-bold text-[#344851]">Record #{record.duplicateOfId}</div>
        </div>
      )}
    </aside>
  );
}

function ArchivePage() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState('');
  const [selectedRecordId, setSelectedRecordId] = useState<number | null>(null);
  const [view, setView] = useState<'local' | 'plex_only'>('local');
  const [filter, setFilter] = useState<'all' | 'duplicates' | 'conflicts' | 'missing' | 'local_only'>('all');

  const [isScanning, setIsScanning] = useState(false);
  const { data: scan, isLoading: scanLoading, refetch: refetchScan } = useGetArchiveScan({
    query: {
      refetchInterval: isScanning ? 2000 : false,
      queryKey: getGetArchiveScanQueryKey()
    }
  });

  useEffect(() => {
    setIsScanning(scan?.status === 'scanning');
  }, [scan?.status]);

  const { data: inventory, isLoading: invLoading, isError: invError, refetch: refetchInv } = useGetArchiveInventory({
    query: {
      refetchInterval: isScanning ? 3000 : false,
      queryKey: getGetArchiveInventoryQueryKey()
    }
  });

  const startScan = useStartArchiveScan();
  const handleStartScan = () => {
    setNotice('');
    startScan.mutate(undefined, {
      onSuccess: () => {
        setNotice('Archive scan started.');
        queryClient.invalidateQueries({ queryKey: getGetArchiveScanQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetArchiveInventoryQueryKey() });
      },
      onError: (err) => {
        setNotice(`Scan could not start: ${errorText(err)}`);
      }
    });
  };

  if (scanLoading) return <><PageIntro eyebrow="ARCHIVE / LOCAL" title="Archive inventory" description="Reading local media records." /><Skeleton className="h-[400px]" /></>;
  if (invError) return <ErrorState title="Inventory read failed" message="Could not read the archive inventory from the local node." onRetry={() => refetchInv()} testId="button-retry-archive" />;

  const records = inventory?.records ?? [];
  let displayedRecords = records;
  if (filter === 'duplicates') displayedRecords = records.filter(r => r.qualityStatus.includes('duplicate'));
  else if (filter === 'conflicts') displayedRecords = records.filter(r => ['higher_quality_available', 'lower_quality_version', 'needs_review'].includes(r.qualityStatus) || (r.qualityDifferences && r.qualityDifferences.length > 0));
  else if (filter === 'missing') displayedRecords = records.filter(r => r.scanStatus === 'missing' || r.qualityStatus === 'file_missing');
  else if (filter === 'local_only') displayedRecords = records.filter(r => r.qualityStatus === 'local_only');

  const plexOnly = inventory?.plexOnly ?? [];
  const showPlex = view === 'plex_only';

  return (
    <>
      <PageIntro 
        eyebrow="ARCHIVE / LOCAL" 
        title="Archive inventory" 
        description="Inspect local media, duplicates, and quality conflicts." 
        action={
          <button 
            onClick={handleStartScan} 
            disabled={isScanning || startScan.isPending} 
            className="inline-flex items-center gap-2 bg-[#1d2b38] px-4 py-3 text-[11px] font-bold tracking-[.1em] text-[#f5f6f3] disabled:opacity-50 hover:bg-[#21303d]"
            data-testid="button-start-archive-scan"
          >
            {isScanning || startScan.isPending ? <RefreshCw size={14} className="animate-spin" /> : <Search size={14} />}
            {isScanning ? 'SCANNING' : 'START INVENTORY SCAN'}
          </button>
        } 
      />

      {notice && (
        <div className={`mb-5 border-l-2 p-3 text-[11px] leading-5 ${notice.includes('failed') || notice.includes('could not') ? 'border-[#c85b51] bg-[#fcedea] text-[#994b43]' : 'border-[#4e9690] bg-[#eaf3ef] text-[#39736e]'}`} data-testid="status-archive-scan">
          {notice}
        </div>
      )}

      {scan && (
        <div className="mb-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard icon={FileCheck2} label="ACTIVE FILES" value={String(scan.activeFiles)} note="Verified local media" status={isScanning ? 'processing' : 'ready'} />
          <MetricCard icon={Archive} label="MISSING FILES" value={String(scan.missingCount)} note="Known but missing" accent={scan.missingCount ? 'red' : 'teal'} status={scan.missingCount ? 'error' : 'idle'} />
          <MetricCard icon={Library} label="DUPLICATES" value={String(scan.duplicateCount)} note="Identical files found" accent={scan.duplicateCount ? 'amber' : 'teal'} />
          <MetricCard icon={Activity} label="QUALITY CONFLICTS" value={String(scan.qualityConflictCount)} note="Multiple versions exist" accent={scan.qualityConflictCount ? 'amber' : 'teal'} />
        </div>
      )}

      <div className={`grid items-start gap-5 ${selectedRecordId ? 'xl:grid-cols-[minmax(0,1fr)_380px]' : 'grid-cols-1'}`}>
        <section className="archive-panel flex min-h-[500px] flex-col" data-testid="panel-archive-list">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#e3e8e7] bg-[#fbfcfa] p-4 md:px-6">
            <div className="flex flex-wrap gap-2">
              <button onClick={() => { setView('local'); setFilter('all'); setSelectedRecordId(null); }} className={`px-3 py-1.5 text-[10px] font-bold tracking-[.1em] ${view === 'local' ? 'bg-[#dcebe7] text-[#39736e]' : 'text-[#8a9b9e] hover:bg-[#f3f5f4]'}`} data-testid="tab-local-inventory">LOCAL INVENTORY</button>
              <button onClick={() => { setView('plex_only'); setSelectedRecordId(null); }} className={`px-3 py-1.5 text-[10px] font-bold tracking-[.1em] ${view === 'plex_only' ? 'bg-[#dcebe7] text-[#39736e]' : 'text-[#8a9b9e] hover:bg-[#f3f5f4]'}`} data-testid="tab-plex-only">PLEX ONLY ({scan?.plexOnlyCount ?? 0})</button>
            </div>
            
            {view === 'local' && (
              <div className="flex flex-wrap items-center gap-2">
                {['all', 'duplicates', 'conflicts', 'missing', 'local_only'].map(f => (
                  <button key={f} onClick={() => setFilter(f as any)} className={`archive-mono text-[9px] tracking-[.08em] px-2 py-1 border ${filter === f ? 'border-[#4e9690] bg-[#eaf3ef] text-[#39736e]' : 'border-[#d6dfdc] bg-white text-[#7f9194] hover:border-[#aabfba]'}`}>
                    {f.replace('_', ' ').toUpperCase()}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-4 md:p-6" style={{ maxHeight: '600px' }}>
            {showPlex ? (
              plexOnly.length ? (
                <div className="space-y-3">
                  {plexOnly.map(p => (
                    <div key={p.ratingKey} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border border-[#f0f4f3] bg-white p-4">
                      <div>
                        <div className="text-[13px] font-bold text-[#344851]">{p.title} {p.year ? `(${p.year})` : ''}</div>
                        <div className="mt-1 archive-mono text-[9px] text-[#a0afaf]">{p.itemType.toUpperCase()} / {p.ratingKey}</div>
                      </div>
                      <div className="text-[11px] text-[#8a9b9e]">{p.qualitySummary}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState icon={PlaySquare} title="No Plex-only media" description="All media in Plex appears to exist in your local archive." />
              )
            ) : (
              displayedRecords.length ? (
                <div className="space-y-2">
                  {displayedRecords.map(r => (
                    <button 
                      key={r.id} 
                      onClick={() => setSelectedRecordId(r.id)}
                      className={`w-full text-left flex flex-col sm:flex-row sm:items-center justify-between gap-3 border p-3 transition-colors ${selectedRecordId === r.id ? 'border-[#4e9690] bg-[#eef6f2]' : 'border-[#e1e8e5] bg-white/50 hover:border-[#aabfba]'}`}
                      data-testid={`row-archive-record-${r.id}`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12px] font-semibold text-[#43545b]" title={r.filename}>{r.filename}</div>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px]">
                          <span className={`archive-mono tracking-[.05em] ${r.qualityStatus.includes('duplicate') || r.qualityStatus.includes('missing') || r.qualityStatus.includes('needs_review') ? 'text-[#a77517]' : 'text-[#4e9690]'}`}>
                            {r.qualityStatus.replace(/_/g, ' ').toUpperCase()}
                          </span>
                          <span className="text-[#8a9b9e]">{formatBytes(r.sizeBytes)}</span>
                        </div>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        {r.scanStatus === 'missing' && <span className="grid h-6 place-items-center bg-[#fcedea] px-2 text-[9px] font-bold text-[#c85b51]">MISSING</span>}
                        {r.plexMatch && <span className="grid h-6 place-items-center bg-[#fff0c9] px-2 text-[9px] font-bold text-[#a77517]">IN PLEX</span>}
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <EmptyState icon={FolderOpen} title="No records found" description="No local inventory matches this filter." />
              )
            )}
          </div>
        </section>

        {selectedRecordId && <ArchiveRecordPanel id={selectedRecordId} onClose={() => setSelectedRecordId(null)} />}
      </div>
    </>
  );
}

"""

# Insert components before `const settingsGroups`
content = content.replace("const settingsGroups =", components_code + "const settingsGroups =")

# Replace `<Route path="/archive"><PlaceholderPage section="ARCHIVE" /></Route>` with `<Route path="/archive" component={ArchivePage} />`
content = content.replace(
    '<Route path="/archive"><PlaceholderPage section="ARCHIVE" /></Route>',
    '<Route path="/archive" component={ArchivePage} />'
)

with open('artifacts/archive-assistant/src/App.tsx', 'w', encoding='utf-8') as f:
    f.write(content)

print("Injected successfully.")

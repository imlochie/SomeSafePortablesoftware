import { useState } from 'react';
import { Link } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, CircleHelp, LoaderCircle } from 'lucide-react';
import { apiUrl } from '@/lib/desktop-api-base-url';
import { useWorkloadEvents } from '@/hooks/use-workload-events';

type WorkloadItem = { id: string; title: string; state: string };
type LineageStage = { status: 'known' | 'unknown' | 'not_applicable'; label?: string; detail?: string };
type Workload = { counts: { needs_you: number; being_handled: number; waiting: number; blocked: number }; items: WorkloadItem[] };
type Lineage = { title: string; origin: LineageStage; review: LineageStage; approval: LineageStage; acquisition: LineageStage; download: LineageStage; verification: LineageStage; operation: LineageStage; outcome: LineageStage };

function LineageDisclosure({ item }: { item: WorkloadItem }) {
  const [open, setOpen] = useState(false);
  const lineage = useQuery<Lineage>({ queryKey: ['assistant-workload-lineage', item.id], enabled: open, queryFn: async () => {
    const response = await fetch(apiUrl(`/api/assistant/workload/${encodeURIComponent(item.id)}/lineage`));
    if (!response.ok) throw new Error('Lineage unavailable');
    return response.json() as Promise<Lineage>;
  } });
  const stages = lineage.data ? [lineage.data.origin, lineage.data.review, lineage.data.approval, lineage.data.acquisition, lineage.data.download, lineage.data.verification, lineage.data.operation, lineage.data.outcome] : [];
  return <details className="mt-4 border-t border-[#e3e8e7] pt-3" onToggle={(event) => setOpen(event.currentTarget.open)} data-testid={`disclosure-lineage-${item.id}`}><summary className="cursor-pointer list-none text-[10px] font-bold tracking-[.1em] text-[#39736e]">VIEW WHAT HAPPENED</summary><Link href={`/workload/${encodeURIComponent(item.id)}?from=home`} className="mt-3 inline-flex text-[9px] font-bold tracking-[.1em] text-[#39736e]">OPEN FULL STORY</Link>{lineage.isLoading && <div className="mt-3 text-[10px] text-[#829095]">Reading the recorded journey…</div>}{lineage.isError && <div className="mt-3 text-[10px] text-[#8d4a45]">I don't have enough information to confirm what happened.</div>}{lineage.data && <div className="mt-3 grid gap-2 sm:grid-cols-2">{stages.map((stage, index) => <div key={index} className="border border-[#e3e8e7] bg-[#fbfcfb] px-3 py-2"><div className="text-[10px] font-semibold text-[#53656b]">{stage.status === 'known' ? stage.label : stage.status === 'not_applicable' ? 'Not applicable' : 'Not confirmed'}</div>{stage.status !== 'known' && <div className="mt-1 text-[9px] text-[#829095]">{stage.detail}</div>}</div>)}</div>}</details>;
}

/** A read-only view of the assistant's existing workload truth. */
export function WorkloadSummary({ compact = false }: { compact?: boolean }) {
  useWorkloadEvents();
  const workload = useQuery<Workload>({ queryKey: ['assistant-workload'], queryFn: async ({ signal }) => {
    const timeout = new AbortController();
    const timer = window.setTimeout(() => timeout.abort(), 10000);
    const cancel = () => timeout.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const response = await fetch(apiUrl('/api/assistant/workload'), { signal: timeout.signal });
      if (!response.ok) throw new Error('Workload unavailable');
      return response.json() as Promise<Workload>;
    } finally {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }, refetchInterval: 30000, retry: false });
  if (workload.isLoading) return <section className="archive-panel mb-5 flex items-center gap-2 p-4 text-[11px] text-[#718187]" data-testid="panel-unified-workload-loading"><LoaderCircle size={14} className="animate-spin" /> Reading what needs attention…</section>;
  if (workload.isError || !workload.data) return <section className="archive-panel mb-5 flex items-start gap-2 p-4 text-[11px] text-[#82765d]" data-testid="panel-unified-workload-unavailable"><CircleHelp size={14} className="mt-0.5 shrink-0" /> I can't read the current workload right now. The underlying work has not been changed.</section>;
  const { counts } = workload.data;
  const needsYou = counts.needs_you;
  const waiting = counts.waiting;
  const blocked = counts.blocked;
  const handling = counts.being_handled;
  const healthItems = workload.data.items.filter((item) => item.id.startsWith('health:'));
  const lineageItem = workload.data.items.find((item) => item.state === 'needs_you' || item.state === 'being_handled' || item.state === 'completed');
  return <section className="archive-panel mb-5 p-4 md:p-5" data-testid="panel-unified-workload"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="archive-mono text-[9px] tracking-[.14em] text-[#7f9194]">ONE WORKLOAD / SHARED ACROSS THE APP</div><h2 className="archive-display mt-1 text-lg font-extrabold">{needsYou ? `${needsYou} thing${needsYou === 1 ? '' : 's'} need your attention` : 'Nothing urgent right now'}</h2><p className="mt-1 text-[11px] text-[#718187]">{needsYou ? 'Review the explanation before deciding.' : 'Your archive is being observed.'}</p></div><Link href="/assistant" className="inline-flex items-center gap-1 text-[9px] font-bold tracking-[.1em] text-[#39736e]">UNDERSTAND <ArrowUpRight size={13} /></Link></div><div className={`mt-4 grid gap-2 ${compact ? 'sm:grid-cols-3' : 'sm:grid-cols-4'}`}><Link href="/assistant" className="border border-[#e0e8e5] bg-[#fbfcfb] p-3 hover:border-[#8fb3ac]"><div className="archive-mono text-[9px] text-[#829095]">NEEDS YOU</div><div className="archive-display mt-1 text-xl font-extrabold">{needsYou}</div></Link><Link href="/queue" className="border border-[#e0e8e5] bg-[#fbfcfb] p-3 hover:border-[#8fb3ac]"><div className="archive-mono text-[9px] text-[#829095]">BEING HANDLED</div><div className="archive-display mt-1 text-xl font-extrabold">{handling}</div></Link><Link href="/assistant" className="border border-[#e0e8e5] bg-[#fffaf0] p-3 hover:border-[#d9bd77]"><div className="archive-mono text-[9px] text-[#82765d]">WAITING</div><div className="archive-display mt-1 text-xl font-extrabold">{waiting}</div></Link><Link href="/assistant" className="border border-[#efd3cf] bg-[#fff5f3] p-3 hover:border-[#cf695f]"><div className="archive-mono text-[9px] text-[#8d4a45]">BLOCKED</div><div className="archive-display mt-1 text-xl font-extrabold">{blocked}</div></Link><Link href="/archive/health" className="border border-[#e0e8e5] bg-[#fbfcfb] p-3 hover:border-[#8fb3ac]"><div className="archive-mono text-[9px] text-[#829095]">ARCHIVE HEALTH</div><div className="archive-display mt-1 text-xl font-extrabold">{healthItems.length}</div><div className="mt-1 text-[10px] text-[#718187]">Findings to understand</div></Link>{!compact && <Link href="/history" className="border border-[#e0e8e5] bg-[#fbfcfb] p-3 hover:border-[#8fb3ac]"><div className="archive-mono text-[9px] text-[#829095]">PAST OUTCOMES</div><div className="mt-2 text-[10px] text-[#718187]">See what changed</div></Link>}</div>{lineageItem && <LineageDisclosure item={lineageItem} />}</section>;
}

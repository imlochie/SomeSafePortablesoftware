import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, CircleHelp, LoaderCircle } from 'lucide-react';
import { Link, useParams } from 'wouter';
import { apiUrl } from '@/lib/desktop-api-base-url';
import { useWorkloadEvents } from '@/hooks/use-workload-events';
import { ActionConsequencePreview } from '@/components/action-consequence-preview';

type Stage = { status: 'known' | 'unknown' | 'not_applicable'; label?: string; detail?: string; occurredAt?: string | null };
type Lineage = { workloadId: string; title: string; origin: Stage; review: Stage; approval: Stage; acquisition: Stage; download: Stage; verification: Stage; operation: Stage; outcome: Stage };
type WorkloadItem = { id: string; title: string; summary: string; state: string; needsUserAction: boolean; nextStep: string; destination: string; evidence: string[]; confidence: string | null; lastConfirmedAt: string | null; freshness: 'fresh' | 'recent' | 'stale' | 'unknown' };
type Workload = { items: WorkloadItem[] };

function freshnessCopy(item: WorkloadItem) {
  if (!item.lastConfirmedAt || item.freshness === 'unknown') return 'I haven\'t been able to confirm the latest state.';
  const age = Math.max(0, Math.round((Date.now() - Date.parse(item.lastConfirmedAt)) / 60000));
  if (item.freshness === 'fresh') return 'Last confirmed moments ago.';
  if (age === 0) return 'Last confirmed less than a minute ago.';
  return `Last confirmed ${age} minute${age === 1 ? '' : 's'} ago.`;
}

function stateCopy(state: string) {
  if (state === 'needs_you') return ['Needs your attention', 'Review the explanation before deciding.'];
  if (state === 'being_handled') return ['Being handled', 'The system is working on this now.'];
  if (state === 'waiting') return ['Waiting', 'The system is waiting before it can continue.'];
  if (state === 'blocked') return ['Blocked', 'Something needs your attention before this can continue.'];
  if (state === 'completed') return ['Completed', 'Nothing else needs your attention unless you want to inspect the outcome.'];
  if (state === 'dismissed') return ['Dismissed', 'This recommendation is no longer active.'];
  if (state === 'uncertain') return ['Not confirmed', 'There is not enough evidence to treat this as settled.'];
  return ['Interesting', 'Review this when you are ready.'];
}

export default function WorkloadDetailPage() {
  useWorkloadEvents();
  const { workloadId = '' } = useParams<{ workloadId: string }>();
  const decodedId = decodeURIComponent(workloadId);
  const from = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('from') : null;
  const backPath = from === 'assistant' ? '/assistant' : from === 'queue' ? '/queue' : from === 'history' ? '/history' : '/user-portal';
  const workload = useQuery<Workload>({ queryKey: ['assistant-workload'], queryFn: async () => { const response = await fetch(apiUrl('/api/assistant/workload')); if (!response.ok) throw new Error('Workload unavailable'); return response.json() as Promise<Workload>; }, refetchInterval: 30000 });
  const lineage = useQuery<Lineage>({ queryKey: ['assistant-workload-lineage', decodedId], queryFn: async () => { const response = await fetch(apiUrl(`/api/assistant/workload/${encodeURIComponent(decodedId)}/lineage`)); if (!response.ok) throw new Error('Lineage unavailable'); return response.json() as Promise<Lineage>; } });
  const item = workload.data?.items.find((candidate) => candidate.id === decodedId);
  if (workload.isLoading || lineage.isLoading) return <div className="mx-auto w-full max-w-4xl"><div className="archive-panel flex min-h-[260px] items-center justify-center gap-2 p-8 text-[11px] text-[#718187]"><LoaderCircle size={15} className="animate-spin" /> Reading the recorded journey…</div></div>;
  if (workload.isError || lineage.isError || !lineage.data) return <div className="mx-auto w-full max-w-4xl"><div className="archive-panel flex min-h-[260px] flex-col items-center justify-center p-8 text-center"><CircleHelp size={24} className="mb-3 text-[#a77517]" /><h1 className="archive-display text-xl font-extrabold">I don't have enough information to confirm what happened.</h1><p className="mt-2 max-w-md text-[12px] leading-5 text-[#718187]">This work item may no longer be available for this account, or its records are not linked.</p><Link href={backPath} className="mt-6 inline-flex items-center gap-2 text-[10px] font-bold tracking-[.1em] text-[#39736e]"><ArrowLeft size={13} /> BACK</Link></div></div>;
  const stages: Array<[string, Stage]> = [['Found', lineage.data.origin], ['Reviewed', lineage.data.review], ['Decision', lineage.data.approval], ['Acquisition', lineage.data.acquisition], ['Download', lineage.data.download], ['Verification', lineage.data.verification], ['Archive change', lineage.data.operation], ['Outcome', lineage.data.outcome]];
  return <div className="mx-auto w-full max-w-4xl"><Link href={backPath} className="mb-5 inline-flex items-center gap-2 text-[10px] font-bold tracking-[.1em] text-[#39736e]"><ArrowLeft size={13} /> BACK</Link><div className="mb-7"><div className="archive-mono mb-2 text-[10px] tracking-[.2em] text-[#7a9093]">WORKLOAD / WHAT HAPPENED</div><h1 className="archive-display text-3xl font-extrabold text-[#21303d]">{lineage.data.title}</h1><p className="mt-2 max-w-xl text-[13px] leading-6 text-[#718087]">A read-only explanation of where this work came from and what happened afterward.</p></div>{item && <section className="archive-panel mb-5 p-5" data-testid="panel-workload-decision"><div className="archive-mono text-[9px] tracking-[.14em] text-[#7f9194]">CURRENT WORK</div><h2 className="archive-display mt-1 text-lg font-extrabold">{stateCopy(item.state)[0]}</h2><p className="mt-2 text-[12px] leading-5 text-[#718187]">{item.summary}</p><p className="mt-2 text-[11px] text-[#718187]">{stateCopy(item.state)[1]}</p><p className={`mt-2 text-[10px] ${item.freshness === 'stale' || item.freshness === 'unknown' ? 'text-[#82765d]' : 'text-[#39736e]'}`}>{freshnessCopy(item)}</p><div className="mt-3 border-l-2 border-[#4e9690] bg-[#f1f7f5] p-3 text-[11px] text-[#56736f]">{item.nextStep}</div>{item.state === 'needs_you' && <ActionConsequencePreview />}</section>}{(item?.state === 'completed' || item?.state === 'blocked' || lineage.data.outcome.status !== 'not_applicable') && <section className="archive-panel mb-5 border-l-2 border-[#4e9690] p-5" data-testid="panel-workload-outcome"><div className="archive-mono text-[9px] tracking-[.14em] text-[#7f9194]">OUTCOME</div><h2 className="archive-display mt-1 text-lg font-extrabold">{lineage.data.outcome.status === 'known' ? lineage.data.outcome.label : lineage.data.outcome.status === 'unknown' ? 'The final result is not confirmed.' : 'No archive outcome applies yet.'}</h2><p className="mt-2 text-[11px] leading-5 text-[#718187]">{lineage.data.outcome.detail ?? 'The system has not recorded an archive outcome for this item.'}</p></section>}<section className="archive-panel p-5 md:p-6" data-testid="panel-workload-lineage"><div className="archive-mono text-[9px] tracking-[.14em] text-[#7f9194]">RECORDED JOURNEY</div><div className="mt-5 space-y-3">{stages.map(([name, stage]) => <div key={name} className="flex gap-3 border-t border-[#e3e8e7] pt-3 first:border-0 first:pt-0"><span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${stage.status === 'known' ? 'bg-[#4e9690]' : stage.status === 'unknown' ? 'bg-[#d9bd77]' : 'bg-[#b5c0c0]'}`} /><div className="min-w-0 flex-1"><div className="text-[12px] font-semibold text-[#43545b]">{stage.status === 'known' ? stage.label ?? name : `${name}: ${stage.status === 'not_applicable' ? 'not applicable' : 'not confirmed'}`}</div>{stage.detail && <div className="mt-1 text-[11px] leading-5 text-[#718187]">{stage.detail}</div>}{stage.occurredAt && <div className="archive-mono mt-1 text-[9px] text-[#97a3a4]">{new Date(stage.occurredAt).toLocaleString()}</div>}</div></div>)}</div></section></div>;
}

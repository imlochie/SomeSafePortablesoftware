import { useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  Archive,
  ArrowUpRight,
  Bot,
  Check,
  ChevronRight,
  CircleHelp,
  CloudOff,
  Cpu,
  Download,
  FolderOpen,
  HardDrive,
  History,
  Library,
  Link2,
  Menu,
  Network,
  PlaySquare,
  Plus,
  RefreshCw,
  Save,
  Search,
  Server,
  Settings as SettingsIcon,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  X,
  Zap,
} from 'lucide-react';
import {
  getGetPlexConfigQueryKey,
  getGetSettingsQueryKey,
  useGetPlexConfig,
  useGetSettings,
  useGetSystemDependencies,
  useGetSystemEvents,
  useGetSystemOverview,
  useHealthCheck,
  useUpdatePlexConfig,
  useUpdateSettings,
} from '@workspace/api-client-react';
import type { AppSettings, AppSettingsUpdate, SystemEvent } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Link, Route, Router as WouterRouter, Switch, useLocation } from 'wouter';

const queryClient = new QueryClient();

const navItems = [
  { label: 'HOME', href: '/', icon: Activity },
  { label: 'ASSISTANT', href: '/assistant', icon: Bot },
  { label: 'QUEUE', href: '/queue', icon: Download },
  { label: 'ARCHIVE', href: '/archive', icon: Archive },
  { label: 'PLEX', href: '/plex', icon: PlaySquare },
  { label: 'SOURCES', href: '/sources', icon: FolderOpen },
  { label: 'HISTORY', href: '/history', icon: History },
  { label: 'SETTINGS', href: '/settings', icon: SettingsIcon },
];

const statusLabels: Record<string, string> = {
  ready: 'READY',
  connected: 'CONNECTED',
  idle: 'IDLE',
  placeholder: 'PLACEHOLDER',
  warning: 'WARNING',
  unavailable: 'UNAVAILABLE',
  processing: 'PROCESSING',
  not_configured: 'NOT CONFIGURED',
  error: 'ERROR',
};

function formatTime(value: string | null | undefined) {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

function statusText(value: string | undefined) {
  return value ? statusLabels[value] ?? value.toUpperCase() : 'CHECKING';
}

function StatusPill({ status, label }: { status?: string; label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-white/70 px-2.5 py-1 text-[10px] font-bold tracking-[.1em] text-[#53636a]" data-testid={`status-${label?.toLowerCase().replace(/\s/g, '-') ?? status}`}>
      <span className={`status-dot ${status ?? 'idle'}`} />
      {label ?? statusText(status)}
    </span>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const [location] = useLocation();
  return (
    <aside className="flex w-full shrink-0 flex-col bg-[#1d2b38] text-[#d7e0df] md:min-h-[100dvh] md:w-[230px]" data-testid="navigation-sidebar">
      <div className="flex items-center justify-between border-b border-white/10 px-5 py-5 md:block">
        <Link href="/" className="flex items-center gap-3" data-testid="link-home-logo" onClick={onNavigate}>
          <div className="grid h-9 w-9 place-items-center border border-[#f4b942] text-[#f4b942]"><Archive size={18} strokeWidth={1.7} /></div>
          <div>
            <div className="archive-display text-[15px] font-extrabold tracking-[.12em] text-[#f5f6f3]">ARCHIVE</div>
            <div className="archive-mono text-[8px] tracking-[.28em] text-[#93a6a9]">ASSISTANT / LOCAL</div>
          </div>
        </Link>
        <button className="grid h-9 w-9 place-items-center border border-white/10 text-[#9bb0b1] md:hidden" onClick={onNavigate} aria-label="Close navigation" data-testid="button-close-navigation"><X size={18} /></button>
      </div>
      <div className="hidden px-5 py-5 md:block">
        <div className="archive-mono flex items-center gap-2 text-[9px] font-medium uppercase tracking-[.14em] text-[#7f979b]"><span className="status-dot ready" /> LOCAL NODE ONLINE</div>
        <div className="mt-2 text-[11px] text-[#71898e]">Windows workstation / primary</div>
      </div>
      <nav className="grid grid-cols-4 gap-1 px-3 py-3 md:block md:px-3 md:py-1">
        {navItems.map(({ label, href, icon: Icon }) => {
          const active = location === href;
          return (
            <Link key={label} href={href} onClick={onNavigate} className={`archive-nav-item flex min-h-[52px] flex-col items-center justify-center gap-1.5 rounded-sm px-3 py-2 md:mb-1 md:min-h-0 md:flex-row md:justify-start md:gap-3 ${active ? 'bg-[#f4b942] text-[#1d2b38]' : 'text-[#9db0b1] hover:bg-white/8 hover:text-[#f5f6f3]'}`} data-testid={`link-nav-${label.toLowerCase()}`}>
              <Icon size={16} strokeWidth={active ? 2.2 : 1.7} />
              <span className="text-[10px] font-bold tracking-[.13em] md:text-[11px]">{label}</span>
              {active && <ChevronRight className="ml-auto hidden md:block" size={14} />}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto hidden border-t border-white/10 px-5 py-5 md:block">
        <div className="archive-mono mb-2 text-[9px] tracking-[.13em] text-[#6f888d]">OPERATOR MODE</div>
        <div className="flex items-center gap-2 text-[11px] text-[#bac8c7]"><ShieldCheck size={14} className="text-[#4e9690]" /> Trusted local session</div>
      </div>
    </aside>
  );
}

function Topbar({ onMenu }: { onMenu: () => void }) {
  const [location] = useLocation();
  const current = navItems.find((item) => item.href === location)?.label ?? 'HOME';
  const { data: health, isLoading } = useHealthCheck();
  return (
    <header className="flex min-h-[73px] items-center justify-between border-b border-[var(--line)] bg-[#f3f5f4]/90 px-5 backdrop-blur md:px-8">
      <div className="flex items-center gap-3">
        <button className="grid h-9 w-9 place-items-center border border-[var(--line)] bg-white/55 md:hidden" onClick={onMenu} aria-label="Open navigation" data-testid="button-open-navigation"><Menu size={18} /></button>
        <div>
          <div className="archive-mono text-[9px] font-medium tracking-[.2em] text-[#829298]">ARCHIVE ASSISTANT / {current}</div>
          <div className="mt-1 text-[12px] font-semibold text-[#51626a]">{current === 'HOME' ? 'System overview' : `${current.charAt(0)}${current.slice(1).toLowerCase()} workspace`}</div>
        </div>
      </div>
      <div className="hidden items-center gap-4 sm:flex">
        <div className="archive-mono flex items-center gap-2 text-[9px] tracking-[.1em] text-[#71858a]" data-testid="status-health">
          <span className={`status-dot ${health?.status === 'ok' ? 'ready' : 'warning'}`} />
          {isLoading ? 'CHECKING NODE' : health?.status === 'ok' ? 'API HEALTHY' : 'API UNCONFIRMED'}
        </div>
        <div className="h-5 w-px bg-[var(--line)]" />
        <button className="text-[#71858a] transition-colors hover:text-[#21303d]" aria-label="Search archive" data-testid="button-search"><Search size={17} /></button>
        <div className="grid h-8 w-8 place-items-center bg-[#dfe8e5] text-[11px] font-extrabold text-[#315e5b]" data-testid="text-operator-avatar">OP</div>
      </div>
    </header>
  );
}

function AppShell({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="archive-shell flex flex-col md:flex-row">
      <div className={`fixed inset-0 z-30 bg-[#17232d]/45 transition-opacity md:static md:z-auto md:block md:bg-transparent ${menuOpen ? 'block opacity-100' : 'pointer-events-none hidden opacity-0'}`} onClick={() => setMenuOpen(false)} />
      <div className={`fixed inset-y-0 left-0 z-40 w-[230px] transition-transform md:static md:z-auto md:block md:translate-x-0 ${menuOpen ? 'translate-x-0' : '-translate-x-full'}`}><Sidebar onNavigate={() => setMenuOpen(false)} /></div>
      <main className="min-w-0 flex-1">
        <Topbar onMenu={() => setMenuOpen(true)} />
        <div className="archive-grid min-h-[calc(100dvh-73px)] p-5 md:p-8">{children}</div>
      </main>
    </div>
  );
}

function PageIntro({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return (
    <div className="mb-7 flex flex-col justify-between gap-5 md:flex-row md:items-end">
      <div className="archive-fade">
        <div className="archive-mono mb-2 text-[10px] font-medium tracking-[.2em] text-[#7a9093]">{eyebrow}</div>
        <h1 className="archive-display text-3xl font-extrabold text-[#21303d] md:text-[38px]">{title}</h1>
        <p className="mt-2 max-w-xl text-[13px] leading-6 text-[#718087]">{description}</p>
      </div>
      {action}
    </div>
  );
}

function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-[#dfe6e5] ${className}`} />;
}

function MetricCard({ icon: Icon, label, value, status, note, accent = 'teal' }: { icon: typeof Activity; label: string; value: string; status?: string; note: string; accent?: 'teal' | 'amber' | 'red' }) {
  return (
    <div className="archive-panel archive-fade archive-fade-delay-1 min-h-[146px] p-5 transition-all duration-300 hover:-translate-y-0.5" data-testid={`card-metric-${label.toLowerCase().replace(/\s/g, '-')}`}>
      <div className="mb-5 flex items-start justify-between"><div className={`grid h-8 w-8 place-items-center ${accent === 'amber' ? 'bg-[#fff0c9] text-[#a77517]' : accent === 'red' ? 'bg-[#f7e2de] text-[#a9483e]' : 'bg-[#dcebe7] text-[#39736e]'}`}><Icon size={16} /></div>{status && <StatusPill status={status} />}</div>
      <div className="archive-mono text-[10px] tracking-[.12em] text-[#829197]">{label}</div>
      <div className="archive-display mt-1 text-[25px] font-extrabold tracking-[-.04em] text-[#263844]" data-testid={`text-metric-${label.toLowerCase().replace(/\s/g, '-')}`}>{value}</div>
      <div className="mt-1 text-[11px] text-[#879599]">{note}</div>
    </div>
  );
}

function ActivityRows({ events, emptyLabel = 'No events have been recorded yet.' }: { events: SystemEvent[] | undefined; emptyLabel?: string }) {
  if (!events?.length) return <div className="flex min-h-[160px] flex-col items-center justify-center text-center"><Activity size={20} className="mb-3 text-[#9aa9aa]" /><p className="text-[12px] text-[#829095]">{emptyLabel}</p><p className="mt-1 text-[10px] text-[#a3aeae]">Implemented events will appear here.</p></div>;
  return <div className="divide-y divide-[#e3e8e7]">{events.map((event) => <div key={event.id} className="flex gap-3 py-3 first:pt-0 last:pb-0" data-testid={`row-event-${event.id}`}><span className={`status-dot mt-1.5 ${event.level === 'success' ? 'ready' : event.level === 'warning' ? 'warning' : event.level === 'error' ? 'error' : 'idle'}`} /><div className="min-w-0 flex-1"><div className="text-[12px] leading-5 text-[#43545b]" data-testid={`text-event-message-${event.id}`}>{event.message}</div><div className="archive-mono mt-1 text-[9px] tracking-[.04em] text-[#97a3a4]">{event.source} / {formatTime(event.timestamp)}</div></div></div>)}</div>;
}

function Home() {
  const { data: overview, isLoading, isError, refetch } = useGetSystemOverview();
  const { data: events, isLoading: eventsLoading } = useGetSystemEvents();
  const { data: deps } = useGetSystemDependencies();
  const plex = useGetPlexConfig();
  const activity = overview?.activity?.length ? overview.activity : events;
  const availableDeps = deps?.filter((dep) => dep.status === 'available').length ?? 0;
  const dependencyCount = deps?.length ?? 0;
  if (isLoading) return <><PageIntro eyebrow="CONTROL ROOM / STARTUP" title="Archive at a glance" description="Reading the local node and preparing a trustworthy snapshot." /><div className="grid gap-4 md:grid-cols-3">{[1, 2, 3, 4, 5, 6].map((item) => <Skeleton key={item} className="h-[146px]" />)}</div></>;
  if (isError) return <div className="archive-panel flex min-h-[360px] flex-col items-center justify-center p-8 text-center"><CloudOff size={28} className="mb-4 text-[#c85b51]" /><h1 className="archive-display text-2xl font-extrabold">The local node did not answer</h1><p className="mt-2 max-w-sm text-[13px] leading-6 text-[#77878b]">Overview data is unavailable. Nothing has been assumed or filled in.</p><button onClick={() => refetch()} className="mt-5 inline-flex items-center gap-2 bg-[#1d2b38] px-4 py-2.5 text-[11px] font-bold tracking-[.1em] text-[#f5f6f3] transition-transform hover:-translate-y-0.5" data-testid="button-retry-overview"><RefreshCw size={14} /> RETRY READ</button></div>;
  return (
    <>
      <PageIntro eyebrow="CONTROL ROOM / HOME" title="Archive at a glance" description="A restrained readout of what exists now, what is moving, and what still needs an operator." action={<button onClick={() => refetch()} className="inline-flex items-center gap-2 border border-[var(--line)] bg-white/60 px-3.5 py-2.5 text-[10px] font-bold tracking-[.11em] text-[#5a6d73] transition-colors hover:border-[#81999a] hover:bg-white" data-testid="button-refresh-overview"><RefreshCw size={14} /> REFRESH READOUT</button>} />
      <div className="mb-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <MetricCard icon={Library} label="ARCHIVE" value={statusText(overview?.archiveStatus)} status={overview?.archiveStatus} note="Collection index" />
        <MetricCard icon={PlaySquare} label="PLEX" value={plex.data?.configured ? statusText(plex.data.status) : 'NOT SET'} status={plex.data?.configured ? plex.data.status : 'not_configured'} note={plex.data?.configured ? 'Configuration present' : 'Connection never assumed'} accent="amber" />
        <MetricCard icon={Download} label="QUEUE" value={statusText(overview?.queueStatus)} status={overview?.queueStatus} note="Ingest pipeline" accent="amber" />
        <MetricCard icon={Cpu} label="PROCESSING" value={statusText(overview?.processingStatus)} status={overview?.processingStatus} note="Local workers" />
        <MetricCard icon={HardDrive} label="STORAGE" value={statusText(overview?.storageStatus)} status={overview?.storageStatus} note="Path and capacity read" />
        <MetricCard icon={Sparkles} label="AI STATUS" value={statusText(overview?.aiStatus)} status={overview?.aiStatus} note={dependencyCount ? `${availableDeps}/${dependencyCount} local dependencies available` : 'No dependency readout'} accent="amber" />
      </div>
      <div className="grid gap-5 xl:grid-cols-[1.3fr_.7fr]">
        <section className="archive-panel archive-fade archive-fade-delay-2 p-5 md:p-6" data-testid="panel-recent-activity">
          <div className="mb-5 flex items-center justify-between"><div><div className="archive-mono text-[10px] tracking-[.14em] text-[#7f9194]">LATEST SIGNALS</div><h2 className="archive-display mt-1 text-lg font-extrabold">Recent activity</h2></div><Link href="/history" className="inline-flex items-center gap-1 text-[10px] font-bold tracking-[.1em] text-[#4e9690] hover:text-[#2d6964]" data-testid="link-view-history">VIEW HISTORY <ArrowUpRight size={13} /></Link></div>
          {eventsLoading ? <div className="space-y-3"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-10" /></div> : <ActivityRows events={activity} />}
        </section>
        <section className="archive-panel archive-fade archive-fade-delay-3 p-5 md:p-6" data-testid="panel-sync">
          <div className="archive-mono text-[10px] tracking-[.14em] text-[#7f9194]">SYSTEM PULSE</div><h2 className="archive-display mt-1 text-lg font-extrabold">Last sync</h2>
          <div className="mt-7 border-l-2 border-[#f4b942] pl-4"><div className="archive-mono text-[27px] font-medium tracking-[-.05em] text-[#263844]" data-testid="text-last-sync">{formatTime(overview?.lastSync)}</div><div className="mt-2 text-[11px] leading-5 text-[#7d8b8e]">{overview?.lastSync ? 'The local snapshot has a recorded sync point.' : 'No sync has been recorded. This is not an error.'}</div></div>
          <Link href="/settings" className="mt-8 flex items-center justify-between border-t border-[#e3e8e7] pt-4 text-[10px] font-bold tracking-[.1em] text-[#65787c] hover:text-[#21303d]" data-testid="link-open-settings">SYSTEM SETTINGS <ChevronRight size={14} /></Link>
        </section>
      </div>
    </>
  );
}

const placeholderCopy: Record<string, { title: string; description: string; icon: typeof Activity; eyebrow: string }> = {
  ASSISTANT: { eyebrow: 'WORKSPACE / PLACEHOLDER', title: 'Assistant console', description: 'The local assistant surface is reserved for collection-aware questions and guided actions.', icon: Bot },
  QUEUE: { eyebrow: 'WORKSPACE / PLACEHOLDER', title: 'Ingest queue', description: 'Queue controls will live here when the local ingest pipeline is implemented.', icon: Download },
  ARCHIVE: { eyebrow: 'WORKSPACE / PLACEHOLDER', title: 'Archive browser', description: 'A searchable browser for verified media is planned. No records are fabricated in this preview.', icon: Archive },
  SOURCES: { eyebrow: 'WORKSPACE / PLACEHOLDER', title: 'Source registry', description: 'Source folders and watch paths will be managed here in a future slice.', icon: FolderOpen },
  HISTORY: { eyebrow: 'WORKSPACE / PLACEHOLDER', title: 'Event history', description: 'A complete operator log will appear here. The home readout currently shows the available event stream.', icon: History },
};

function PlaceholderPage({ section }: { section: keyof typeof placeholderCopy }) {
  const copy = placeholderCopy[section];
  const Icon = copy.icon;
  const { data: events, isLoading } = useGetSystemEvents();
  return (
    <>
      <PageIntro eyebrow={copy.eyebrow} title={copy.title} description={copy.description} />
      <div className="archive-panel relative flex min-h-[420px] flex-col items-center justify-center overflow-hidden p-8 text-center">
        <div className="absolute left-0 top-0 h-1 w-24 bg-[#f4b942]" /><div className="absolute right-8 top-8 archive-mono text-[9px] tracking-[.16em] text-[#a2adae]">NOT YET IMPLEMENTED</div>
        <div className="grid h-16 w-16 place-items-center border border-[#d6dfdc] bg-[#eaf0ed] text-[#4e9690]"><Icon size={27} strokeWidth={1.4} /></div>
        <h2 className="archive-display mt-6 text-[25px] font-extrabold text-[#2b3d46]">Surface is reserved</h2>
        <p className="mt-2 max-w-md text-[13px] leading-6 text-[#7c8a8d]">This workspace is intentionally honest about its current state. The shell is implemented; the operational feature is future work.</p>
        <div className="mt-7 flex items-center gap-2 border border-[#e1e7e5] bg-[#f8faf8] px-3 py-2 archive-mono text-[9px] tracking-[.1em] text-[#799094]"><CircleHelp size={13} /> PLACEHOLDER / SAFE TO EXPLORE</div>
        {section === 'HISTORY' && <div className="mt-9 w-full max-w-lg text-left"><div className="mb-3 flex items-center justify-between archive-mono text-[9px] tracking-[.12em] text-[#88999c]"><span>AVAILABLE SIGNAL PREVIEW</span><span>{events?.length ?? 0} EVENTS</span></div>{isLoading ? <Skeleton className="h-12" /> : <ActivityRows events={events} emptyLabel="The event stream is currently empty." />}</div>}
      </div>
    </>
  );
}

function PlexPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useGetPlexConfig();
  const mutation = useUpdatePlexConfig();
  const [serverUrl, setServerUrl] = useState('');
  const [token, setToken] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => { if (data) setServerUrl(data.serverUrl ?? ''); }, [data]);
  const save = () => {
    setNotice('');
    mutation.mutate(
      { data: { serverUrl, ...(token ? { token } : {}) } },
      {
        onSuccess: (result) => {
          setToken('');
          setNotice('Configuration saved. Connection remains unverified until the next local check.');
          queryClient.setQueryData(getGetPlexConfigQueryKey(), result);
        },
        onError: () => setNotice('Configuration could not be saved. The local node did not accept the update.'),
      },
    );
  };
  if (isLoading) return <><PageIntro eyebrow="INTEGRATION / PLEX" title="Plex configuration" description="Read the local connection settings without implying a live connection." /><Skeleton className="h-[390px]" /></>;
  if (isError) return <div className="archive-panel flex min-h-[330px] flex-col items-center justify-center text-center"><CloudOff size={26} className="mb-4 text-[#c85b51]" /><h1 className="archive-display text-2xl font-extrabold">Plex status unavailable</h1><button onClick={() => refetch()} className="mt-5 border border-[var(--line)] bg-white px-4 py-2 text-[11px] font-bold" data-testid="button-retry-plex"><RefreshCw size={14} className="mr-2 inline" /> RETRY READ</button></div>;
  return (
    <>
      <PageIntro eyebrow="INTEGRATION / PLEX" title="Plex configuration" description="Store the endpoint and credentials for a future connection. Archive Assistant never presents Plex as connected without evidence." action={<StatusPill status={data?.configured ? data.status : 'not_configured'} label={data?.configured ? statusText(data.status) : 'NOT CONFIGURED'} />} />
      <div className="grid gap-5 xl:grid-cols-[1fr_330px]">
         <form className="archive-panel p-5 md:p-7" data-testid="panel-plex-form" onSubmit={(event) => { event.preventDefault(); save(); }}>
          <div className="mb-7 flex items-start gap-3 border-b border-[#e3e8e7] pb-5"><div className="grid h-9 w-9 place-items-center bg-[#fff0c9] text-[#a77517]"><PlaySquare size={18} /></div><div><h2 className="archive-display text-lg font-extrabold">Server endpoint</h2><p className="mt-1 text-[11px] text-[#859296]">Implemented configuration fields</p></div></div>
           <label className="mb-5 block"><span className="archive-mono mb-2 block text-[10px] tracking-[.1em] text-[#6e8185]">SERVER URL</span><div className="flex items-center border border-[#d6dfdc] bg-[#fbfcfa] focus-within:border-[#4e9690]"><Link2 size={15} className="ml-3 text-[#8a9b9e]" /><input autoComplete="url" value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="http://localhost:32400" className="w-full bg-transparent px-3 py-3 text-[13px] outline-none placeholder:text-[#aab5b5]" data-testid="input-plex-server-url" /></div></label>
           <label className="block"><span className="archive-mono mb-2 block text-[10px] tracking-[.1em] text-[#6e8185]">PLEX TOKEN <span className="text-[#a7b0b0]">/ OPTIONAL UPDATE</span></span><input autoComplete="current-password" type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder={data?.hasToken ? 'Token is stored — enter to replace' : 'Paste token when ready'} className="w-full border border-[#d6dfdc] bg-[#fbfcfa] px-3 py-3 text-[13px] outline-none placeholder:text-[#aab5b5] focus:border-[#4e9690]" data-testid="input-plex-token" /></label>
           <div className="mt-7 flex flex-wrap items-center gap-3"><button type="submit" disabled={mutation.isPending} className="inline-flex items-center gap-2 bg-[#1d2b38] px-4 py-3 text-[11px] font-bold tracking-[.1em] text-[#f5f6f3] transition-transform hover:-translate-y-0.5 disabled:opacity-50" data-testid="button-save-plex">{mutation.isPending ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />} {mutation.isPending ? 'SAVING' : 'SAVE CONFIGURATION'}</button>{notice && <span className={`text-[11px] ${notice.includes('could not') ? 'text-[#c85b51]' : 'text-[#39736e]'}`} data-testid="status-plex-save">{notice.includes('could not') ? null : <Check size={14} className="mr-1 inline" />}{notice}</span>}</div>
         </form>
        <section className="archive-panel h-fit p-5 md:p-6" data-testid="panel-plex-trust">
          <div className="archive-mono text-[10px] tracking-[.14em] text-[#7f9194]">TRUST READOUT</div><h2 className="archive-display mt-1 text-lg font-extrabold">What is known</h2>
          <div className="mt-5 space-y-4 text-[12px]"><Readout label="Endpoint stored" value={data?.configured ? 'YES' : 'NO'} tone={data?.configured ? 'good' : 'warn'} /><Readout label="Token present" value={data?.hasToken ? 'YES' : 'NO'} tone={data?.hasToken ? 'good' : 'warn'} /><Readout label="Live connection" value="NOT CLAIMED" tone="neutral" /></div>
          <div className="mt-6 border-l-2 border-[#f4b942] bg-[#fff8e7] p-3 text-[11px] leading-5 text-[#80652e]">Saving details does not test or claim a live Plex connection. That check belongs to a future integration slice.</div>
        </section>
      </div>
    </>
  );
}

function Readout({ label, value, tone }: { label: string; value: string; tone: 'good' | 'warn' | 'neutral' }) {
  return <div className="flex items-center justify-between border-b border-[#e7ecea] pb-3 last:border-0"><span className="text-[#728287]">{label}</span><span className={`archive-mono text-[10px] font-medium ${tone === 'good' ? 'text-[#39736e]' : tone === 'warn' ? 'text-[#a77517]' : 'text-[#8a9899]'}`}>{value}</span></div>;
}

const settingsGroups = [
  { name: 'General', icon: SlidersHorizontal, fields: ['mockMode', 'dataDirectory', 'logLevel'] },
  { name: 'Downloads', icon: Download, fields: ['downloadDirectory'] },
  { name: 'Archive', icon: Archive, fields: ['archiveDirectory'] },
  { name: 'Plex', icon: PlaySquare, fields: [] },
  { name: 'AI', icon: Sparkles, fields: [] },
  { name: 'Local Model', icon: Cpu, fields: [] },
  { name: 'OpenAI', icon: Zap, fields: [] },
  { name: 'FFmpeg', icon: Terminal, fields: [] },
  { name: 'Hardware Acceleration', icon: Cpu, fields: ['hardwareAcceleration'] },
  { name: 'Network', icon: Network, fields: ['networkMode'] },
  { name: 'Security', icon: ShieldCheck, fields: [] },
  { name: 'Logging', icon: Terminal, fields: [] },
];

function SettingsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useGetSettings();
  const { data: dependencies } = useGetSystemDependencies();
  const mutation = useUpdateSettings();
  const [form, setForm] = useState<Partial<AppSettings>>({});
  const [notice, setNotice] = useState('');
  useEffect(() => { if (data) setForm(data); }, [data]);
  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => setForm((current) => ({ ...current, [key]: value }));
  const save = () => {
    setNotice('');
    const payload: AppSettingsUpdate = { ...form };
    mutation.mutate(
      { data: payload },
      {
        onSuccess: (result) => {
          setNotice('Settings saved to the local node.');
          setForm(result);
          queryClient.setQueryData(getGetSettingsQueryKey(), result);
        },
        onError: () => setNotice('Settings could not be saved. The local node did not accept the update.'),
      },
    );
  };
  if (isLoading) return <><PageIntro eyebrow="SYSTEM / SETTINGS" title="System settings" description="Loading editable local preferences." /><Skeleton className="h-[520px]" /></>;
  if (isError) return <div className="archive-panel flex min-h-[330px] flex-col items-center justify-center text-center"><CloudOff size={26} className="mb-4 text-[#c85b51]" /><h1 className="archive-display text-2xl font-extrabold">Settings unavailable</h1><button onClick={() => refetch()} className="mt-5 border border-[var(--line)] bg-white px-4 py-2 text-[11px] font-bold" data-testid="button-retry-settings"><RefreshCw size={14} className="mr-2 inline" /> RETRY READ</button></div>;
  return (
    <>
      <PageIntro eyebrow="SYSTEM / SETTINGS" title="System settings" description="Persistent preferences for this local-first control room. Changes are sent to the real settings API." action={<div className="flex items-center gap-3">{notice && <span className="text-[11px] text-[#39736e]" data-testid="status-settings-save"><Check size={14} className="mr-1 inline" />{notice}</span>}<button onClick={save} disabled={mutation.isPending} className="inline-flex items-center gap-2 bg-[#1d2b38] px-4 py-2.5 text-[11px] font-bold tracking-[.1em] text-[#f5f6f3] transition-transform hover:-translate-y-0.5 disabled:opacity-50" data-testid="button-save-settings"><Save size={14} /> {mutation.isPending ? 'SAVING' : 'SAVE CHANGES'}</button></div>} />
      <div className="grid gap-5 xl:grid-cols-[1fr_260px]">
        <div className="space-y-4">{settingsGroups.map(({ name, icon: Icon, fields }) => <SettingsGroup key={name} name={name} icon={Icon} fields={fields} form={form} update={update} />)}</div>
        <aside className="archive-panel h-fit p-5 md:p-6"><div className="archive-mono text-[10px] tracking-[.14em] text-[#7f9194]">LOCAL DEPENDENCIES</div><h2 className="archive-display mt-1 text-lg font-extrabold">Capability check</h2><div className="mt-5 space-y-3">{dependencies?.length ? dependencies.map((dep) => <div key={dep.name} className="flex items-center gap-3" data-testid={`row-dependency-${dep.name}`}><span className={`status-dot ${dep.status === 'available' ? 'ready' : dep.status === 'missing' ? 'error' : 'warning'}`} /><div className="min-w-0"><div className="truncate text-[11px] font-semibold text-[#53656b]">{dep.name}</div><div className="archive-mono text-[9px] text-[#96a3a5]">{dep.version ?? dep.status}</div></div></div>) : <p className="text-[11px] leading-5 text-[#879599]">No dependency data returned yet.</p>}</div><div className="mt-6 border-t border-[#e3e8e7] pt-4 text-[10px] leading-5 text-[#879599]">Only values represented by the API are editable. Future sections stay visibly reserved.</div></aside>
      </div>
    </>
  );
}

function SettingsGroup({ name, icon: Icon, fields, form, update }: { name: string; icon: typeof SlidersHorizontal; fields: string[]; form: Partial<AppSettings>; update: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void }) {
  const [open, setOpen] = useState(fields.length > 0);
  return <section className={`archive-panel overflow-hidden ${fields.length ? '' : 'opacity-75'}`} data-testid={`settings-group-${name.toLowerCase().replace(/\s/g, '-')}`}><button onClick={() => setOpen((value) => !value)} className="flex w-full items-center justify-between px-5 py-4 text-left hover:bg-white/50" data-testid={`button-toggle-settings-${name.toLowerCase().replace(/\s/g, '-')}`}><span className="flex items-center gap-3"><span className="grid h-8 w-8 place-items-center bg-[#e8efed] text-[#4e9690]"><Icon size={15} /></span><span className="archive-display text-[14px] font-extrabold text-[#354851]">{name}</span>{fields.length === 0 && <span className="archive-mono text-[8px] tracking-[.1em] text-[#9ba6a7]">RESERVED</span>}</span><ChevronRight size={16} className={`text-[#9aa7a7] transition-transform ${open ? 'rotate-90' : ''}`} /></button>{open && fields.length > 0 && <div className="grid gap-4 border-t border-[#e4eae8] bg-[#fbfcfa]/60 px-5 py-5 md:grid-cols-2">{fields.map((field) => <SettingField key={field} field={field} form={form} update={update} />)}</div>}</section>;
}

function SettingField({ field, form, update }: { field: string; form: Partial<AppSettings>; update: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void }) {
  if (field === 'mockMode' || field === 'hardwareAcceleration') return <label className="flex items-center justify-between gap-4 border border-[#e2e8e6] bg-white/50 px-3 py-3"><span><span className="block text-[11px] font-semibold text-[#53656b]">{field === 'mockMode' ? 'Mock mode' : 'Hardware acceleration'}</span><span className="mt-1 block text-[10px] text-[#94a1a3]">{field === 'mockMode' ? 'Use simulated local data' : 'Allow accelerated media work'}</span></span><input type="checkbox" checked={Boolean(form[field as keyof AppSettings])} onChange={(event) => update(field as keyof AppSettings, event.target.checked as never)} className="h-4 w-4 accent-[#4e9690]" data-testid={`input-setting-${field}`} /></label>;
  if (field === 'logLevel' || field === 'networkMode') return <label><span className="archive-mono mb-2 block text-[10px] tracking-[.1em] text-[#6e8185]">{field === 'logLevel' ? 'LOG LEVEL' : 'NETWORK MODE'}</span><select value={String(form[field as keyof AppSettings] ?? '')} onChange={(event) => update(field as keyof AppSettings, event.target.value as never)} className="w-full border border-[#d6dfdc] bg-[#fbfcfa] px-3 py-2.5 text-[12px] outline-none focus:border-[#4e9690]" data-testid={`select-setting-${field}`}>{field === 'logLevel' ? <><option value="info">info</option><option value="debug">debug</option><option value="warn">warn</option><option value="error">error</option></> : <><option value="offline">offline</option><option value="local_only">local_only</option><option value="allow_network">allow_network</option></>}</select></label>;
  const labels: Record<string, string> = { dataDirectory: 'DATA DIRECTORY', downloadDirectory: 'DOWNLOAD DIRECTORY', archiveDirectory: 'ARCHIVE DIRECTORY' };
  return <label><span className="archive-mono mb-2 block text-[10px] tracking-[.1em] text-[#6e8185]">{labels[field] ?? field.toUpperCase()}</span><input value={String(form[field as keyof AppSettings] ?? '')} onChange={(event) => update(field as keyof AppSettings, event.target.value as never)} className="w-full border border-[#d6dfdc] bg-[#fbfcfa] px-3 py-2.5 text-[12px] outline-none focus:border-[#4e9690]" data-testid={`input-setting-${field}`} /></label>;
}

function Router() {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}><AppShell><Switch><Route path="/" component={Home} /><Route path="/assistant"><PlaceholderPage section="ASSISTANT" /></Route><Route path="/queue"><PlaceholderPage section="QUEUE" /></Route><Route path="/archive"><PlaceholderPage section="ARCHIVE" /></Route><Route path="/plex" component={PlexPage} /><Route path="/sources"><PlaceholderPage section="SOURCES" /></Route><Route path="/history"><PlaceholderPage section="HISTORY" /></Route><Route path="/settings" component={SettingsPage} /><Route component={NotFound} /></Switch></AppShell></ErrorBoundary>;
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;
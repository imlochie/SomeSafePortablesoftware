import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ClerkProvider, SignIn, SignUp, useAuth, useClerk, useUser } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import {
  Activity, Archive, ArrowDownToLine, ArrowUpRight, Bot, Check, ChevronRight, CircleHelp,
  CloudOff, Cpu, Download, FileCheck2, FolderOpen, HardDrive, History,
  Library, Link2, Menu, Network, Pause, Play, PlaySquare, Plus, RefreshCw, RotateCcw,
  Save, Search, Settings as SettingsIcon, ShieldCheck, SlidersHorizontal,
  Sparkles, Square, Terminal, Trash2, X, Zap,
} from 'lucide-react';
import {
  getGetDownloadsQueryKey, getGetPlexConfigQueryKey, getGetPlexInventoryQueryKey, getGetSettingsQueryKey, getGetSystemEventsQueryKey,
  getGetSystemOverviewQueryKey, useCancelDownload, useCreateDownload, useDeleteDownload,
  useGetDownloads, useGetPlexConfig, useGetPlexInventory, useGetSettings, useGetSystemDependencies,
  useGetSystemEvents, useGetSystemOverview, useHealthCheck, useInspectMediaSource,
  usePauseDownload, usePrepareDownload, useRetryDownload, useResumeDownload,
  useStartDownload, useStartPlexSync, useTestPlexConnection, useUpdatePlexConfig, useUpdateSettings,
  useGetArchiveScan, useStartArchiveScan, useGetArchiveInventory, useGetArchiveRecord, useGetArchiveNamingProposals,
  useUpdateArchiveRecordReview, useUpdateArchiveRecordReviews, getGetArchiveScanQueryKey, getGetArchiveInventoryQueryKey,
  getGetArchiveRecordQueryKey,
  useUpdateArchiveNamingProposalDecisions, useApplyArchiveNamingProposals, useGetArchiveOperations,
  useRollbackArchiveOperation, getGetArchiveNamingProposalsQueryKey, getGetArchiveOperationsQueryKey,
  useGetArchiveQualityRecord, useUpdateArchiveQualityFindingReview,
  getGetArchiveQualityRecordQueryKey, getGetArchiveQualityFindingsQueryKey, useGetArchiveQualityFindings,
  getGetAcquisitionFindingsQueryKey,
  useGetAcquisitionFindings,
  useRefreshAcquisitionIntelligence,
  useCreateAcquisitionPlan, useApproveAcquisitionPlan, useRejectAcquisitionPlan, useExecuteAcquisitionPlan,
  useListAcquisitionPlans, getListAcquisitionPlansQueryKey, getGetAcquisitionPlanQueryKey, useGetAcquisitionPlan,
  setBaseUrl,
} from '@workspace/api-client-react';
import type { AppSettings, AppSettingsUpdate, DownloadJob, MediaFormat, MediaInspection, SystemEvent, GetAcquisitionFindingsParams, AcquisitionPlan } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Link, Redirect, Route, Router as WouterRouter, Switch, useLocation } from 'wouter';

const queryClient = new QueryClient();
const navItems = [
  { label: 'HOME', href: '/user-portal', icon: Activity }, { label: 'ASSISTANT', href: '/assistant', icon: Bot },
  { label: 'QUEUE', href: '/queue', icon: Download }, { label: 'ARCHIVE', href: '/archive', icon: Archive },
  { label: 'DISCOVERY', href: '/discovery', icon: Search },
  { label: 'PLEX', href: '/plex', icon: PlaySquare }, { label: 'SOURCES', href: '/sources', icon: FolderOpen },
  { label: 'HISTORY', href: '/history', icon: History }, { label: 'SETTINGS', href: '/settings', icon: SettingsIcon },
];
const authMode = import.meta.env.VITE_AUTH_MODE === 'clerk' ? 'clerk' : 'local';
const clerkPubKey = authMode === 'clerk'
  ? publishableKeyFromHost(window.location.hostname, import.meta.env.VITE_CLERK_PUBLISHABLE_KEY)
  : null;
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const desktopApiBaseUrl = (window as Window & {
  __ARCHIVE_API_BASE_URL__?: string;
}).__ARCHIVE_API_BASE_URL__;
setBaseUrl(import.meta.env.VITE_API_BASE_URL?.trim() || desktopApiBaseUrl || null);

if (authMode === 'clerk' && !clerkPubKey) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');
}

type AppAuth = {
  mode: 'local' | 'clerk';
  userId: string | null;
  isLoaded: boolean;
  isSignedIn: boolean;
  email: string;
  initials: string;
  signOut: () => void | Promise<void>;
};
const AppAuthContext = createContext<AppAuth | null>(null);
function useAppAuth() {
  const value = useContext(AppAuthContext);
  if (!value) throw new Error('Application authentication context is unavailable.');
  return value;
}
function ClerkAuthBridge({ children }: { children: ReactNode }) {
  const { userId, isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const { signOut } = useClerk();
  const initials = [user?.firstName?.[0], user?.lastName?.[0]].filter(Boolean).join('').toUpperCase() || 'OP';
  return <AppAuthContext.Provider value={{
    mode: 'clerk',
    userId: userId ?? null,
    isLoaded,
    isSignedIn: Boolean(isSignedIn),
    email: user?.primaryEmailAddress?.emailAddress ?? 'Signed-in operator',
    initials,
    signOut: () => signOut({ redirectUrl: basePath || '/' }),
  }}>{children}</AppAuthContext.Provider>;
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: '#39736e',
    colorForeground: '#263844',
    colorMutedForeground: '#718087',
    colorDanger: '#a9483e',
    colorBackground: '#fbfcfa',
    colorInput: '#f8faf8',
    colorInputForeground: '#263844',
    colorNeutral: '#d6dfdc',
    fontFamily: 'Manrope, sans-serif',
    borderRadius: '0px',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'bg-[#fbfcfa] rounded-none w-[440px] max-w-full overflow-hidden',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: 'text-[#263844] font-extrabold',
    headerSubtitle: 'text-[#718087]',
    socialButtonsBlockButtonText: 'text-[#43545b] font-semibold',
    formFieldLabel: 'text-[#53656b] font-semibold',
    footerActionLink: 'text-[#39736e] font-semibold',
    footerActionText: 'text-[#718087]',
    dividerText: 'text-[#879599]',
    identityPreviewEditButton: 'text-[#39736e]',
    formFieldSuccessText: 'text-[#39736e]',
    alertText: 'text-[#a9483e]',
    logoBox: 'h-10',
    logoImage: 'max-h-10',
    socialButtonsBlockButton: 'border-[#d6dfdc] bg-white hover:bg-[#eaf3ef]',
    formButtonPrimary: 'bg-[#1d2b38] text-[#f5f6f3] hover:bg-[#263b4a]',
    formFieldInput: 'border-[#d6dfdc] bg-[#f8faf8] text-[#263844]',
    footerAction: 'border-[#e3e8e7]',
    dividerLine: 'bg-[#e3e8e7]',
    alert: 'border-[#efd3cf] bg-[#fcedea]',
    otpCodeFieldInput: 'border-[#d6dfdc] bg-[#f8faf8] text-[#263844]',
    formFieldRow: 'gap-2',
    main: 'bg-transparent',
  },
};
const statusLabels: Record<string, string> = {
  ready: 'READY', connected: 'CONNECTED', idle: 'IDLE', placeholder: 'PLACEHOLDER',
  warning: 'WARNING', unavailable: 'UNAVAILABLE', processing: 'PROCESSING',
  not_configured: 'NOT CONFIGURED', configured: 'CONFIGURED / UNVERIFIED', connection_failed: 'CONNECTION FAILED',
  syncing: 'SYNCING', synced: 'SYNCED', sync_error: 'SYNC ERROR',
  error: 'ERROR', queued: 'QUEUED', inspecting: 'INSPECTING',
  downloading: 'DOWNLOADING', downloaded: 'DOWNLOADED', verifying: 'VERIFYING', moving: 'MOVING',
  complete: 'COMPLETE', failed: 'FAILED', cancelled: 'CANCELLED', paused: 'PAUSED',
  recovery_required: 'RECOVERY REQUIRED',
};

function formatTime(value: string | null | undefined) {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}
function formatBytes(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024; let index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
  return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[index]}`;
}
function formatDuration(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined) return 'Unknown duration';
  const mins = Math.floor(seconds / 60); const secs = Math.round(seconds % 60);
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m ${String(secs).padStart(2, '0')}s`;
}
function statusText(value: string | undefined) { return value ? statusLabels[value] ?? value.toUpperCase() : 'CHECKING'; }
function errorText(error: unknown) {
  if (!error) return 'The local node did not accept the request.';
  if (typeof error === 'object' && error && 'message' in error) return String((error as { message?: string }).message);
  return 'The local node did not accept the request.';
}
function StatusPill({ status, label }: { status?: string; label?: string }) {
  return <span className="inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-white/70 px-2.5 py-1 text-[10px] font-bold tracking-[.1em] text-[#53636a]" data-testid={`status-${label?.toLowerCase().replace(/\s/g, '-') ?? status}`}><span className={`status-dot ${status ?? 'idle'}`} />{label ?? statusText(status)}</span>;
}
function Skeleton({ className = '' }: { className?: string }) { return <div className={`animate-pulse rounded bg-[#dfe6e5] ${className}`} />; }

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const [location] = useLocation();
  return <aside className="flex w-full shrink-0 flex-col bg-[#1d2b38] text-[#d7e0df] md:min-h-[100dvh] md:w-[230px]" data-testid="navigation-sidebar">
    <div className="flex items-center justify-between border-b border-white/10 px-5 py-5 md:block">
      <Link href="/" className="flex items-center gap-3" data-testid="link-home-logo" onClick={onNavigate}><div className="grid h-9 w-9 place-items-center border border-[#f4b942] text-[#f4b942]"><Archive size={18} strokeWidth={1.7} /></div><div><div className="archive-display text-[15px] font-extrabold tracking-[.12em] text-[#f5f6f3]">ARCHIVE</div><div className="archive-mono text-[8px] tracking-[.28em] text-[#93a6a9]">ASSISTANT / LOCAL</div></div></Link>
      <button className="grid h-9 w-9 place-items-center border border-white/10 text-[#9bb0b1] md:hidden" onClick={onNavigate} aria-label="Close navigation" data-testid="button-close-navigation"><X size={18} /></button>
    </div>
    <div className="hidden px-5 py-5 md:block"><div className="archive-mono flex items-center gap-2 text-[9px] font-medium uppercase tracking-[.14em] text-[#7f979b]"><span className="status-dot ready" /> LOCAL NODE ONLINE</div><div className="mt-2 text-[11px] text-[#71898e]">Windows workstation / primary</div></div>
    <nav className="grid grid-cols-4 gap-1 px-3 py-3 md:block md:px-3 md:py-1">{navItems.map(({ label, href, icon: Icon }) => { const active = location === href; return <Link key={label} href={href} onClick={onNavigate} className={`archive-nav-item flex min-h-[52px] flex-col items-center justify-center gap-1.5 rounded-sm px-3 py-2 md:mb-1 md:min-h-0 md:flex-row md:justify-start md:gap-3 ${active ? 'bg-[#f4b942] text-[#1d2b38]' : 'text-[#9db0b1] hover:bg-white/8 hover:text-[#f5f6f3]'}`} data-testid={`link-nav-${label.toLowerCase()}`}><Icon size={16} strokeWidth={active ? 2.2 : 1.7} /><span className="text-[10px] font-bold tracking-[.13em] md:text-[11px]">{label}</span>{active && <ChevronRight className="ml-auto hidden md:block" size={14} />}</Link>; })}</nav>
    <div className="mt-auto hidden border-t border-white/10 px-5 py-5 md:block"><div className="archive-mono mb-2 text-[9px] tracking-[.13em] text-[#6f888d]">OPERATOR MODE</div><div className="flex items-center gap-2 text-[11px] text-[#bac8c7]"><ShieldCheck size={14} className="text-[#4e9690]" /> Trusted local session</div></div>
  </aside>;
}
function Topbar({ onMenu }: { onMenu: () => void }) {
  const [location] = useLocation();
  const current = navItems.find((item) => item.href === location)?.label ?? 'HOME';
  const { data: health, isLoading } = useHealthCheck();
  const auth = useAppAuth();
  return <header className="flex min-h-[73px] items-center justify-between border-b border-[var(--line)] bg-[#f3f5f4]/90 px-5 backdrop-blur md:px-8"><div className="flex items-center gap-3"><button className="grid h-9 w-9 place-items-center border border-[var(--line)] bg-white/55 md:hidden" onClick={onMenu} aria-label="Open navigation" data-testid="button-open-navigation"><Menu size={18} /></button><div><div className="archive-mono text-[9px] font-medium tracking-[.2em] text-[#829298]">ARCHIVE ASSISTANT / {current}</div><div className="mt-1 text-[12px] font-semibold text-[#51626a]">{current === 'HOME' ? 'System overview' : `${current.charAt(0)}${current.slice(1).toLowerCase()} workspace`}</div></div></div><div className="hidden items-center gap-4 sm:flex"><div className="archive-mono flex items-center gap-2 text-[9px] tracking-[.1em] text-[#71858a]" data-testid="status-health"><span className={`status-dot ${health?.status === 'ok' ? 'ready' : 'warning'}`} />{isLoading ? 'CHECKING NODE' : health?.status === 'ok' ? 'API HEALTHY' : 'API UNCONFIRMED'}</div><div className="h-5 w-px bg-[var(--line)]" /><button className="text-[#71858a] transition-colors hover:text-[#21303d]" aria-label="Search archive" data-testid="button-search"><Search size={17} /></button><div className="text-right"><div className="max-w-[150px] truncate text-[10px] font-semibold text-[#51626a]">{auth.email}</div>{auth.mode === 'clerk' ? <button type="button" onClick={() => auth.signOut()} className="archive-mono text-[9px] tracking-[.08em] text-[#71858a] hover:text-[#21303d]" data-testid="button-sign-out">SIGN OUT</button> : <div className="archive-mono text-[9px] tracking-[.08em] text-[#71858a]">LOCAL MODE</div>}</div><div className="grid h-8 w-8 place-items-center bg-[#dfe8e5] text-[11px] font-extrabold text-[#315e5b]" data-testid="text-operator-avatar">{auth.initials}</div></div></header>;
}
function AppShell({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return <div className="archive-shell flex flex-col md:flex-row"><div className={`fixed inset-0 z-30 bg-[#17232d]/45 transition-opacity md:static md:z-auto md:block md:bg-transparent ${menuOpen ? 'block opacity-100' : 'pointer-events-none hidden opacity-0'}`} onClick={() => setMenuOpen(false)} /><div className={`fixed inset-y-0 left-0 z-40 w-[230px] transition-transform md:static md:z-auto md:block md:translate-x-0 ${menuOpen ? 'translate-x-0' : '-translate-x-full'}`}><Sidebar onNavigate={() => setMenuOpen(false)} /></div><main className="min-w-0 flex-1"><Topbar onMenu={() => setMenuOpen(true)} /><div className="archive-grid min-h-[calc(100dvh-73px)] p-5 md:p-8">{children}</div></main></div>;
}
function PageIntro({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="mb-7 flex flex-col justify-between gap-5 md:flex-row md:items-end"><div className="archive-fade"><div className="archive-mono mb-2 text-[10px] font-medium tracking-[.2em] text-[#7a9093]">{eyebrow}</div><h1 className="archive-display text-3xl font-extrabold text-[#21303d] md:text-[38px]">{title}</h1><p className="mt-2 max-w-xl text-[13px] leading-6 text-[#718087]">{description}</p></div>{action}</div>;
}
function Readout({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'good' | 'warn' | 'neutral' }) {
  return <div className="flex items-center justify-between border-b border-[#e7ecea] pb-3 last:border-0"><span className="text-[#728287]">{label}</span><span className={`archive-mono text-[10px] font-medium ${tone === 'good' ? 'text-[#39736e]' : tone === 'warn' ? 'text-[#a77517]' : 'text-[#8a9899]'}`}>{value}</span></div>;
}
function ActivityRows({ events, emptyLabel = 'No events have been recorded yet.' }: { events?: SystemEvent[]; emptyLabel?: string }) {
  if (!events?.length) return <div className="flex min-h-[160px] flex-col items-center justify-center text-center"><Activity size={20} className="mb-3 text-[#9aa9aa]" /><p className="text-[12px] text-[#829095]">{emptyLabel}</p><p className="mt-1 text-[10px] text-[#a3aeae]">Proven system events will appear here.</p></div>;
  return <div className="divide-y divide-[#e3e8e7]">{events.map((event) => <div key={event.id} className="flex gap-3 py-3 first:pt-0 last:pb-0" data-testid={`row-event-${event.id}`}><span className={`status-dot mt-1.5 ${event.level === 'success' ? 'ready' : event.level === 'warning' ? 'warning' : event.level === 'error' ? 'error' : 'idle'}`} /><div className="min-w-0 flex-1"><div className="text-[12px] leading-5 text-[#43545b]" data-testid={`text-event-message-${event.id}`}>{event.message}</div><div className="archive-mono mt-1 text-[9px] tracking-[.04em] text-[#97a3a4]">{event.source} / {formatTime(event.timestamp)}</div></div></div>)}</div>;
}
function MetricCard({ icon: Icon, label, value, status, note, accent = 'teal' }: { icon: typeof Activity; label: string; value: string; status?: string; note: string; accent?: 'teal' | 'amber' | 'red' }) {
  return <div className="archive-panel archive-fade min-h-[146px] p-5 transition-all duration-300 hover:-translate-y-0.5" data-testid={`card-metric-${label.toLowerCase().replace(/\s/g, '-')}`}><div className="mb-5 flex items-start justify-between"><div className={`grid h-8 w-8 place-items-center ${accent === 'amber' ? 'bg-[#fff0c9] text-[#a77517]' : accent === 'red' ? 'bg-[#f7e2de] text-[#a9483e]' : 'bg-[#dcebe7] text-[#39736e]'}`}><Icon size={16} /></div>{status && <StatusPill status={status} />}</div><div className="archive-mono text-[10px] tracking-[.12em] text-[#829197]">{label}</div><div className="archive-display mt-1 text-[25px] font-extrabold tracking-[-.04em] text-[#263844]" data-testid={`text-metric-${label.toLowerCase().replace(/\s/g, '-')}`}>{value}</div><div className="mt-1 text-[11px] text-[#879599]">{note}</div></div>;
}

function Home() {
  const { data: overview, isLoading, isError, refetch } = useGetSystemOverview(); const { data: events, isLoading: eventsLoading } = useGetSystemEvents(); const { data: deps } = useGetSystemDependencies(); const plex = useGetPlexConfig();
  if (isLoading) return <><PageIntro eyebrow="CONTROL ROOM / STARTUP" title="Archive at a glance" description="Reading the local node and preparing a trustworthy snapshot." /><div className="grid gap-4 md:grid-cols-3">{[1, 2, 3, 4, 5, 6].map((item) => <Skeleton key={item} className="h-[146px]" />)}</div></>;
  if (isError || !overview) return <ErrorState title="The local node did not answer" message="Overview data is unavailable. Nothing has been assumed or filled in." onRetry={() => refetch()} testId="button-retry-overview" />;
  const storage = overview.storage ?? { path: 'Storage readout not returned', freeBytes: 0, totalBytes: 0, usedBytes: 0, freePercent: 0, status: 'unavailable' as const }; const activity = overview.activity?.length ? overview.activity : events; const availableDeps = deps?.filter((dep) => dep.status === 'available').length ?? 0;
  const activeDownloads = overview.activeDownloads ?? 0; const queuedJobs = overview.queuedJobs ?? 0; const processingJobs = overview.processingJobs ?? 0; const completedToday = overview.completedToday ?? 0; const failedToday = overview.failedToday ?? 0;
  return <><PageIntro eyebrow="CONTROL ROOM / HOME" title="Archive at a glance" description="A restrained readout of what exists now, what is moving, and what still needs an operator." action={<button onClick={() => refetch()} className="inline-flex items-center gap-2 border border-[var(--line)] bg-white/60 px-3.5 py-2.5 text-[10px] font-bold tracking-[.11em] text-[#5a6d73] hover:border-[#81999a] hover:bg-white" data-testid="button-refresh-overview"><RefreshCw size={14} /> REFRESH READOUT</button>} /><div className="mb-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-3"><MetricCard icon={Download} label="ACTIVE DOWNLOADS" value={String(activeDownloads)} note={`${queuedJobs} queued / ${processingJobs} processing`} status={activeDownloads ? 'processing' : 'idle'} accent="amber" /><MetricCard icon={Check} label="COMPLETED TODAY" value={String(completedToday)} note="Jobs with verified destinations" status="ready" /><MetricCard icon={Archive} label="FAILED TODAY" value={String(failedToday)} note="Requires operator review" status={failedToday ? 'error' : 'idle'} accent={failedToday ? 'red' : 'teal'} /><MetricCard icon={HardDrive} label="STORAGE" value={`${storage.freePercent.toFixed(1)}% free`} note={`${formatBytes(storage.freeBytes)} available`} status={storage.status} accent="amber" /><MetricCard icon={Library} label="ARCHIVE" value={statusText(overview.archiveStatus)} status={overview.archiveStatus} note="Collection index" /><MetricCard icon={PlaySquare} label="PLEX" value={plex.data?.configured ? statusText(plex.data.status) : 'NOT SET'} status={plex.data?.configured ? plex.data.status : 'not_configured'} note={plex.data?.configured ? 'Configuration present' : 'Connection never assumed'} accent="amber" /></div><div className="mb-5 grid gap-5 xl:grid-cols-[1.2fr_.8fr]"><section className="archive-panel p-5 md:p-6" data-testid="panel-storage-readout"><div className="flex items-start justify-between"><div><div className="archive-mono text-[10px] tracking-[.14em] text-[#7f9194]">CAPACITY / {storage.status.toUpperCase()}</div><h2 className="archive-display mt-1 text-lg font-extrabold">Storage readout</h2></div><HardDrive size={18} className="text-[#4e9690]" /></div><div className="mt-5 flex items-end justify-between"><div><div className="archive-display text-3xl font-extrabold text-[#263844]">{formatBytes(storage.freeBytes)}</div><div className="mt-1 text-[11px] text-[#879599]">free on the archive volume</div></div><div className="archive-mono text-right text-[10px] text-[#829197]">{formatBytes(storage.usedBytes)} used<br />{formatBytes(storage.totalBytes)} total</div></div><div className="mt-5 h-2 overflow-hidden bg-[#e6ecea]"><div className="h-full origin-left bg-[#4e9690] transition-transform duration-500" style={{ transform: `scaleX(${Math.min(1, Math.max(0, (100 - storage.freePercent) / 100))})` }} /></div><div className="mt-3 truncate text-[10px] text-[#8b999d]" title={storage.path}>{storage.path}</div></section><section className="archive-panel p-5 md:p-6" data-testid="panel-system-pulse"><div className="archive-mono text-[10px] tracking-[.14em] text-[#7f9194]">SYSTEM PULSE</div><h2 className="archive-display mt-1 text-lg font-extrabold">Last sync</h2><div className="mt-7 border-l-2 border-[#f4b942] pl-4"><div className="archive-mono text-[24px] font-medium tracking-[-.05em] text-[#263844]" data-testid="text-last-sync">{formatTime(overview.lastSync)}</div><div className="mt-2 text-[11px] leading-5 text-[#7d8b8e]">{overview.lastSync ? 'The local snapshot has a recorded sync point.' : 'No sync has been recorded. This is not an error.'}</div></div><Link href="/settings" className="mt-8 flex items-center justify-between border-t border-[#e3e8e7] pt-4 text-[10px] font-bold tracking-[.1em] text-[#65787c] hover:text-[#21303d]" data-testid="link-open-settings">SYSTEM SETTINGS <ChevronRight size={14} /></Link></section></div><section className="archive-panel p-5 md:p-6" data-testid="panel-recent-activity"><div className="mb-5 flex items-center justify-between"><div><div className="archive-mono text-[10px] tracking-[.14em] text-[#7f9194]">LATEST SIGNALS / {availableDeps} DEPENDENCIES READY</div><h2 className="archive-display mt-1 text-lg font-extrabold">Recent activity</h2></div><Link href="/history" className="inline-flex items-center gap-1 text-[10px] font-bold tracking-[.1em] text-[#4e9690]" data-testid="link-view-history">VIEW HISTORY <ArrowUpRight size={13} /></Link></div>{eventsLoading ? <div className="space-y-3"><Skeleton className="h-10" /><Skeleton className="h-10" /></div> : <ActivityRows events={activity} />}</section></>;
}
function ErrorState({ title, message, onRetry, testId }: { title: string; message: string; onRetry: () => void; testId: string }) {
  return <div className="archive-panel flex min-h-[330px] flex-col items-center justify-center p-8 text-center"><CloudOff size={28} className="mb-4 text-[#c85b51]" /><h1 className="archive-display text-2xl font-extrabold">{title}</h1><p className="mt-2 max-w-sm text-[13px] leading-6 text-[#77878b]">{message}</p><button onClick={onRetry} className="mt-5 inline-flex items-center gap-2 bg-[#1d2b38] px-4 py-2.5 text-[11px] font-bold tracking-[.1em] text-[#f5f6f3]" data-testid={testId}><RefreshCw size={14} /> RETRY READ</button></div>;
}

const formatLabel = (format: MediaFormat) => `${format.resolution || 'adaptive'} / ${format.extension ?? format.container ?? 'stream'}${format.fps ? ` / ${format.fps} fps` : ''}`;
function SourcePage() {
  const [url, setUrl] = useState(''); const [inspection, setInspection] = useState<MediaInspection | null>(null); const [selected, setSelected] = useState(''); const [notice, setNotice] = useState(''); const [created, setCreated] = useState<DownloadJob | null>(null);
  const inspect = useInspectMediaSource(); const prepare = usePrepareDownload(); const create = useCreateDownload(); const start = useStartDownload(); const queryClient = useQueryClient();
  const recommended = inspection?.formats.find((format) => format.formatId === inspection.recommendedFormatId) ?? inspection?.formats.find((format) => format.usable);
  const runInspect = (event: FormEvent) => { event.preventDefault(); setNotice(''); setInspection(null); setCreated(null); if (!url.trim()) { setNotice('Paste a media URL before inspecting.'); return; } inspect.mutate({ data: { url: url.trim(), forceRefresh: false } }, { onSuccess: (result) => { setInspection(result); setSelected(result.recommendedFormatId ?? result.formats.find((format) => format.usable)?.formatId ?? ''); setNotice(result.demoMode ? 'Backend returned demo inspection data.' : 'Inspection verified by the local node.'); }, onError: (error) => setNotice(errorText(error)) }); };
  const prepareDownload = () => { if (!inspection || !selected) return; setNotice('Validating destination and format…'); const format = inspection.formats.find((item) => item.formatId === selected); prepare.mutate({ data: { sourceUrl: inspection.metadata.webpageUrl || url, title: inspection.metadata.title, sourceSite: inspection.metadata.extractor, selectedFormatId: selected, selectedVideoFormatId: inspection.recommendedVideoFormatId, selectedAudioFormatId: inspection.recommendedAudioFormatId, outputContainer: (format?.extension === 'webm' ? 'webm' : 'mkv'), finalFilename: inspection.metadata.title } }, { onSuccess: (spec) => { create.mutate({ data: { ...spec, outputContainer: spec.outputContainer as 'mp4' | 'mkv' | 'webm' } }, { onSuccess: (job) => { setCreated(job); setNotice('Download prepared and persisted. It has not started.'); queryClient.invalidateQueries({ queryKey: getGetDownloadsQueryKey() }); }, onError: (error) => setNotice(`Preparation passed, but job creation failed: ${errorText(error)}`) }); }, onError: (error) => setNotice(`The backend rejected this download: ${errorText(error)}`) }); };
  return <><PageIntro eyebrow="INGEST / SOURCE INSPECTION" title="Inspect a source" description="Turn one URL into a verified, observable local job. No download is implied until the node confirms each step." /><div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_330px]"><section className="archive-panel p-5 md:p-7"><form onSubmit={runInspect} data-testid="form-source-inspection"><label className="archive-mono mb-2 block text-[10px] tracking-[.14em] text-[#6e8185]" htmlFor="source-url">MEDIA URL</label><div className="flex items-center border border-[#cbd8d5] bg-[#fbfcfa] focus-within:border-[#4e9690]"><Link2 size={16} className="ml-3 shrink-0 text-[#8a9b9e]" /><input id="source-url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…" className="w-full bg-transparent px-3 py-3.5 text-[13px] outline-none placeholder:text-[#aab5b5]" data-testid="input-source-url" /><button type="submit" disabled={inspect.isPending} className="mr-1 inline-flex shrink-0 items-center gap-2 bg-[#1d2b38] px-4 py-2.5 text-[10px] font-bold tracking-[.1em] text-[#f5f6f3] disabled:opacity-50" data-testid="button-inspect-source">{inspect.isPending ? <RefreshCw size={13} className="animate-spin" /> : <Search size={13} />}{inspect.isPending ? 'READING' : 'INSPECT'}</button></div></form>{notice && <div className={`mt-4 flex gap-2 border-l-2 p-3 text-[11px] leading-5 ${notice.includes('failed') || notice.includes('rejected') || notice.includes('Paste') || notice.includes('accept') || notice.includes('could not') ? 'border-[#c85b51] bg-[#fcedea] text-[#994b43]' : 'border-[#4e9690] bg-[#eaf3ef] text-[#39736e]'}`} data-testid="status-source-operation"><Activity size={14} className="mt-0.5 shrink-0" />{notice}</div>}{inspect.isPending && <div className="mt-7 space-y-3"><Skeleton className="h-6 w-2/3" /><Skeleton className="h-4 w-1/3" /><Skeleton className="h-24" /></div>}{inspection && <InspectionResult inspection={inspection} selected={selected} setSelected={setSelected} onPrepare={prepareDownload} pending={prepare.isPending || create.isPending} created={created} onStart={() => created && start.mutate({ id: created.id }, { onSuccess: (job) => { setCreated(job); setNotice('Job started. Progress will be proven by the queue.'); queryClient.invalidateQueries({ queryKey: getGetDownloadsQueryKey() }); queryClient.invalidateQueries({ queryKey: getGetSystemOverviewQueryKey() }); }, onError: (error) => setNotice(errorText(error)) })} />}</section><aside className="archive-panel h-fit p-5 md:p-6"><div className="archive-mono text-[10px] tracking-[.14em] text-[#7f9194]">OPERATOR CONTRACT</div><h2 className="archive-display mt-1 text-lg font-extrabold">What will happen</h2><div className="mt-5 space-y-4 text-[12px]"><Readout label="1 / inspect" value="BACKEND VERIFIED" tone="good" /><Readout label="2 / prepare" value="DESTINATION CHECK" tone="neutral" /><Readout label="3 / create" value="PERSISTED JOB" tone="neutral" /><Readout label="4 / start" value="OPERATOR ACTION" tone="warn" /></div><div className="mt-6 border-l-2 border-[#f4b942] bg-[#fff8e7] p-3 text-[11px] leading-5 text-[#80652e]">A successful inspection is metadata only. The archive path is not touched until a job is started.</div></aside></div></>;
}
function InspectionResult({ inspection, selected, setSelected, onPrepare, pending, created, onStart }: { inspection: MediaInspection; selected: string; setSelected: (value: string) => void; onPrepare: () => void; pending: boolean; created: DownloadJob | null; onStart: () => void }) {
  const meta = inspection.metadata; const formats = inspection.formats.filter((format) => format.usable); const recommended = formats.find((format) => format.formatId === inspection.recommendedFormatId);
  return <div className="mt-7 border-t border-[#e3e8e7] pt-6" data-testid="panel-inspection-result"><div className="flex flex-col gap-5 sm:flex-row">{meta.thumbnailUrl ? <img src={meta.thumbnailUrl} alt="" className="h-28 w-48 shrink-0 object-cover" data-testid="img-source-thumbnail" /> : <div className="grid h-28 w-48 shrink-0 place-items-center bg-[#e8efed] text-[#4e9690]"><FileCheck2 size={28} /></div>}<div className="min-w-0"><div className="archive-mono text-[9px] tracking-[.13em] text-[#7f9194]">{meta.extractor ?? 'SOURCE'} {inspection.demoMode ? '/ DEMO' : '/ VERIFIED'}</div><h2 className="archive-display mt-1 text-2xl font-extrabold leading-tight text-[#263844]" data-testid="text-inspection-title">{meta.title}</h2><div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[#77888c]"><span>{meta.uploader ?? meta.channel ?? 'Uploader not returned'}</span><span>{formatDuration(meta.durationSeconds)}</span><span>{meta.uploadDate ?? 'Date unknown'}</span></div></div></div><div className="mt-6 border-l-2 border-[#4e9690] bg-[#eaf3ef] p-4"><div className="archive-mono text-[9px] tracking-[.12em] text-[#39736e]">RECOMMENDATION / {recommended?.formatId ?? 'NONE'}</div><p className="mt-1 text-[12px] leading-5 text-[#45665f]" data-testid="text-recommendation">{inspection.recommendationExplanation}</p></div><div className="mt-6"><div className="mb-3 flex items-center justify-between"><div><div className="archive-mono text-[10px] tracking-[.12em] text-[#7f9194]">NORMALIZED FORMATS</div><div className="mt-1 text-[11px] text-[#879599]">{formats.length} usable of {inspection.rawFormatCount} returned</div></div><span className="archive-mono text-[9px] text-[#a0aaaa]">SELECT ONE</span></div><div className="space-y-2">{formats.length ? formats.slice(0, 8).map((format) => <label key={format.formatId} className={`flex cursor-pointer items-center justify-between gap-3 border p-3 transition-colors ${selected === format.formatId ? 'border-[#4e9690] bg-[#eef6f2]' : 'border-[#e1e8e5] bg-white/50 hover:border-[#aabfba]'}`} data-testid={`row-format-${format.formatId}`}><span className="flex min-w-0 items-center gap-3"><input type="radio" name="format" value={format.formatId} checked={selected === format.formatId} onChange={() => setSelected(format.formatId)} className="accent-[#4e9690]" data-testid={`input-format-${format.formatId}`} /><span className="min-w-0"><span className="block text-[12px] font-semibold text-[#43545b]">{formatLabel(format)}</span><span className="archive-mono mt-1 block truncate text-[9px] text-[#97a3a4]">{format.videoCodec ?? 'audio'} + {format.audioCodec ?? 'no audio'} / {format.protocol ?? 'direct'} / score {format.score}</span></span></span><span className="archive-mono shrink-0 text-[10px] text-[#829197]">{formatBytes(format.filesize ?? format.estimatedFilesize)}</span></label>) : <div className="border border-dashed border-[#d7e1de] p-5 text-center text-[11px] text-[#89989a]">The backend returned no usable formats.</div>}</div></div><div className="mt-6 flex flex-wrap items-center gap-3"><button onClick={onPrepare} disabled={!selected || pending || Boolean(created)} className="inline-flex items-center gap-2 bg-[#1d2b38] px-4 py-3 text-[11px] font-bold tracking-[.1em] text-[#f5f6f3] disabled:cursor-not-allowed disabled:opacity-45" data-testid="button-prepare-download">{pending ? <RefreshCw size={14} className="animate-spin" /> : <ArrowDownToLine size={14} />}{created ? 'JOB PERSISTED' : pending ? 'PREPARING' : 'PREPARE DOWNLOAD'}</button>{created && <button onClick={onStart} disabled={pending || created.status !== 'queued'} className="inline-flex items-center gap-2 border border-[#4e9690] bg-[#eaf3ef] px-4 py-3 text-[11px] font-bold tracking-[.1em] text-[#39736e] disabled:opacity-50" data-testid="button-start-created-job"><Play size={14} /> START JOB</button>}{created && <span className="text-[11px] text-[#718287]">Job #{created.id} is waiting in the persistent queue.</span>}</div></div>;
}

function QueuePage() {
  const queryClient = useQueryClient(); const { data: jobs, isLoading, isError, refetch } = useGetDownloads(); const [notice, setNotice] = useState('');
  const start = useStartDownload(); const pause = usePauseDownload(); const resume = useResumeDownload(); const cancel = useCancelDownload(); const retry = useRetryDownload(); const remove = useDeleteDownload(); const inspect = useInspectMediaSource(); const create = useCreateDownload();
  useEffect(() => { const source = new EventSource('/api/downloads/events'); const invalidate = () => { queryClient.invalidateQueries({ queryKey: getGetDownloadsQueryKey() }); queryClient.invalidateQueries({ queryKey: getGetSystemOverviewQueryKey() }); }; ['message', 'download', 'job.created', 'job.updated', 'job.completed', 'job.finished'].forEach((eventName) => source.addEventListener(eventName, invalidate)); source.onerror = () => { queryClient.invalidateQueries({ queryKey: getGetDownloadsQueryKey() }); }; return () => source.close(); }, [queryClient]);
  const persist = (mutation: { mutate: (data: { id: number }, options: { onSuccess: () => void; onError: (error: unknown) => void }) => void }, id: number, message: string) => mutation.mutate({ id }, { onSuccess: () => { setNotice(message); queryClient.invalidateQueries({ queryKey: getGetDownloadsQueryKey() }); queryClient.invalidateQueries({ queryKey: getGetSystemOverviewQueryKey() }); }, onError: (error) => setNotice(errorText(error)) });
  const createDemo = () => { setNotice('Inspecting the demo source…'); inspect.mutate({ data: { url: 'https://demo.local/archive-assistant/sample', forceRefresh: true } }, { onSuccess: (source) => { const format = source.formats.find((item) => item.usable); if (!format) { setNotice('Demo source returned no usable format.'); return; } create.mutate({ data: { sourceUrl: source.metadata.webpageUrl, title: source.metadata.title, sourceSite: source.metadata.extractor, selectedFormatId: format.formatId, selectedVideoFormatId: source.recommendedVideoFormatId, selectedAudioFormatId: source.recommendedAudioFormatId, outputContainer: 'mkv', finalFilename: source.metadata.title } }, { onSuccess: (job) => { start.mutate({ id: job.id }, { onSuccess: () => { setNotice('Demo job created and started.'); queryClient.invalidateQueries({ queryKey: getGetDownloadsQueryKey() }); queryClient.invalidateQueries({ queryKey: getGetSystemOverviewQueryKey() }); }, onError: (error) => setNotice(`Demo job created, but start failed: ${errorText(error)}`) }); }, onError: (error) => setNotice(errorText(error)) }); }, onError: (error) => setNotice(`Demo inspection failed: ${errorText(error)}`) }); };
  const action = (job: DownloadJob, kind: 'start' | 'pause' | 'resume' | 'cancel' | 'retry' | 'delete') => { if (kind === 'delete') { if (window.confirm(`Delete job #${job.id}? This only removes the job record.`)) persist(remove, job.id, `Job #${job.id} deleted.`); return; } if (kind === 'start') persist(start, job.id, `Job #${job.id} started.`); if (kind === 'pause') persist(pause, job.id, `Job #${job.id} paused.`); if (kind === 'resume') persist(resume, job.id, `Job #${job.id} resumed.`); if (kind === 'cancel') persist(cancel, job.id, `Job #${job.id} cancelled.`); if (kind === 'retry') persist(retry, job.id, `Job #${job.id} queued for retry.`); };
  if (isLoading) return <><PageIntro eyebrow="INGEST / PERSISTENT QUEUE" title="Download queue" description="Reading durable jobs from the local node." /><div className="space-y-3"><Skeleton className="h-32" /><Skeleton className="h-32" /><Skeleton className="h-32" /></div></>;
  if (isError) return <ErrorState title="Queue read failed" message="The persistent job list could not be read. No local queue state is being invented." onRetry={() => refetch()} testId="button-retry-queue" />;
  return <><PageIntro eyebrow="INGEST / PERSISTENT QUEUE" title="Download queue" description="Jobs are durable records. Every status below is returned by the backend, not simulated in the browser." action={<button onClick={createDemo} disabled={inspect.isPending || create.isPending} className="inline-flex items-center gap-2 bg-[#f4b942] px-3.5 py-2.5 text-[10px] font-bold tracking-[.1em] text-[#1d2b38] disabled:opacity-50" data-testid="button-create-mock-job"><Plus size={14} /> CREATE DEMO JOB</button>} />{notice && <div className="mb-4 border-l-2 border-[#4e9690] bg-[#eaf3ef] p-3 text-[11px] text-[#39736e]" data-testid="status-queue-operation">{notice}</div>}<div className="mb-4 flex flex-wrap gap-2 archive-mono text-[9px] tracking-[.08em] text-[#7d8d90]"><span className="border border-[#d8e1de] bg-white/60 px-2 py-1">{jobs?.filter((job) => ['downloading', 'processing', 'verifying', 'moving'].includes(job.status)).length ?? 0} ACTIVE</span><span className="border border-[#d8e1de] bg-white/60 px-2 py-1">{jobs?.filter((job) => job.status === 'queued').length ?? 0} QUEUED</span><span className="border border-[#d8e1de] bg-white/60 px-2 py-1">{jobs?.length ?? 0} TOTAL</span></div>{jobs?.length ? <div className="space-y-3">{jobs.map((job) => <QueueRow key={job.id} job={job} onAction={action} />)}</div> : <div className="archive-panel flex min-h-[330px] flex-col items-center justify-center p-8 text-center"><Download size={28} className="mb-4 text-[#4e9690]" /><h2 className="archive-display text-2xl font-extrabold">Queue is clear</h2><p className="mt-2 max-w-sm text-[13px] leading-6 text-[#7d8c8f]">No persistent jobs are waiting. Inspect a source or create a demo job to exercise the pipeline.</p></div>}</>;
}
function QueueRow({ job, onAction }: { job: DownloadJob; onAction: (job: DownloadJob, kind: 'start' | 'pause' | 'resume' | 'cancel' | 'retry' | 'delete') => void }) {
  const active = ['downloading', 'processing', 'verifying', 'moving', 'inspecting'].includes(job.status); const canStart = job.status === 'queued'; const canPause = ['downloading', 'processing'].includes(job.status); const canResume = job.status === 'paused'; const canCancel = ['queued', 'inspecting', 'downloading', 'processing', 'verifying', 'moving', 'paused'].includes(job.status); const canRetry = ['failed', 'recovery_required'].includes(job.status);
  return <article className="archive-panel p-4 md:p-5" data-testid={`row-download-${job.id}`}><div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><StatusPill status={job.status} /><span className="archive-mono text-[9px] text-[#9aa6a7]">JOB {job.id}</span>{job.verification === 'passed' && <span className="inline-flex items-center gap-1 text-[9px] font-bold tracking-[.08em] text-[#39736e]"><ShieldCheck size={12} /> VERIFIED</span>}</div><h2 className="mt-2 truncate text-[15px] font-bold text-[#344851]" title={job.title} data-testid={`text-download-title-${job.id}`}>{job.title}</h2><div className="mt-1 truncate text-[10px] text-[#8a989a]" title={job.sourceUrl}>{job.sourceSite ?? 'source'} / {job.finalFilename}</div></div><div className="flex flex-wrap gap-2">{canStart && <JobButton icon={Play} label="START" onClick={() => onAction(job, 'start')} testId={`button-start-download-${job.id}`} />}{canPause && <JobButton icon={Pause} label="PAUSE" onClick={() => onAction(job, 'pause')} testId={`button-pause-download-${job.id}`} />}{canResume && <JobButton icon={Play} label="RESUME" onClick={() => onAction(job, 'resume')} testId={`button-resume-download-${job.id}`} />}{canCancel && <JobButton icon={Square} label="CANCEL" onClick={() => onAction(job, 'cancel')} testId={`button-cancel-download-${job.id}`} />}{canRetry && <JobButton icon={RotateCcw} label="RETRY" onClick={() => onAction(job, 'retry')} testId={`button-retry-download-${job.id}`} />}{!active && <JobButton icon={Trash2} label="DELETE" onClick={() => onAction(job, 'delete')} testId={`button-delete-download-${job.id}`} danger />}</div></div><div className="mt-5 grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end"><div><div className="mb-2 flex justify-between text-[10px] text-[#7f8e91]"><span>{job.currentPhase || statusText(job.status)}</span><span className="archive-mono text-[#4e9690]">{Math.round(job.progress)}%</span></div><div className="h-2 bg-[#e5ece9]"><div className={`h-full origin-left transition-transform duration-500 ${active ? 'bg-[#f4b942]' : job.status === 'complete' ? 'bg-[#4e9690]' : job.status === 'failed' ? 'bg-[#c85b51]' : 'bg-[#9eadae]'}`} style={{ transform: `scaleX(${Math.min(1, Math.max(0, job.progress / 100))})` }} /></div></div><div className="grid grid-cols-2 gap-x-6 gap-y-1 text-right text-[10px] text-[#879598]"><span>{formatBytes(job.downloadedBytes)} / {formatBytes(job.totalBytes)}</span><span>{job.downloadSpeed ? `${formatBytes(job.downloadSpeed)}/s` : 'speed —'}</span><span>{job.etaSeconds ? `${job.etaSeconds}s remaining` : 'ETA —'}</span><span>{formatTime(job.createdAt)}</span></div></div>{job.errorMessage && <div className="mt-4 border-l-2 border-[#c85b51] bg-[#fcedea] p-3 text-[11px] leading-5 text-[#994b43]" data-testid={`text-download-error-${job.id}`}>{job.errorMessage}</div>}</article>;
}
function JobButton({ icon: Icon, label, onClick, testId, danger = false }: { icon: typeof Play; label: string; onClick: () => void; testId: string; danger?: boolean }) {
  return <button onClick={onClick} className={`inline-flex items-center gap-1.5 border px-2.5 py-2 text-[9px] font-bold tracking-[.08em] ${danger ? 'border-[#efd3cf] text-[#a34d45] hover:bg-[#fcedea]' : 'border-[#d7e1de] bg-white/70 text-[#607379] hover:border-[#8fb3ac] hover:text-[#39736e]'}`} data-testid={testId}><Icon size={12} />{label}</button>;
}

function HistoryPage() {
  const { data: jobs, isLoading: jobsLoading, isError: jobsError, refetch } = useGetDownloads(); const { data: events, isLoading: eventsLoading } = useGetSystemEvents(); const [tab, setTab] = useState<'jobs' | 'events'>('jobs');
  const history = jobs?.filter((job) => ['complete', 'failed', 'cancelled', 'recovery_required'].includes(job.status)) ?? [];
  if (jobsLoading) return <><PageIntro eyebrow="AUDIT / HISTORY" title="History" description="Loading completed work and operator signals." /><Skeleton className="h-[420px]" /></>;
  if (jobsError) return <ErrorState title="History read failed" message="Completed work could not be read from the local node." onRetry={() => refetch()} testId="button-retry-history" />;
  return <><PageIntro eyebrow="AUDIT / HISTORY" title="History" description="A factual record of completed, failed, cancelled jobs and system events." action={<div className="flex border border-[#d7e1de] bg-white/50 p-1"><button onClick={() => setTab('jobs')} className={`px-3 py-2 text-[10px] font-bold tracking-[.1em] ${tab === 'jobs' ? 'bg-[#1d2b38] text-[#f5f6f3]' : 'text-[#6c7d81]'}`} data-testid="button-history-jobs">JOBS</button><button onClick={() => setTab('events')} className={`px-3 py-2 text-[10px] font-bold tracking-[.1em] ${tab === 'events' ? 'bg-[#1d2b38] text-[#f5f6f3]' : 'text-[#6c7d81]'}`} data-testid="button-history-events">EVENTS</button></div>} />{tab === 'jobs' ? <section className="archive-panel overflow-hidden" data-testid="panel-download-history">{history.length ? <div className="divide-y divide-[#e3e8e7]">{history.map((job) => <div key={job.id} className="grid gap-3 p-4 md:grid-cols-[1fr_140px_150px] md:items-center md:px-5"><div className="min-w-0"><div className="truncate text-[12px] font-semibold text-[#43545b]">{job.title}</div><div className="mt-1 truncate text-[10px] text-[#8b999c]">{job.finalPath ?? job.finalFilename}</div></div><StatusPill status={job.status} /><div className="archive-mono text-[10px] text-[#8b999c]">{formatTime(job.completedAt ?? job.createdAt)}</div></div>)}</div> : <div className="flex min-h-[280px] flex-col items-center justify-center p-8 text-center"><FileCheck2 size={25} className="mb-3 text-[#9aa9aa]" /><h2 className="archive-display text-xl font-extrabold">No terminal jobs yet</h2><p className="mt-2 text-[12px] text-[#829095]">Verified and failed outcomes will remain visible here.</p></div>}</section> : <section className="archive-panel p-5 md:p-6" data-testid="panel-event-history">{eventsLoading ? <div className="space-y-3"><Skeleton className="h-10" /><Skeleton className="h-10" /></div> : <ActivityRows events={events} emptyLabel="The event stream is currently empty." />}</section>}</>;
}

const placeholderCopy: Record<string, { title: string; description: string; icon: typeof Activity; eyebrow: string }> = { ASSISTANT: { eyebrow: 'WORKSPACE / RESERVED', title: 'Assistant console', description: 'Reserved for collection-aware questions and guided actions.', icon: Bot }, ARCHIVE: { eyebrow: 'WORKSPACE / RESERVED', title: 'Archive browser', description: 'Reserved for a searchable browser of verified media.', icon: Archive } };
function PlaceholderPage({ section }: { section: keyof typeof placeholderCopy }) { const copy = placeholderCopy[section]; const Icon = copy.icon; return <><PageIntro eyebrow={copy.eyebrow} title={copy.title} description={copy.description} /><div className="archive-panel relative flex min-h-[420px] flex-col items-center justify-center overflow-hidden p-8 text-center"><div className="absolute left-0 top-0 h-1 w-24 bg-[#f4b942]" /><div className="absolute right-8 top-8 archive-mono text-[9px] tracking-[.16em] text-[#a2adae]">RESERVED / NO CLAIMS</div><div className="grid h-16 w-16 place-items-center border border-[#d6dfdc] bg-[#eaf0ed] text-[#4e9690]"><Icon size={27} strokeWidth={1.4} /></div><h2 className="archive-display mt-6 text-[25px] font-extrabold text-[#2b3d46]">Surface is reserved</h2><p className="mt-2 max-w-md text-[13px] leading-6 text-[#7c8a8d]">This workspace is intentionally honest about its current state. No records or capabilities are fabricated in this preview.</p><div className="mt-7 flex items-center gap-2 border border-[#e1e7e5] bg-[#f8faf8] px-3 py-2 archive-mono text-[9px] tracking-[.1em] text-[#799094]"><CircleHelp size={13} /> SAFE TO EXPLORE</div></div></>; }

function PlexPage() {
  const queryClient = useQueryClient();
  const previousSyncStatus = useRef<string | undefined>(undefined);
  const { data, isLoading, isError, refetch } = useGetPlexConfig();
  const { data: inventory, isLoading: inventoryLoading } = useGetPlexInventory({
    query: {
      enabled: Boolean(data && (data.libraryCount > 0 || data.status === 'synced')),
      queryKey: getGetPlexInventoryQueryKey()
    }
  });

  const mutation = useUpdatePlexConfig();
  const testConn = useTestPlexConnection();
  const startSync = useStartPlexSync();

  const [serverUrl, setServerUrl] = useState('');
  const [token, setToken] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => { if (data) setServerUrl(data.serverUrl ?? ''); }, [data]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval>;
    if (data?.syncStatus === 'syncing') {
      timer = setInterval(() => refetch(), 2000);
    }
    return () => clearInterval(timer);
  }, [data?.syncStatus, refetch]);

  useEffect(() => {
    if (previousSyncStatus.current === 'syncing' && data?.syncStatus !== 'syncing') {
      queryClient.invalidateQueries({ queryKey: getGetPlexInventoryQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetSystemEventsQueryKey() });
    }
    previousSyncStatus.current = data?.syncStatus;
  }, [data?.syncStatus, queryClient]);

  const save = () => {
    setNotice('');
    mutation.mutate({ data: { serverUrl, ...(token ? { token } : {}) } }, {
      onSuccess: (result) => {
        setToken('');
        setNotice('Configuration saved. Connection remains unverified until the next local check.');
        queryClient.setQueryData(getGetPlexConfigQueryKey(), result);
      },
      onError: (err) => setNotice(`Configuration could not be saved: ${errorText(err)}`)
    });
  };

  const handleTestConnection = () => {
    setNotice('');
    testConn.mutate(undefined, {
      onSuccess: (result) => {
        queryClient.setQueryData(getGetPlexConfigQueryKey(), result);
        setNotice(result.connectionStatus === 'connection_failed'
          ? result.lastError ?? 'Connection verification failed.'
          : 'Connection verified successfully.');
      },
      onError: (err) => {
        setNotice(`Connection verification failed: ${errorText(err)}`);
      }
    });
  };

  const handleStartSync = () => {
    setNotice('');
    startSync.mutate(undefined, {
      onSuccess: (result) => {
        setNotice('Sync triggered. The local node will pull the inventory.');
        queryClient.setQueryData(getGetPlexConfigQueryKey(), result);
      },
      onError: (err) => {
        setNotice(`Could not start sync: ${errorText(err)}`);
      }
    });
  };

  if (isLoading) return <><PageIntro eyebrow="INTEGRATION / PLEX" title="Plex configuration" description="Read the local connection settings without implying a live connection." /><Skeleton className="h-[390px]" /></>;
  if (isError || !data) return <ErrorState title="Plex status unavailable" message="Configuration could not be read from the local node." onRetry={() => refetch()} testId="button-retry-plex" />;

  const isConfigured = data.configured;
  const isConnected = data.connectionStatus === 'connected';
  const isSyncing = data.syncStatus === 'syncing';
  const isSynced = data.syncStatus === 'synced';
  const canSync = isConnected;
  const showInventory = isSynced || isSyncing || data.libraryCount > 0;

  return <><PageIntro eyebrow="INTEGRATION / PLEX" title="Plex inventory" description="Verify the configured server, synchronize its libraries, and inspect only inventory proven by the local node." action={<StatusPill status={data.configured ? data.status : 'not_configured'} label={data.configured ? statusText(data.status) : 'NOT CONFIGURED'} />} /><div className="grid gap-5 xl:grid-cols-[1fr_330px]"><form className="archive-panel p-5 md:p-7" data-testid="panel-plex-form" onSubmit={(event) => { event.preventDefault(); save(); }}><div className="mb-7 flex items-start gap-3 border-b border-[#e3e8e7] pb-5"><div className="grid h-9 w-9 place-items-center bg-[#fff0c9] text-[#a77517]"><PlaySquare size={18} /></div><div><h2 className="archive-display text-lg font-extrabold">Server endpoint</h2><p className="mt-1 text-[11px] text-[#859296]">Credentials stay on the local API</p></div></div><label className="mb-5 block"><span className="archive-mono mb-2 block text-[10px] tracking-[.1em] text-[#6e8185]">SERVER URL</span><div className="flex items-center border border-[#d6dfdc] bg-[#fbfcfa] focus-within:border-[#4e9690]"><Link2 size={15} className="ml-3 text-[#8a9b9e]" /><input autoComplete="url" value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="http://localhost:32400" className="w-full bg-transparent px-3 py-3 text-[13px] outline-none" data-testid="input-plex-server-url" /></div></label><label className="block"><span className="archive-mono mb-2 block text-[10px] tracking-[.1em] text-[#6e8185]">PLEX TOKEN <span className="text-[#a7b0b0]">/ OPTIONAL UPDATE</span></span><input autoComplete="current-password" type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder={data.hasToken ? 'Token is stored — enter to replace' : 'Paste token when ready'} className="w-full border border-[#d6dfdc] bg-[#fbfcfa] px-3 py-3 text-[13px] outline-none focus:border-[#4e9690]" data-testid="input-plex-token" /></label><div className="mt-7 flex flex-wrap items-center gap-3"><button type="submit" disabled={mutation.isPending || isSyncing} className="inline-flex items-center gap-2 bg-[#1d2b38] px-4 py-3 text-[11px] font-bold tracking-[.1em] text-[#f5f6f3] disabled:opacity-50" data-testid="button-save-plex">{mutation.isPending ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />} {mutation.isPending ? 'SAVING' : 'SAVE CONFIGURATION'}</button>{notice && <span className={`text-[11px] ${notice.includes('failed') || notice.includes('could not') ? 'text-[#c85b51]' : 'text-[#39736e]'}`} data-testid="status-plex-save">{notice}</span>}</div></form><section className="archive-panel h-fit p-5 md:p-6 flex flex-col gap-4" data-testid="panel-plex-status"><div className="archive-mono text-[10px] tracking-[.14em] text-[#7f9194]">NODE CONNECTION</div><h2 className="archive-display text-lg font-extrabold -mt-3">State & Actions</h2><div className="space-y-4 text-[12px]"><Readout label="Endpoint stored" value={data.configured ? 'YES' : 'NO'} tone={data.configured ? 'good' : 'warn'} /><Readout label="Token present" value={data.hasToken ? 'YES' : 'NO'} tone={data.hasToken ? 'good' : 'warn'} /><Readout label="Connection" value={statusText(data.connectionStatus)} tone={data.connectionStatus === 'connection_failed' ? 'warn' : isConnected ? 'good' : 'neutral'} /><Readout label="Synchronization" value={statusText(data.syncStatus)} tone={data.syncStatus === 'sync_error' ? 'warn' : isSynced ? 'good' : 'neutral'} /><Readout label="Libraries" value={String(data.libraryCount)} tone={data.libraryCount ? 'good' : 'neutral'} /><Readout label="Items / media" value={`${data.itemCount} / ${data.mediaCount}`} tone={data.itemCount ? 'good' : 'neutral'} /><Readout label="Last attempted" value={formatTime(data.lastAttemptedAt)} /><Readout label="Last successful" value={formatTime(data.lastSuccessfulSyncAt)} tone={data.lastSuccessfulSyncAt ? 'good' : 'neutral'} /></div><div className="mt-2 flex flex-col gap-2"><button type="button" onClick={handleTestConnection} disabled={!data.configured || testConn.isPending || isSyncing} className="inline-flex justify-center items-center gap-2 border border-[#d6dfdc] bg-white/50 px-4 py-2 text-[10px] font-bold tracking-[.1em] text-[#53656b] disabled:opacity-50 hover:bg-[#eaf0ed] transition-colors" data-testid="button-test-connection">{testConn.isPending ? <RefreshCw size={13} className="animate-spin" /> : <Network size={13} />}{testConn.isPending ? 'VERIFYING' : 'TEST CONNECTION'}</button><button type="button" onClick={handleStartSync} disabled={!canSync || startSync.isPending || isSyncing} className="inline-flex justify-center items-center gap-2 border border-[#4e9690] bg-[#eaf3ef] px-4 py-2 text-[10px] font-bold tracking-[.1em] text-[#39736e] disabled:opacity-50 hover:bg-[#dcebe7] transition-colors" data-testid="button-start-sync">{isSyncing || startSync.isPending ? <RefreshCw size={13} className="animate-spin" /> : <Download size={13} />}{isSyncing ? 'SYNCING INVENTORY' : startSync.isPending ? 'STARTING SYNC' : 'SYNC INVENTORY'}</button></div>{data.lastError && <div className="mt-2 border-l-2 border-[#c85b51] bg-[#fcedea] p-3 text-[11px] leading-5 text-[#994b43]" data-testid="text-plex-error">{data.lastError}</div>}</section></div>{showInventory && <section className="mt-7 archive-panel p-5 md:p-7" data-testid="panel-plex-inventory"><div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><div className="archive-mono text-[10px] tracking-[.14em] text-[#7f9194]">LOCAL INVENTORY</div><h2 className="archive-display mt-1 text-2xl font-extrabold text-[#263844]">Synchronized Libraries</h2></div>{data.lastSuccessfulSyncAt && <div className="text-left sm:text-right"><div className="archive-mono text-[10px] tracking-[.12em] text-[#7f9194]">LAST SYNC</div><div className="mt-1 text-[12px] font-semibold text-[#4e9690]">{formatTime(data.lastSuccessfulSyncAt)}</div></div>}</div>{inventoryLoading && !inventory ? <div className="space-y-4"><Skeleton className="h-20" /><Skeleton className="h-20" /></div> : inventory?.libraries?.length ? <div className="space-y-6">{inventory.libraries.map(library => <div key={library.id} className="border border-[#e3e8e7] bg-[#fbfcfa]" data-testid={`library-${library.id}`}><div className="flex items-center justify-between border-b border-[#e3e8e7] bg-[#f3f5f4] px-4 py-3"><div className="flex items-center gap-3"><Library size={16} className="text-[#4e9690]" /><h3 className="text-[13px] font-bold text-[#344851]">{library.name}</h3><span className="archive-mono rounded-sm bg-[#e3e8e7] px-2 py-0.5 text-[9px] tracking-[.1em] text-[#65767a]">{library.type.toUpperCase()}</span></div><div className="archive-mono text-[10px] text-[#7f9194]">{library.itemCount} ITEMS</div></div><div className="grid gap-3 p-4 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">{inventory.items.filter(item => item.libraryId === library.id).slice(0, 8).map(item => <div key={item.id} className="flex gap-3 border border-[#f0f4f3] bg-white p-3 transition-colors hover:border-[#d6dfdc]" data-testid={`inventory-item-${item.id}`}><div className="grid h-12 w-12 shrink-0 place-items-center bg-[#e8efed] text-[#8ca3a0]">{item.itemType === 'movie' ? <PlaySquare size={16} /> : <FolderOpen size={16} />}</div><div className="min-w-0 flex-1"><div className="truncate text-[12px] font-bold text-[#344851]" title={item.title}>{item.title}</div><div className="mt-1 text-[10px] text-[#7f9194]">{item.year ? `${item.year} • ` : ''}{item.itemType}</div><div className="archive-mono mt-1 text-[9px] text-[#a0afaf]">{item.mediaCount} MEDIA / {item.partCount} PARTS</div></div></div>)}{inventory.items.filter(item => item.libraryId === library.id).length > 8 && <div className="flex items-center justify-center border border-dashed border-[#d6dfdc] bg-[#f8faf8] p-3 text-[11px] font-semibold text-[#8ca3a0]">+ {inventory.items.filter(item => item.libraryId === library.id).length - 8} MORE</div>}{inventory.items.filter(item => item.libraryId === library.id).length === 0 && <div className="col-span-full py-4 text-center text-[11px] text-[#8ca3a0]">No items populated in this library.</div>}</div></div>)}</div> : !isSyncing && <div className="flex flex-col items-center justify-center border border-dashed border-[#d6dfdc] bg-[#f8faf8] p-8 text-center text-[#7f9194]"><Library size={24} className="mb-3 text-[#a0afaf]" /><div className="text-[12px] font-semibold">No libraries found</div><div className="mt-1 text-[11px]">The synchronized inventory is empty.</div></div>}</section>}</>;
}


function EmptyState({ icon: Icon, title, description }: { icon: typeof Activity; title: string; description: string }) {
  return (
    <div className="flex min-h-[250px] flex-col items-center justify-center text-center">
      <Icon size={24} className="mb-3 text-[#a0afaf]" />
      <div className="text-[13px] font-bold text-[#344851]">{title}</div>
      <div className="mt-1 text-[11px] text-[#8a9b9e]">{description}</div>
    </div>
  );
}

type FindingRecord = {
  qualityStatus: string;
  qualitySummary: string;
  qualityDifferences: string[];
  duplicateOfId: number | null;
  plexMatch: { title: string; year: number | null; qualityDifferences: string[] } | null;
  reviewStatus: string;
};

function qualityReviewSeverity(
  differences: string[],
): 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO' {
  if (differences.includes('resolution') || differences.includes('dynamic_range')) {
    return 'HIGH';
  }

  if (differences.includes('video_codec') || differences.includes('audio_codec')) {
    return 'MEDIUM';
  }

  if (differences.length > 0) {
    return 'LOW';
  }

  return 'INFO';
}

function explainFinding(record: FindingRecord) {
  const differences = record.plexMatch?.qualityDifferences.length
    ? record.plexMatch.qualityDifferences
    : record.qualityDifferences;
  let finding: string;
  let why: string;
  let consider: string;
  let assessment: string;

  if (record.qualityStatus === 'file_missing') {
    finding = 'This file is known to the archive but was not present during the latest completed scan.';
    why = 'The local path may have changed, the storage may be unavailable, or the file may have been removed.';
    consider = 'Check the recorded path and storage before deciding whether the archive record should remain.';
    assessment = 'INVESTIGATE';
  } else if (record.qualityStatus === 'duplicate' || record.duplicateOfId !== null) {
    finding = record.duplicateOfId !== null
      ? `This record is linked as a duplicate of archive record #${record.duplicateOfId}.`
      : 'The system found another local record with matching media evidence.';
    why = 'Duplicate records can represent redundant storage or multiple copies that need an operator decision.';
    consider = 'Compare the linked records and keep the copy that best fits your storage and library needs.';
    assessment = 'REVIEW';
  } else if (record.plexMatch && differences.length > 0) {
    const severity = qualityReviewSeverity(differences);
    finding = `LOCAL is matched to PLEX item "${record.plexMatch.title}"${record.plexMatch.year ? ` (${record.plexMatch.year})` : ''}, with quality differences already reported by the system.`;
    if (severity === 'HIGH') {
      why = 'A high-impact visual or dynamic-range difference exists between LOCAL and PLEX.';
    } else if (severity === 'MEDIUM') {
      why = 'A codec difference exists between LOCAL and PLEX and may affect compatibility or playback characteristics.';
    } else {
      why = 'The reported differences are limited to lower-impact technical metadata.';
    }
    consider = `Review the supplied LOCAL / PLEX differences: ${differences.join('; ')}`;
    assessment = `${severity} / REVIEW`;
  } else if (record.qualityStatus === 'higher_quality_available') {
    finding = 'A higher-quality local version is available for this media identity.';
    why = record.qualitySummary || 'Another local version has a higher quality ranking.';
    consider = 'Compare versions before deciding whether this record should remain in active use.';
    assessment = 'REVIEW';
  } else if (record.qualityStatus === 'lower_quality_version') {
    finding = 'This is a lower-quality local version of an identity with another available version.';
    why = record.qualitySummary || 'Another local version ranks higher for the same identity.';
    consider = 'Review the higher-ranked version and decide whether this copy is still needed.';
    assessment = 'REVIEW';
  } else if (record.qualityStatus === 'needs_review') {
    finding = 'The system could not establish a reliable quality result for this record.';
    why = record.qualitySummary || 'The record needs operator attention.';
    consider = 'Inspect the file and metadata before making a library decision.';
    assessment = 'INVESTIGATE';
  } else if (record.qualityStatus === 'local_only') {
    finding = 'This local file exists in the archive, but no Plex identity match was found.';
    why = 'Identity matching may be unresolved; this does not establish that Plex is missing the media globally.';
    consider = 'Review the filename, path, and Plex inventory before deciding whether further matching work is needed.';
    assessment = 'REVIEW';
  } else {
    finding = 'The system found no active quality finding for this record.';
    why = record.qualitySummary || 'The record is informational at this time.';
    consider = 'No action is required unless the surrounding library context suggests otherwise.';
    assessment = 'INFORMATIONAL';
  }

  if (record.reviewStatus === 'unresolved') {
    consider = `${consider} This finding has not received a resolved operator decision yet.`;
  }

  return { finding, why, consider, assessment };
}
function reviewPriority(record: Pick<FindingRecord, 'qualityStatus' | 'duplicateOfId' | 'reviewStatus' | 'qualityDifferences' | 'plexMatch'>) {
  if (record.reviewStatus === 'reviewed') return 0;
  if (record.reviewStatus === 'deferred') return 25;
  if (record.reviewStatus === 'unresolved') return 100;

  if (record.qualityStatus === 'file_missing') return 100;
  if (record.qualityStatus === 'needs_review') return 90;
  if (record.qualityStatus === 'duplicate' || record.duplicateOfId !== null) return 80;

  const differences = record.plexMatch?.qualityDifferences.length
    ? record.plexMatch.qualityDifferences
    : record.qualityDifferences;

  const severity = qualityReviewSeverity(differences);
  if (severity === 'HIGH') return 70;
  if (severity === 'MEDIUM') return 55;
  if (severity === 'LOW') return 35;

  if (record.qualityStatus === 'local_only') return 60;

  return 10;
}

function reviewPriorityLabel(record: Pick<FindingRecord, 'qualityStatus' | 'duplicateOfId' | 'reviewStatus' | 'qualityDifferences' | 'plexMatch'>) {
  const priority = reviewPriority(record);

  if (priority >= 90) return 'HIGH';
  if (priority >= 60) return 'REVIEW';
  if (priority >= 25) return 'DEFERRED';
  return 'INFO';
}
function ArchiveRecordPanel({ id, onClose }: { id: number; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data: record, isLoading, isError, refetch } = useGetArchiveRecord(id);
  const updateReview = useUpdateArchiveRecordReview();
  const [reviewNote, setReviewNote] = useState('');
  const [reviewNotice, setReviewNotice] = useState('');

  useEffect(() => {
    setReviewNote(record?.reviewNote ?? '');
    setReviewNotice('');
  }, [record?.reviewNote, record?.reviewStatus, id]);

  const saveReview = (status: 'reviewed' | 'deferred' | 'unresolved') => {
    setReviewNotice('');
    updateReview.mutate({ id, data: { status, note: reviewNote.trim() || null } }, {
      onSuccess: () => {
        setReviewNotice(`Finding marked ${status}.`);
        queryClient.invalidateQueries({ queryKey: getGetArchiveRecordQueryKey(id) });
        queryClient.invalidateQueries({ queryKey: getGetArchiveInventoryQueryKey() });
      },
      onError: (error) => setReviewNotice(`Review could not be saved: ${errorText(error)}`)
    });
  };

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

      {(() => {
       const explanation = explainFinding(record);
       return (
         <section className="mb-6 border-l-2 border-[#4e9690] bg-[#eaf3ef] p-4 text-[11px] leading-5 text-[#43545b]" data-testid="panel-archive-finding">
           <div className="archive-mono mb-3 text-[10px] tracking-[.14em] text-[#39736e]">WHY THIS IS FLAGGED</div>
           <div className="space-y-2">
             <p><span className="font-bold text-[#344851]">FOUND / </span>{explanation.finding}</p>
             <p><span className="font-bold text-[#344851]">WHY IT MATTERS / </span>{explanation.why}</p>
             <p><span className="font-bold text-[#344851]">CONSIDER / </span>{explanation.consider}</p>
           </div>
           <div className="mt-4 border-t border-[#c9dfd9] pt-3" data-testid="panel-archive-assessment">
             <div className="archive-mono text-[9px] tracking-[.12em] text-[#6e8185]">SYSTEM ASSESSMENT</div>
             <div className="mt-1 font-bold tracking-[.08em] text-[#39736e]">{explanation.assessment}</div>
           </div>
         </section>
       );
      })()}

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

      <ArchiveQualityIntelligence recordId={id} />

      {record.reviewStatus !== 'not_applicable' && (
        <div className="mt-6 border-t border-[#e3e8e7] pt-5" data-testid="panel-archive-review">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="archive-mono text-[10px] tracking-[.14em] text-[#7f9194]">OPERATOR REVIEW</div>
            <span className={`archive-mono px-2 py-1 text-[9px] tracking-[.08em] ${record.reviewStatus === 'reviewed' ? 'bg-[#eaf3ef] text-[#39736e]' : record.reviewStatus === 'deferred' ? 'bg-[#fff0c9] text-[#8d681d]' : 'bg-[#fcedea] text-[#994b43]'}`}>
              {record.reviewStatus.replace(/_/g, ' ').toUpperCase()}
            </span>
          </div>
          <textarea
            value={reviewNote}
            onChange={(event) => setReviewNote(event.target.value)}
            maxLength={500}
            rows={3}
            placeholder="Optional note about this finding"
            className="w-full resize-y border border-[#d6dfdc] bg-[#fbfcfa] p-3 text-[11px] leading-5 text-[#43545b] outline-none placeholder:text-[#a0aaaa] focus:border-[#4e9690]"
            data-testid="input-archive-review-note"
          />
          <div className="mt-3 grid grid-cols-3 gap-2">
            <button type="button" onClick={() => saveReview('reviewed')} disabled={updateReview.isPending} className="inline-flex items-center justify-center gap-1.5 bg-[#39736e] px-2 py-2 text-[9px] font-bold tracking-[.06em] text-white disabled:opacity-50" data-testid="button-review-reviewed"><Check size={12} /> REVIEWED</button>
            <button type="button" onClick={() => saveReview('deferred')} disabled={updateReview.isPending} className="inline-flex items-center justify-center gap-1.5 border border-[#d9bd77] bg-[#fff8e7] px-2 py-2 text-[9px] font-bold tracking-[.06em] text-[#8d681d] disabled:opacity-50" data-testid="button-review-deferred"><Pause size={12} /> DEFER</button>
            <button type="button" onClick={() => saveReview('unresolved')} disabled={updateReview.isPending} className="inline-flex items-center justify-center gap-1.5 border border-[#e2b9b4] bg-[#fcedea] px-2 py-2 text-[9px] font-bold tracking-[.06em] text-[#994b43] disabled:opacity-50" data-testid="button-review-unresolved"><RotateCcw size={12} /> UNRESOLVED</button>
          </div>
          {record.reviewUpdatedAt && <div className="archive-mono mt-3 text-[9px] text-[#97a3a4]">UPDATED / {formatTime(record.reviewUpdatedAt)}</div>}
          {reviewNotice && <div className={`mt-3 text-[10px] ${reviewNotice.includes('could not') ? 'text-[#994b43]' : 'text-[#39736e]'}`} data-testid="status-archive-review">{reviewNotice}</div>}
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

const qualityRelationshipCopy: Record<string, string> = {
  exact_duplicate: 'Byte-identical copies',
  probable_duplicate: 'Probable duplicate',
  equivalent: 'Equivalent encodes',
  superior_encode: 'This copy dominates the others',
  inferior_encode: 'A better copy exists',
  materially_different_encode: 'Materially different encodes',
  different_media: 'Different cut or runtime',
  insufficient_metadata: 'Not enough metadata to compare',
};

const qualityConfidenceTone: Record<string, string> = {
  high: 'bg-[#eaf3ef] text-[#39736e]',
  medium: 'bg-[#fff0c9] text-[#8d681d]',
  low: 'bg-[#fcedea] text-[#994b43]',
};

/**
 * Read-only quality intelligence for one record: the normalized technical
 * model, the comparison that produced the finding, the reason, the confidence,
 * and the review state. Nothing here touches media; findings are reviewable.
 */
function ArchiveQualityIntelligence({ recordId }: { recordId: number }) {
  const queryClient = useQueryClient();
  const { data: report } = useGetArchiveQualityRecord(recordId);
  const reviewFinding = useUpdateArchiveQualityFindingReview();
  const [qualityNotice, setQualityNotice] = useState('');

  if (!report) return null;
  const finding = report.findings[0];
  const comparison = finding
    ? {
      counterpartLine: finding.counterpartLine ?? null,
      relationship: finding.relationship,
      winner: finding.winner,
      confidence: finding.confidence,
      reasons: finding.reasons,
      uncertainty: finding.uncertainty,
      axes: finding.axes,
    }
    : report.comparisons[0]
      ? {
        counterpartLine: `${report.comparisons[0].counterpart.label} - ${report.comparisons[0].counterpart.resolution}`,
        relationship: report.comparisons[0].relationship,
        winner: report.comparisons[0].winner,
        confidence: report.comparisons[0].confidence,
        reasons: report.comparisons[0].reasons,
        uncertainty: report.comparisons[0].uncertainty,
        axes: report.comparisons[0].axes,
      }
      : null;
  if (!comparison) return null;

  const markReviewed = (target: NonNullable<typeof finding>) => {
    setQualityNotice('');
    reviewFinding.mutate({
      data: {
        fileRecordId: target.fileRecordId,
        kind: target.kind,
        evidenceKey: target.evidenceKey,
        status: 'reviewed',
        note: `Reviewed from the archive panel: ${target.headline}.`,
      },
    }, {
      onSuccess: () => {
        setQualityNotice('Quality finding marked reviewed. Media was not changed.');
        queryClient.invalidateQueries({ queryKey: getGetArchiveQualityRecordQueryKey(recordId) });
        queryClient.invalidateQueries({ queryKey: getGetArchiveQualityFindingsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetArchiveInventoryQueryKey() });
      },
      onError: (error) => setQualityNotice(`Review could not be saved: ${errorText(error)}`),
    });
  };

  const notableAxes = comparison.axes.filter((axis) => axis.status !== 'equal');

  return (
    <div className="mt-6 border-t border-[#e3e8e7] pt-5" data-testid="panel-archive-quality">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="archive-mono text-[10px] tracking-[.14em] text-[#7f9194]">QUALITY INTELLIGENCE</div>
        {finding?.severity && (
          <span className={`archive-mono px-2 py-1 text-[9px] tracking-[.08em] ${qualityConfidenceTone[finding.severity] ?? 'bg-[#f1f4f3] text-[#5f7178]'}`}>
            {finding.kind.replace(/_/g, ' ').toUpperCase()}
          </span>
        )}
      </div>

      <div className="space-y-3 text-[11px] leading-5">
        <div>
          <div className="archive-mono text-[9px] tracking-[.12em] text-[#7f9194]">CURRENT QUALITY</div>
          <div className="mt-0.5 text-[#344851]">{report.currentQualityLine}</div>
        </div>
        <div>
          <div className="archive-mono text-[9px] tracking-[.12em] text-[#7f9194]">COMPARISON</div>
          <div className="mt-0.5 text-[#344851]">
            {qualityRelationshipCopy[comparison.relationship] ?? comparison.relationship.replace(/_/g, ' ')}
            {comparison.counterpartLine ? <span className="text-[#859296]"> / {comparison.counterpartLine}</span> : null}
          </div>
          {comparison.winner && (
            <div className="mt-1 text-[10px] text-[#43545b]">
              Preferred: <span className="font-bold text-[#39736e]">{comparison.winner === 'left' ? 'this record' : comparison.counterpartLine?.split(' - ')[0] ?? 'the other copy'}</span>
            </div>
          )}
        </div>
        <div>
          <div className="archive-mono text-[9px] tracking-[.12em] text-[#7f9194]">REASON</div>
          <ul className="mt-0.5 space-y-1.5">
            {comparison.reasons.slice(0, 4).map((reason, index) => (
              <li key={index} className="flex items-start gap-2 text-[#43545b]">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-[#4e9690]" />
                <span className="min-w-0 flex-1 break-words">{reason}</span>
              </li>
            ))}
          </ul>
        </div>
        {notableAxes.length > 0 && (
          <div className="space-y-1">
            {notableAxes.slice(0, 6).map((axis, index) => (
              <div key={`${axis.axis}-${index}`} className="archive-mono text-[9px] leading-4 text-[#859296]">
                {axis.materiality.toUpperCase()} / {axis.text}
                {axis.note ? <span className="text-[#a0aaaa]"> - {axis.note}</span> : null}
              </div>
            ))}
          </div>
        )}
        {comparison.uncertainty.length > 0 && (
          <div className="border-l-2 border-[#f4b942] bg-[#fff8e7] p-3 text-[10px] leading-4 text-[#80652e]">
            {comparison.uncertainty[0]}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <div className="archive-mono text-[9px] tracking-[.12em] text-[#7f9194]">CONFIDENCE</div>
          <span className={`archive-mono px-2 py-1 text-[9px] tracking-[.08em] ${qualityConfidenceTone[comparison.confidence ?? ''] ?? 'bg-[#f1f4f3] text-[#5f7178]'}`}>
            {(comparison.confidence ?? 'not scored').replace(/ /g, '_').toUpperCase()}
          </span>
          <div className="archive-mono text-[9px] tracking-[.12em] text-[#7f9194]">REVIEW STATUS</div>
          <span className={`archive-mono px-2 py-1 text-[9px] tracking-[.08em] ${finding?.reviewStatus === 'reviewed' ? 'bg-[#eaf3ef] text-[#39736e]' : 'bg-[#fff0c9] text-[#8d681d]'}`}>
            {(finding?.reviewStatus ?? 'unreviewed').replace(/_/g, ' ').toUpperCase()}
          </span>
        </div>
        {report.findings.length > 1 && (
          <div className="space-y-2 border-t border-[#eef2f0] pt-3">
            <div className="archive-mono text-[9px] tracking-[.12em] text-[#7f9194]">
              OTHER FINDINGS ON THIS RECORD ({report.findings.length - 1})
            </div>
            {report.findings.slice(1).map((other) => (
              <div key={other.key} className="flex items-start justify-between gap-2">
                <span className="min-w-0 flex-1 break-words text-[10px] text-[#5f7178]">
                  {other.kind.replace(/_/g, ' ')}
                  {other.confidence ? ` / ${other.confidence}` : ''} / {other.reviewStatus.replace(/_/g, ' ')}
                </span>
                {other.reviewStatus !== 'reviewed' && (
                  <button
                    type="button"
                    onClick={() => markReviewed(other)}
                    disabled={reviewFinding.isPending}
                    className="archive-mono shrink-0 border border-[#cbe0d9] bg-[#f4faf7] px-1.5 py-1 text-[8px] font-bold tracking-[.06em] text-[#39736e] disabled:opacity-50"
                    data-testid={`button-quality-review-${other.key.slice(0, 8)}`}
                  >
                    REVIEW
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {finding && finding.reviewStatus !== 'reviewed' && (
          <button
            type="button"
            onClick={() => markReviewed(finding)}
            disabled={reviewFinding.isPending}
            className="inline-flex items-center justify-center gap-1.5 border border-[#cbe0d9] bg-[#f4faf7] px-2 py-2 text-[9px] font-bold tracking-[.06em] text-[#39736e] disabled:opacity-50"
            data-testid="button-quality-review-reviewed"
          >
            <Check size={12} /> MARK FINDING REVIEWED
          </button>
        )}
        {qualityNotice && (
          <div className={`text-[10px] ${qualityNotice.includes('could not') ? 'text-[#994b43]' : 'text-[#39736e]'}`} data-testid="status-quality-review">
            {qualityNotice}
          </div>
        )}
      </div>
    </div>
  );
}

function ArchivePage() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState('');
  const [selectedRecordId, setSelectedRecordId] = useState<number | null>(null);
  const [selectedRecordIds, setSelectedRecordIds] = useState<number[]>([]);
  const [bulkNotice, setBulkNotice] = useState('');
  const [bulkFailures, setBulkFailures] = useState<Array<{ id: number; error: string }>>([]);
  const [namingNotice, setNamingNotice] = useState('');
  const [namingFailures, setNamingFailures] = useState<Array<{ id: number; error: string }>>([]);
  const { data: qualityFindings } = useGetArchiveQualityFindings({ pageSize: 1 });
  const [view, setView] = useState<'local' | 'naming_proposals' | 'plex_only'>('local');
  const [filter, setFilter] = useState<'all' | 'queue' | 'duplicates' | 'conflicts' | 'missing' | 'local_only' | 'reviewed' | 'unresolved'>('all');

  const [isScanning, setIsScanning] = useState(false);
  const { data: scan, isLoading: scanLoading, refetch: refetchScan } = useGetArchiveScan({
    query: {
      refetchInterval: isScanning ? 2000 : false,
      queryKey: getGetArchiveScanQueryKey()
    }
  });

  useEffect(() => {
    const wasScanning = isScanning;
    const nowScanning = scan?.status === 'scanning';
    setIsScanning(nowScanning);

    if (wasScanning && !nowScanning) {
      queryClient.invalidateQueries({ queryKey: getGetArchiveInventoryQueryKey() });
    }
  }, [scan?.status, isScanning, queryClient]);

  const { data: inventory, isLoading: invLoading, isError: invError, refetch: refetchInv } = useGetArchiveInventory({
    query: {
      refetchInterval: isScanning ? 3000 : false,
      queryKey: getGetArchiveInventoryQueryKey()
    }
  });

  const { data: namingProposals, isLoading: namingLoading, isError: namingError, refetch: refetchNaming } = useGetArchiveNamingProposals();
  const { data: archiveOperations } = useGetArchiveOperations({ limit: 50 }, { query: { enabled: view === 'naming_proposals', queryKey: getGetArchiveOperationsQueryKey({ limit: 50 }) } });

  const startScan = useStartArchiveScan();
  const namingDecisions = useUpdateArchiveNamingProposalDecisions();
  const namingApply = useApplyArchiveNamingProposals();
  const namingRollback = useRollbackArchiveOperation();

  const refreshNamingViews = () => {
    queryClient.invalidateQueries({ queryKey: getGetArchiveNamingProposalsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetArchiveOperationsQueryKey() });
  };
  const decideNamingProposal = (fileRecordId: number, status: 'accepted' | 'rejected' | 'deferred') => {
    setNamingNotice('');
    setNamingFailures([]);
    namingDecisions.mutate({ data: { decisions: [{ fileRecordId, status }] } }, {
      onSuccess: (result) => {
        const failure = result.results.find(item => !item.success);
        setNamingNotice(failure ? `Decision not saved: ${failure.error ?? 'unknown error'}` : `Proposal ${status}.`);
        refreshNamingViews();
      },
      onError: (error) => setNamingNotice(`Decision could not be saved: ${errorText(error)}`),
    });
  };
  const runNamingApply = (fileRecordIds: number[], dryRun: boolean) => {
    if (!fileRecordIds.length) return;
    setNamingNotice('');
    setNamingFailures([]);
    namingApply.mutate({ data: { fileRecordIds, dryRun } }, {
      onSuccess: (result) => {
        const failures = result.results.filter(item => !item.success);
        setNamingFailures(failures.map(item => ({ id: item.fileRecordId, error: item.error ?? 'The operation did not complete.' })));
        setNamingNotice(
          result.dryRun
            ? `DRY RUN / ${result.succeeded} ready to apply${result.failed ? `, ${result.failed} blocked` : ''}. Nothing was moved.`
            : `${result.succeeded} applied${result.failed ? `, ${result.failed} refused` : ''}. Every attempt is in the operations journal.`,
        );
        refreshNamingViews();
      },
      onError: (error) => setNamingNotice(`Apply failed: ${errorText(error)}`),
    });
  };
  const rollbackNamingOperation = (id: number) => {
    setNamingNotice('');
    setNamingFailures([]);
    namingRollback.mutate({ id }, {
      onSuccess: () => {
        setNamingNotice('Operation rolled back; the file is back at its original path.');
        refreshNamingViews();
      },
      onError: (error) => setNamingNotice(`Rollback refused: ${errorText(error)}`),
    });
  };
  const bulkReview = useUpdateArchiveRecordReviews();
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
 if (filter === 'queue') {
   displayedRecords = [...records]
     .filter(record => record.reviewStatus !== 'reviewed')
     .sort((a, b) => {
       const priorityDifference = reviewPriority(b) - reviewPriority(a);
       return priorityDifference !== 0 ? priorityDifference : a.id - b.id;
     });
 } else if (filter === 'duplicates') displayedRecords = records.filter(r => r.qualityStatus.includes('duplicate'));
  else if (filter === 'conflicts') displayedRecords = records.filter(r => ['higher_quality_available', 'lower_quality_version', 'needs_review'].includes(r.qualityStatus) || (r.qualityDifferences && r.qualityDifferences.length > 0));
  else if (filter === 'missing') displayedRecords = records.filter(r => r.scanStatus === 'missing' || r.qualityStatus === 'file_missing');
  else if (filter === 'local_only') displayedRecords = records.filter(r => r.qualityStatus === 'local_only');
  else if (filter === 'reviewed') displayedRecords = records.filter(r => r.reviewStatus === 'reviewed');
  else if (filter === 'unresolved') displayedRecords = records.filter(r => ['unreviewed', 'unresolved'].includes(r.reviewStatus));

  const plexOnly = inventory?.plexOnly ?? [];
  const showPlex = view === 'plex_only';
  const namingResults = namingProposals?.results ?? [];
  type ArchiveOperationEntry = NonNullable<typeof archiveOperations>[number];
  const operationsByRecord = new Map<number, ArchiveOperationEntry>();
  for (const operation of archiveOperations ?? []) {
    if (operation.fileRecordId != null && !operationsByRecord.has(operation.fileRecordId)) {
      operationsByRecord.set(operation.fileRecordId, operation);
    }
  }
  const acceptedActionableIds = namingResults
    .filter(proposal => proposal.decisionStatus === 'accepted' && proposal.proposedPath && proposal.operation !== 'uncertain/no_action')
    .map(proposal => proposal.fileRecordId);
  const selectableRecords = displayedRecords.filter(record => record.reviewStatus !== 'not_applicable');
  const selectedSet = new Set(selectedRecordIds);
  const allVisibleSelected = selectableRecords.length > 0 && selectableRecords.every(record => selectedSet.has(record.id));
  const toggleRecordSelection = (id: number) => {
    setSelectedRecordIds(current => current.includes(id) ? current.filter(recordId => recordId !== id) : [...current, id]);
    setBulkNotice('');
    setBulkFailures([]);
  };
  const toggleAllVisible = () => {
    setSelectedRecordIds(allVisibleSelected ? [] : selectableRecords.map(record => record.id));
    setBulkNotice('');
    setBulkFailures([]);
  };
  const runBulkReview = (status: 'reviewed' | 'deferred' | 'unresolved') => {
    if (!selectedRecordIds.length) return;
    setBulkNotice('');
    setBulkFailures([]);
    // Bulk review accepts one shared note, but the UI intentionally does not
    // expose bulk note entry yet. Send null explicitly so the API contract is
    // unambiguous; use the detail panel when review context must be recorded.
    bulkReview.mutate({ data: { ids: selectedRecordIds, status, note: null } }, {
      onSuccess: result => {
        const failedResults = result.results.filter(item => !item.success);
        setSelectedRecordIds(failedResults.map(item => item.id));
        setBulkFailures(failedResults.map(item => ({
          id: item.id,
          error: item.error ?? 'The record could not be updated.'
        })));
        setBulkNotice(result.failed
          ? `${result.succeeded} updated; ${result.failed} failed.`
          : `${result.succeeded} findings marked ${status}.`);
        queryClient.invalidateQueries({ queryKey: getGetArchiveInventoryQueryKey() });
        result.results.filter(item => item.success).forEach(item => {
          queryClient.invalidateQueries({ queryKey: getGetArchiveRecordQueryKey(item.id) });
        });
      },
      onError: error => {
        setBulkFailures([]);
        setBulkNotice(`Bulk review could not be saved: ${errorText(error)}`);
      }
    });
  };

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
        <div className="mb-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
          <MetricCard icon={FileCheck2} label="ACTIVE FILES" value={String(scan.activeFiles)} note="Verified local media" status={isScanning ? 'processing' : 'ready'} />
          <MetricCard icon={Archive} label="MISSING FILES" value={String(scan.missingCount)} note="Known but missing" accent={scan.missingCount ? 'red' : 'teal'} status={scan.missingCount ? 'error' : 'idle'} />
          <MetricCard icon={Library} label="DUPLICATES" value={String(scan.duplicateCount)} note="Identical files found" accent={scan.duplicateCount ? 'amber' : 'teal'} />
          <MetricCard icon={Activity} label="QUALITY CONFLICTS" value={String(scan.qualityConflictCount)} note="Multiple versions exist" accent={scan.qualityConflictCount ? 'amber' : 'teal'} />
          <MetricCard icon={ShieldCheck} label="QUALITY FINDINGS" value={String(qualityFindings?.summary.unreviewedCount ?? 0)} note={qualityFindings ? `${qualityFindings.summary.exactDuplicateCount} exact / ${qualityFindings.summary.probableDuplicateCount} probable / ${qualityFindings.summary.lowerQualityCount} lower quality` : 'Compare on: resolution, HDR, codec, bitrate, audio'} accent={qualityFindings?.summary.exactDuplicateCount ? 'amber' : 'teal'} />
        </div>
      )}

      <div className={`grid items-start gap-5 ${selectedRecordId ? 'xl:grid-cols-[minmax(0,1fr)_380px]' : 'grid-cols-1'}`}>
        <section className="archive-panel flex min-h-[500px] flex-col" data-testid="panel-archive-list">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#e3e8e7] bg-[#fbfcfa] p-4 md:px-6">
            <div className="flex flex-wrap gap-2">
              <button onClick={() => { setView('local'); setFilter('all'); setSelectedRecordId(null); setSelectedRecordIds([]); setBulkNotice(''); setBulkFailures([]); }} className={`px-3 py-1.5 text-[10px] font-bold tracking-[.1em] ${view === 'local' ? 'bg-[#dcebe7] text-[#39736e]' : 'text-[#8a9b9e] hover:bg-[#f3f5f4]'}`} data-testid="tab-local-inventory">LOCAL INVENTORY</button>
             <button onClick={() => { setView('naming_proposals'); setSelectedRecordId(null); setSelectedRecordIds([]); setBulkNotice(''); setBulkFailures([]); }} className={`px-3 py-1.5 text-[10px] font-bold tracking-[.1em] ${view === 'naming_proposals' ? 'bg-[#dcebe7] text-[#39736e]' : 'text-[#8a9b9e] hover:bg-[#f3f5f4]'}`} data-testid="tab-naming-proposals">NAMING PROPOSALS</button>
             <button onClick={() => { setView('plex_only'); setSelectedRecordId(null); setSelectedRecordIds([]); setBulkNotice(''); setBulkFailures([]); }} className={`px-3 py-1.5 text-[10px] font-bold tracking-[.1em] ${view === 'plex_only' ? 'bg-[#dcebe7] text-[#39736e]' : 'text-[#8a9b9e] hover:bg-[#f3f5f4]'}`} data-testid="tab-plex-only">PLEX ONLY ({scan?.plexOnlyCount ?? 0})</button>
            </div>

            {view === 'local' && (
              <div className="flex flex-wrap items-center gap-2">
                {(['all', 'queue', 'duplicates', 'conflicts', 'missing', 'local_only', 'reviewed', 'unresolved'] as const).map(f => (
                  <button key={f} onClick={() => { setFilter(f); setSelectedRecordIds([]); setBulkNotice(''); setBulkFailures([]); }} className={`archive-mono text-[9px] tracking-[.08em] px-2 py-1 border ${filter === f ? 'border-[#4e9690] bg-[#eaf3ef] text-[#39736e]' : 'border-[#d6dfdc] bg-white text-[#7f9194] hover:border-[#aabfba]'}`}>
                    {f === 'queue' ? 'REVIEW QUEUE' : f.replace('_', ' ').toUpperCase()}
                  </button>
                ))}
              </div>
            )}
          </div>

          {view === 'naming_proposals' && namingResults.length > 0 && (
            <div className="border-b border-[#e3e8e7] bg-[#f7faf8] px-4 py-3 md:px-6" data-testid="panel-naming-actions">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="archive-mono text-[9px] tracking-[.08em] text-[#7f9194]" data-testid="status-naming-summary">
                  ACCEPTED {namingProposals?.summary.acceptedCount ?? 0} / DEFERRED {namingProposals?.summary.deferredCount ?? 0} / REJECTED {namingProposals?.summary.rejectedCount ?? 0} / REOPENED {namingProposals?.summary.staleDecisionCount ?? 0}
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" onClick={() => runNamingApply(acceptedActionableIds, true)} disabled={!acceptedActionableIds.length || namingApply.isPending} className="inline-flex items-center gap-1.5 border border-[#d6dfdc] bg-white px-3 py-2 text-[9px] font-bold tracking-[.06em] text-[#53656b] hover:border-[#4e9690] disabled:opacity-40" data-testid="button-naming-dry-run"><Terminal size={11} /> DRY RUN ACCEPTED ({acceptedActionableIds.length})</button>
                  <button type="button" onClick={() => runNamingApply(acceptedActionableIds, false)} disabled={!acceptedActionableIds.length || namingApply.isPending} className="inline-flex items-center gap-1.5 bg-[#1d2b38] px-3 py-2 text-[9px] font-bold tracking-[.06em] text-[#f5f6f3] hover:bg-[#21303d] disabled:opacity-40" data-testid="button-naming-apply"><ArrowDownToLine size={11} /> APPLY ACCEPTED ({acceptedActionableIds.length})</button>
                </div>
              </div>
              <p className="mt-2 text-[10px] leading-4 text-[#829197]">Accepted proposals apply as journaled operations: destinations are re-checked for collisions, files are never overwritten, and successful operations can be rolled back.</p>
              {namingNotice && (
                <div className={`mt-3 text-[10px] ${/not saved|failed|refused|blocked/i.test(namingNotice) ? 'text-[#994b43]' : 'text-[#39736e]'}`} role="status" data-testid="status-naming-operations">
                  <div>{namingNotice}</div>
                  {namingFailures.length > 0 && (
                    <ul className="mt-2" aria-label="Failed naming operations">
                      {namingFailures.map(({ id, error }) => <li key={id} data-testid={`naming-failure-${id}`}>Record #{id}: {error}</li>)}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}

          {view === 'local' && selectableRecords.length > 0 && (
            <div className="border-b border-[#e3e8e7] bg-[#f7faf8] px-4 py-3 md:px-6" data-testid="panel-bulk-review">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <label className="inline-flex cursor-pointer items-center gap-2 text-[10px] font-bold tracking-[.08em] text-[#53656b]">
                  <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} className="h-4 w-4 accent-[#39736e]" data-testid="checkbox-select-visible" />
                  {allVisibleSelected ? 'CLEAR VISIBLE' : 'SELECT VISIBLE'} ({selectableRecords.length})
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="archive-mono mr-1 text-[9px] text-[#7f9194]">{selectedRecordIds.length} SELECTED</span>
                  <button type="button" onClick={() => runBulkReview('reviewed')} disabled={!selectedRecordIds.length || bulkReview.isPending} className="inline-flex items-center gap-1.5 bg-[#39736e] px-3 py-2 text-[9px] font-bold tracking-[.06em] text-white disabled:opacity-40" data-testid="button-bulk-reviewed"><Check size={11} /> REVIEWED</button>
                  <button type="button" onClick={() => runBulkReview('deferred')} disabled={!selectedRecordIds.length || bulkReview.isPending} className="inline-flex items-center gap-1.5 border border-[#d9bd77] bg-[#fff8e7] px-3 py-2 text-[9px] font-bold tracking-[.06em] text-[#8d681d] disabled:opacity-40" data-testid="button-bulk-deferred"><Pause size={11} /> DEFER</button>
                  <button type="button" onClick={() => runBulkReview('unresolved')} disabled={!selectedRecordIds.length || bulkReview.isPending} className="inline-flex items-center gap-1.5 border border-[#e2b9b4] bg-[#fcedea] px-3 py-2 text-[9px] font-bold tracking-[.06em] text-[#994b43] disabled:opacity-40" data-testid="button-bulk-unresolved"><RotateCcw size={11} /> UNRESOLVED</button>
                </div>
              </div>
              <p className="mt-2 text-[10px] leading-4 text-[#829197]" data-testid="text-bulk-review-note-policy">
                Bulk decisions currently save without a note. Open a finding to record review context.
              </p>
              {bulkNotice && (
                <div
                  className={`bulk-review-status mt-3 text-[10px] ${bulkNotice.includes('failed') || bulkNotice.includes('could not') ? 'text-[#994b43]' : 'text-[#39736e]'}`}
                  data-testid="status-bulk-review"
                  role="status"
                  aria-live="polite"
                  aria-atomic="false"
                >
                  <div>{bulkNotice}</div>
                  {bulkFailures.length > 0 && (
                    <ul className="bulk-review-failures mt-2" aria-label="Failed bulk review records">
                      {bulkFailures.map(({ id, error }) => (
                        <li key={id} className="bulk-review-failure" data-testid={`bulk-review-failure-${id}`}>
                          <span className="bulk-review-failure-id" data-testid={`bulk-review-failure-id-${id}`}>Record #{id}</span>
                          <span className="bulk-review-failure-error" data-testid={`bulk-review-failure-error-${id}`}>{error}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-4 md:p-6" style={{ maxHeight: '600px' }}>
            {view === 'naming_proposals' ? (
              namingLoading ? (
                <div className="flex min-h-[250px] items-center justify-center archive-mono text-[10px] tracking-[.12em] text-[#7f9194]" data-testid="status-naming-proposals-loading">ANALYSING ARCHIVE NAMING...</div>
              ) : namingError ? (
                <ErrorState title="Naming intelligence unavailable" message="Naming proposals could not be loaded from the local node." onRetry={() => refetchNaming()} testId="button-retry-naming-proposals" />
              ) : !namingProposals?.results.length ? (
                <EmptyState icon={Sparkles} title="No naming proposals" description="The archive currently has no naming changes requiring review." />
              ) : (
                <div className="space-y-3" data-testid="panel-naming-proposals">
                  {namingProposals.results.map(proposal => {
                    const proposalOperation = operationsByRecord.get(proposal.fileRecordId);
                    const isExecutable = Boolean(proposal.proposedPath) && proposal.operation !== 'uncertain/no_action';
                    return (
                    <div key={proposal.fileRecordId} className="border border-[#e1e8e5] bg-white/50 p-4">
                      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                        <div className="min-w-0">
                          <div className="archive-mono text-[9px] tracking-[.12em] text-[#7f9194]">CURRENT</div>
                          <div className="mt-1 break-all text-[12px] font-semibold text-[#43545b]">{proposal.sourcePath}</div>
                        </div>
                        <div className="min-w-0">
                          <div className="archive-mono text-[9px] tracking-[.12em] text-[#39736e]">PROPOSED</div>
                          <div className="mt-1 break-all text-[12px] font-semibold text-[#344851]">{proposal.proposedPath ?? proposal.proposedFilename ?? 'No proposed path'}</div>
                        </div>
                      </div>
                      <div className="mt-4 flex flex-wrap gap-x-3 gap-y-2 border-t border-[#edf1ef] pt-3">
                        <span className="archive-mono text-[9px] text-[#7f9194]">CONFIDENCE / {proposal.confidence.toUpperCase()}</span>
                        <span className="archive-mono text-[9px] text-[#7f9194]">OPERATION / {proposal.operation.toUpperCase()}</span>
                        <span className="archive-mono text-[9px] text-[#7f9194]">PATTERN / {proposal.patternId}</span>
                        <span className="archive-mono text-[9px] text-[#7f9194]">MEDIA TYPE / {proposal.mediaType.toUpperCase()}</span>
                        <span className="archive-mono text-[9px] text-[#7f9194]">VOLUME / {proposal.volumeId}</span>
                        {(proposal.confidence === 'uncertain' || proposal.operation === 'uncertain/no_action') && <span className="archive-mono text-[9px] text-[#a77517]">UNCERTAIN</span>}
                        {proposal.collision && <span className="archive-mono text-[9px] text-[#994b43]">COLLISION / YES</span>}
                      </div>
                      {(proposal.reason || proposal.evidence.length > 0) && (
                        <div className="mt-3 border-l-2 border-[#d9bd77] bg-[#fff8e7] p-3 text-[11px] leading-5 text-[#80652e]">
                          {proposal.reason && <div><span className="font-bold">WHY / </span>{proposal.reason}</div>}
                          {proposal.evidence.length > 0 && <div className="mt-1"><span className="font-bold">EVIDENCE / </span>{proposal.evidence.join('; ')}</div>}
                        </div>
                      )}
                      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[#edf1ef] pt-3" data-testid={`panel-naming-decision-${proposal.fileRecordId}`}>
                        <span className={`archive-mono mr-1 px-2 py-1 text-[9px] tracking-[.08em] ${proposal.decisionStatus === 'accepted' ? 'bg-[#eaf3ef] text-[#39736e]' : proposal.decisionStatus === 'deferred' ? 'bg-[#fff0c9] text-[#8d681d]' : proposal.decisionStatus === 'rejected' ? 'bg-[#fcedea] text-[#994b43]' : 'bg-[#f3f5f4] text-[#8a9b9e]'}`} data-testid={`status-naming-decision-${proposal.fileRecordId}`}>
                          DECISION / {proposal.decisionStatus.toUpperCase()}{proposal.decisionStale ? ' · REOPENED' : ''}
                        </span>
                        <button type="button" onClick={() => decideNamingProposal(proposal.fileRecordId, 'accepted')} disabled={namingDecisions.isPending || (proposal.decisionStatus === 'accepted' && !proposal.decisionStale)} className="inline-flex items-center gap-1.5 bg-[#39736e] px-2.5 py-1.5 text-[9px] font-bold tracking-[.06em] text-white disabled:opacity-40" data-testid={`button-naming-accept-${proposal.fileRecordId}`} title={isExecutable ? 'Accept this proposal' : 'Only proposals with an executable destination can be accepted'}><Check size={11} /> ACCEPT</button>
                        <button type="button" onClick={() => decideNamingProposal(proposal.fileRecordId, 'rejected')} disabled={namingDecisions.isPending} className="inline-flex items-center gap-1.5 border border-[#e2b9b4] bg-[#fcedea] px-2.5 py-1.5 text-[9px] font-bold tracking-[.06em] text-[#994b43] disabled:opacity-40" data-testid={`button-naming-reject-${proposal.fileRecordId}`}><X size={11} /> REJECT</button>
                        <button type="button" onClick={() => decideNamingProposal(proposal.fileRecordId, 'deferred')} disabled={namingDecisions.isPending} className="inline-flex items-center gap-1.5 border border-[#d9bd77] bg-[#fff8e7] px-2.5 py-1.5 text-[9px] font-bold tracking-[.06em] text-[#8d681d] disabled:opacity-40" data-testid={`button-naming-defer-${proposal.fileRecordId}`}><Pause size={11} /> DEFER</button>
                        {proposal.decisionStatus === 'accepted' && isExecutable && (
                          <>
                            <button type="button" onClick={() => runNamingApply([proposal.fileRecordId], true)} disabled={namingApply.isPending} className="inline-flex items-center gap-1.5 border border-[#d6dfdc] bg-white px-2.5 py-1.5 text-[9px] font-bold tracking-[.06em] text-[#53656b] hover:border-[#4e9690] disabled:opacity-40" data-testid={`button-naming-dry-run-one-${proposal.fileRecordId}`}><Terminal size={11} /> DRY RUN</button>
                            <button type="button" onClick={() => runNamingApply([proposal.fileRecordId], false)} disabled={namingApply.isPending} className="inline-flex items-center gap-1.5 bg-[#1d2b38] px-2.5 py-1.5 text-[9px] font-bold tracking-[.06em] text-[#f5f6f3] hover:bg-[#21303d] disabled:opacity-40" data-testid={`button-naming-apply-one-${proposal.fileRecordId}`}><ArrowDownToLine size={11} /> APPLY</button>
                          </>
                        )}
                      </div>
                      {proposal.decisionNote && <div className="mt-2 text-[10px] leading-4 text-[#829197]">NOTE / {proposal.decisionNote}</div>}
                      {proposalOperation && (
                        <div className="mt-3 border-l-2 border-[#dce8e5] bg-[#f3f7f5] p-2" data-testid={`status-naming-operation-${proposal.fileRecordId}`}>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className={`archive-mono text-[9px] tracking-[.08em] ${proposalOperation.status === 'succeeded' ? 'text-[#39736e]' : proposalOperation.status === 'failed' ? 'text-[#994b43]' : 'text-[#8d681d]'}`}>
                              OPERATION #{proposalOperation.id} / {proposalOperation.kind.toUpperCase()} / {proposalOperation.status.replace('_', ' ').toUpperCase()}
                            </span>
                            {proposalOperation.status === 'succeeded' && proposalOperation.rollbackAvailable && (
                              <button type="button" onClick={() => rollbackNamingOperation(proposalOperation.id)} disabled={namingRollback.isPending} className="inline-flex items-center gap-1.5 border border-[#d6dfdc] bg-white px-2 py-1 text-[9px] font-bold tracking-[.06em] text-[#53656b] hover:border-[#4e9690] disabled:opacity-40" data-testid={`button-naming-rollback-${proposal.fileRecordId}`}><RotateCcw size={11} /> ROLL BACK</button>
                            )}
                          </div>
                          {proposalOperation.error && <div className="mt-1 text-[10px] leading-4 text-[#994b43]" data-testid={`error-naming-operation-${proposal.fileRecordId}`}>{proposalOperation.error}</div>}
                        </div>
                      )}
                      {!proposalOperation && (
                        <div className="mt-3 archive-mono text-[9px] tracking-[.08em] text-[#a0afaf]">{proposal.decisionStatus === 'accepted' && isExecutable ? 'ACCEPTED / APPLIES ONLY THROUGH THE OPERATION JOURNAL · NO OVERWRITES' : 'PROPOSAL ONLY / NO FILESYSTEM ACTION'}</div>
                      )}
                    </div>
                    );
                  })}
                </div>
              )
            ) : showPlex ? (
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
                    <div key={r.id} className={`flex items-stretch border transition-colors ${selectedRecordId === r.id ? 'border-[#4e9690] bg-[#eef6f2]' : selectedSet.has(r.id) ? 'border-[#aabfba] bg-[#f3f8f5]' : 'border-[#e1e8e5] bg-white/50 hover:border-[#aabfba]'}`}>
                      {r.reviewStatus !== 'not_applicable' && (
                        <label className="grid cursor-pointer place-items-center border-r border-[#e1e8e5] px-3" aria-label={`Select ${r.filename}`}>
                          <input type="checkbox" checked={selectedSet.has(r.id)} onChange={() => toggleRecordSelection(r.id)} className="h-4 w-4 accent-[#39736e]" data-testid={`checkbox-archive-record-${r.id}`} />
                        </label>
                      )}
                      <button
                        onClick={() => setSelectedRecordId(r.id)}
                        className="flex min-w-0 flex-1 flex-col justify-between gap-3 p-3 text-left sm:flex-row sm:items-center"
                        data-testid={`row-archive-record-${r.id}`}
                      >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12px] font-semibold text-[#43545b]" title={r.filename}>{r.filename}</div>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px]">
<span className={`archive-mono tracking-[.05em] ${
  reviewPriority(r) >= 90
    ? 'text-[#994b43]'
    : reviewPriority(r) >= 60
      ? 'text-[#a77517]'
      : 'text-[#7f9194]'
}`}>
  {reviewPriorityLabel(r)}
</span>
                          <span className={`archive-mono tracking-[.05em] ${r.qualityStatus.includes('duplicate') || r.qualityStatus.includes('missing') || r.qualityStatus.includes('needs_review') ? 'text-[#a77517]' : 'text-[#4e9690]'}`}>
                            {r.qualityStatus.replace(/_/g, ' ').toUpperCase()}
                          </span>
                          <span className="text-[#8a9b9e]">{formatBytes(r.sizeBytes)}</span>
                        </div>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        {r.scanStatus === 'missing' && <span className="grid h-6 place-items-center bg-[#fcedea] px-2 text-[9px] font-bold text-[#c85b51]">MISSING</span>}
                        {r.plexMatch && <span className="grid h-6 place-items-center bg-[#fff0c9] px-2 text-[9px] font-bold text-[#a77517]">IN PLEX</span>}
                        {r.reviewStatus !== 'not_applicable' && <span className={`grid h-6 place-items-center px-2 text-[9px] font-bold ${r.reviewStatus === 'reviewed' ? 'bg-[#eaf3ef] text-[#39736e]' : r.reviewStatus === 'deferred' ? 'bg-[#fff0c9] text-[#8d681d]' : 'bg-[#fcedea] text-[#994b43]'}`}>{r.reviewStatus.replace(/_/g, ' ').toUpperCase()}</span>}
                      </div>
                      </button>
                    </div>
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

function acquisitionQualityLabel(quality: { height: number | null; hdr: boolean; videoCodec: string | null; audioCodec: string | null } | null) {
  if (!quality) return 'UNKNOWN QUALITY';
  const resolution = quality.height ? `${quality.height}P` : 'RESOLUTION UNKNOWN';
  const hdr = quality.hdr ? ' / HDR' : '';
  const codecs = [quality.videoCodec, quality.audioCodec].filter(Boolean).join(' / ');
  return `${resolution}${hdr}${codecs ? ` / ${codecs}` : ''}`;
}

function planTrustTone(state: string) {
  if (state === 'trusted' || state === 'user_approved') return 'bg-[#eaf3ef] text-[#39736e]';
  if (state === 'blocked') return 'bg-[#f9e5e1] text-[#994b43]';
  if (state === 'unsupported') return 'bg-[#fff0c9] text-[#8d681d]';
  return 'bg-[#f1e6d8] text-[#8d681d]';
}

/** URL → Archive planner: deterministic, API-driven vertical slice. */
function AcquisitionPlannerPanel() {
  const queryClient = useQueryClient();
  const [sourceUrl, setSourceUrl] = useState('');
  const [note, setNote] = useState('');
  const [selectedPlanId, setSelectedPlanId] = useState<number | null>(null);
  const [planNotice, setPlanNotice] = useState('');

  const plansQuery = useListAcquisitionPlans();
  const planQuery = useGetAcquisitionPlan(selectedPlanId ?? 0, {
    query: {
      queryKey: getGetAcquisitionPlanQueryKey(selectedPlanId ?? 0),
      enabled: selectedPlanId !== null,
      refetchInterval: 3000,
    },
  });
  const createPlan = useCreateAcquisitionPlan();
  const approvePlan = useApproveAcquisitionPlan();
  const rejectPlan = useRejectAcquisitionPlan();
  const executePlan = useExecuteAcquisitionPlan();

  const plans = plansQuery.data?.results ?? [];
  const plan: AcquisitionPlan | undefined = selectedPlanId !== null ? planQuery.data : undefined;
  const refreshPlans = () => queryClient.invalidateQueries({ queryKey: getListAcquisitionPlansQueryKey() });
  const refreshPlan = (id: number) => queryClient.invalidateQueries({ queryKey: getGetAcquisitionPlanQueryKey(id) });

  const handleCreate = () => {
    setPlanNotice('');
    createPlan.mutate({ data: { sourceUrl: sourceUrl.trim(), note: note.trim() || null } }, {
      onSuccess: (created) => {
        setSelectedPlanId(created.id);
        setNote('');
        refreshPlans();
      },
      onError: (error) => setPlanNotice(error.message || 'The source could not be planned.'),
    });
  };
  const planAction = (
    mutation: { mutate: (variables: { id: number }, options?: { onSuccess?: () => void; onError?: (error: Error) => void }) => void },
    id: number,
  ) => mutation.mutate({ id }, {
    onSuccess: () => { refreshPlan(id); refreshPlans(); },
    onError: (error) => setPlanNotice(error.message || 'The plan action failed.'),
  });

  return <section className="archive-panel mb-6 p-5 md:p-6" data-testid="panel-acquisition-planner">
    <div className="flex items-start justify-between gap-4">
      <div>
        <div className="archive-mono text-[10px] tracking-[.14em] text-[#7f9194]">URL → ARCHIVE PLANNER</div>
        <h2 className="archive-display mt-1 text-xl font-extrabold text-[#263844]">Plan an acquisition from a source URL</h2>
        <p className="mt-1 max-w-2xl text-[11px] leading-5 text-[#7f9194]">Supply a URL (yt-dlp handles the inspection, including playlists). The plan is read-only: discovered items are resolved against the archive, and an untrusted source is never executed without an explicit approval.</p>
      </div>
    </div>
    <div className="mt-4 grid gap-2 md:grid-cols-[2fr_2fr_auto]">
      <input value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://example.com/playlist" className="border border-[#d6dfdc] bg-[#fbfcfa] px-3 py-2.5 text-[12px] text-[#43545b]" data-testid="input-planner-url" />
      <input value={note} onChange={(event) => setNote(event.target.value)} placeholder='Request note, e.g. "Kirra wants all three seasons…"' className="border border-[#d6dfdc] bg-[#fbfcfa] px-3 py-2.5 text-[12px] text-[#43545b]" data-testid="input-planner-note" />
      <button onClick={handleCreate} disabled={!sourceUrl.trim() || createPlan.isPending} className="bg-[#1d2b38] px-4 py-2.5 text-[11px] font-bold tracking-[.1em] text-[#f5f6f3] disabled:opacity-50" data-testid="button-planner-build">{createPlan.isPending ? 'PLANNING…' : 'BUILD PLAN'}</button>
    </div>
    {planNotice && <div className="mt-2 archive-mono text-[10px] tracking-[.08em] text-[#994b43]" data-testid="planner-notice">{planNotice}</div>}

    {plans.length > 0 && <div className="mt-4 flex flex-wrap gap-2" data-testid="planner-plan-list">
      {plans.slice(0, 6).map((entry) => (
        <button key={entry.id} onClick={() => setSelectedPlanId(entry.id)} className={`archive-mono px-2.5 py-1.5 text-[9px] font-bold tracking-[.08em] ${selectedPlanId === entry.id ? 'bg-[#1d2b38] text-[#f5f6f3]' : 'bg-[#eef1ef] text-[#53656b]'}`} data-testid={`button-planner-plan-${entry.id}`}>
          PLAN #{entry.id} / {entry.approvalState.replace('_', ' ').toUpperCase()} / {entry.sourceTrust.state.replace('_', ' ').toUpperCase()}
        </button>
      ))}
    </div>}

    {plan && <div className="mt-5 border-t border-[#e3e8e7] pt-4" data-testid={`planner-plan-${plan.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="archive-mono text-[9px] tracking-[.12em] text-[#829197]">SUPPLIED SOURCE</div>
          <div className="mt-1 text-[12px] font-bold text-[#43545b]">{plan.suppliedSource.title}</div>
          <div className="archive-mono mt-1 text-[9px] text-[#9aa7a7]">{plan.suppliedSource.url}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`archive-mono px-2 py-1 text-[9px] font-bold tracking-[.08em] ${planTrustTone(plan.sourceTrust.state)}`} data-testid="planner-trust">{plan.sourceTrust.state.replace('_', ' ').toUpperCase()}</span>
          <span className="archive-mono px-2 py-1 text-[9px] font-bold tracking-[.08em] bg-[#eef1ef] text-[#53656b]" data-testid="planner-approval">{plan.approvalState.toUpperCase()}</span>
        </div>
      </div>
      <p className="mt-3 text-[11px] leading-5 text-[#7f9194]">{plan.sourceTrust.reason}</p>
      <div className="mt-4 grid gap-x-5 gap-y-3 sm:grid-cols-4">
        <div><div className="archive-mono text-[9px] tracking-[.1em] text-[#829197]">DISCOVERED</div><div className="mt-1 text-[12px] font-bold text-[#43545b]">{plan.discoveredCandidates.length}</div></div>
        <div><div className="archive-mono text-[9px] tracking-[.1em] text-[#829197]">MISSING</div><div className="mt-1 text-[12px] font-bold text-[#43545b]">{plan.missingItems.length}</div></div>
        <div><div className="archive-mono text-[9px] tracking-[.1em] text-[#829197]">ALREADY PRESENT</div><div className="mt-1 text-[12px] font-bold text-[#43545b]">{plan.alreadyPresentItems.length}</div></div>
        <div><div className="archive-mono text-[9px] tracking-[.1em] text-[#829197]">STORAGE</div><div className="mt-1 text-[12px] font-bold text-[#43545b]">{plan.storageImpact.status.toUpperCase()}</div></div>
      </div>
      {plan.items.length > 0 && <div className="mt-4 border border-[#e3e8e7]" data-testid="planner-items">
        <div className="grid grid-cols-[1fr_auto] gap-2 border-b border-[#e3e8e7] bg-[#f6f8f6] px-3 py-2 archive-mono text-[9px] tracking-[.1em] text-[#829197]"><span>ITEM</span><span>STATE</span></div>
        {plan.items.map((item) => (
          <div key={item.identityKey} className="grid grid-cols-[1fr_auto] items-center gap-2 border-b border-[#eef1ef] px-3 py-2 last:border-0">
            <div className="text-[11px] font-bold text-[#43545b]">{item.title}<div className="archive-mono mt-0.5 text-[9px] text-[#9aa7a7]">{item.destinationPath ?? item.identityKey}</div>{item.error && <div className="archive-mono mt-0.5 text-[9px] text-[#994b43]">{item.error}</div>}</div>
            <span className={`archive-mono px-2 py-1 text-[9px] font-bold tracking-[.06em] ${item.state === 'complete' || item.state === 'placed' ? 'bg-[#eaf3ef] text-[#39736e]' : item.state === 'failed' ? 'bg-[#f9e5e1] text-[#994b43]' : 'bg-[#eef1ef] text-[#53656b]'}`}>{item.state.replace(/_/g, ' ').toUpperCase()}</span>
          </div>
        ))}
      </div>}
      <div className="mt-4 flex flex-wrap gap-2">
        {plan.approvalState === 'pending' && plan.sourceTrust.state !== 'blocked' && plan.sourceTrust.state !== 'unsupported' && <>
          <button onClick={() => planAction(approvePlan, plan.id)} disabled={approvePlan.isPending} className="bg-[#1d2b38] px-4 py-2.5 text-[11px] font-bold tracking-[.1em] text-[#f5f6f3] disabled:opacity-50" data-testid="button-planner-approve">APPROVE SOURCE</button>
          <button onClick={() => planAction(rejectPlan, plan.id)} disabled={rejectPlan.isPending} className="border border-[#d6dfdc] px-4 py-2.5 text-[11px] font-bold tracking-[.1em] text-[#53656b] disabled:opacity-50" data-testid="button-planner-reject">REJECT</button>
        </>}
        {plan.approvalState === 'approved' && <button onClick={() => planAction(executePlan, plan.id)} disabled={executePlan.isPending || plan.items.every((item) => item.state !== 'planned')} className="bg-[#1d2b38] px-4 py-2.5 text-[11px] font-bold tracking-[.1em] text-[#f5f6f3] disabled:opacity-50" data-testid="button-planner-execute">EXECUTE PLAN</button>}
      </div>
    </div>}
  </section>;
}

function DiscoveryPage() {
  const queryClient = useQueryClient();
  const [mediaType, setMediaType] = useState<'all' | 'movie' | 'tv'>('all');
  const [status, setStatus] = useState<'all' | 'recommended' | 'not_recommended'>('all');
  const params: GetAcquisitionFindingsParams = {
    mediaType: mediaType === 'all' ? undefined : mediaType,
    status: status === 'all' ? undefined : status,
    page: 1,
    pageSize: 100,
  };
  const findingsQuery = useGetAcquisitionFindings(params);
  const refresh = useRefreshAcquisitionIntelligence();
  const findings = (findingsQuery.data?.results ?? []).filter((finding) => finding.need.archiveState !== 'fully_present');
  const handleRefresh = () => {
    refresh.mutate(undefined, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetAcquisitionFindingsQueryKey(params) }),
    });
  };

  return <>
    <PageIntro
      eyebrow="DISCOVERY / ACQUISITION INTELLIGENCE"
      title="What should be acquired?"
      description="A provider-neutral, reviewable readout of missing media, candidate sources, quality tradeoffs, and storage implications. Nothing is downloaded from this surface."
      action={<button onClick={handleRefresh} disabled={refresh.isPending} className="inline-flex items-center gap-2 bg-[#1d2b38] px-4 py-3 text-[11px] font-bold tracking-[.1em] text-[#f5f6f3] disabled:opacity-50" data-testid="button-refresh-discovery"><RefreshCw size={14} className={refresh.isPending ? 'animate-spin' : ''} /> {refresh.isPending ? 'RECOMPUTING' : 'REFRESH INTELLIGENCE'}</button>}
    />
    <AcquisitionPlannerPanel />
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border border-[#e3e8e7] bg-white/60 p-3" data-testid="panel-discovery-filters">
      <div className="archive-mono text-[10px] tracking-[.12em] text-[#7f9194]">{findingsQuery.data?.summary.recommended ?? 0} RECOMMENDED / {findingsQuery.data?.summary.blocked ?? 0} BLOCKED</div>
      <div className="flex flex-wrap gap-2">
        <select value={mediaType} onChange={(event) => setMediaType(event.target.value as typeof mediaType)} className="border border-[#d6dfdc] bg-[#fbfcfa] px-2.5 py-2 text-[10px] font-bold tracking-[.08em] text-[#53656b]" data-testid="select-discovery-media-type"><option value="all">ALL MEDIA</option><option value="movie">MOVIES</option><option value="tv">TV</option></select>
        <select value={status} onChange={(event) => setStatus(event.target.value as typeof status)} className="border border-[#d6dfdc] bg-[#fbfcfa] px-2.5 py-2 text-[10px] font-bold tracking-[.08em] text-[#53656b]" data-testid="select-discovery-status"><option value="all">ALL FINDINGS</option><option value="recommended">RECOMMENDED</option><option value="not_recommended">BLOCKED / REVIEW</option></select>
      </div>
    </div>
    {findingsQuery.isLoading ? <div className="grid gap-4 md:grid-cols-2"><Skeleton className="h-[260px]" /><Skeleton className="h-[260px]" /></div> : findingsQuery.isError ? <ErrorState title="Discovery unavailable" message="Acquisition findings could not be read from the local node." onRetry={() => findingsQuery.refetch()} testId="button-retry-discovery" /> : findings.length === 0 ? <EmptyState icon={Search} title="Nothing needs acquisition review" description="The local intelligence layer has no missing or lower-quality findings for this filter. Add normalized adapter candidates or refresh after archive/Plex state changes." /> : <div className="grid gap-4 xl:grid-cols-2" data-testid="panel-discovery-findings">{findings.map((finding) => {
      const option = finding.recommendation.candidateSources.find((candidate) => candidate.availability.state === 'available') ?? finding.recommendation.candidateSources[0];
      const storage = finding.recommendation.expectedStorageImpact;
      return <article key={finding.id} className="archive-panel p-5 md:p-6" data-testid={`card-discovery-finding-${finding.id}`}>
        <div className="flex items-start justify-between gap-4"><div><div className="archive-mono text-[10px] tracking-[.14em] text-[#7f9194]">WHAT'S MISSING / {finding.need.identity.mediaType.toUpperCase()}</div><h2 className="archive-display mt-1 text-xl font-extrabold text-[#263844]">{finding.need.identity.title}{finding.need.identity.year ? ` (${finding.need.identity.year})` : ''}{finding.need.scope === 'season' && finding.need.identity.season !== null ? ` / SEASON ${finding.need.identity.season}` : ''}</h2></div><span className={`archive-mono shrink-0 px-2 py-1 text-[9px] font-bold tracking-[.08em] ${finding.recommendation.status === 'recommended' ? 'bg-[#eaf3ef] text-[#39736e]' : 'bg-[#fff0c9] text-[#8d681d]'}`}>{finding.recommendation.priority.toUpperCase()} PRIORITY</span></div>
        <div className="mt-5 border-l-2 border-[#4e9690] bg-[#eaf3ef] p-4 text-[11px] leading-5 text-[#43545b]"><div className="archive-mono mb-1 text-[9px] tracking-[.12em] text-[#39736e]">WHY IT MATTERS</div>{finding.recommendation.reason}</div>
        <div className="mt-5 grid gap-x-5 gap-y-4 sm:grid-cols-2"><div><div className="archive-mono text-[9px] tracking-[.1em] text-[#829197]">BEST CURRENT OPTION</div><div className="mt-1 text-[12px] font-bold text-[#43545b]">{option ? `${option.provider} / ${option.title}` : 'No candidate source'}</div><div className="mt-1 text-[10px] text-[#879599]">{option?.availability.state.toUpperCase() ?? 'UNAVAILABLE'}</div></div><div><div className="archive-mono text-[9px] tracking-[.1em] text-[#829197]">QUALITY</div><div className="mt-1 text-[12px] font-bold text-[#43545b]">{acquisitionQualityLabel(finding.recommendation.expectedQuality)}</div></div><div><div className="archive-mono text-[9px] tracking-[.1em] text-[#829197]">STORAGE IMPACT</div><div className={`mt-1 text-[12px] font-bold ${storage.status === 'sufficient' ? 'text-[#39736e]' : storage.status === 'insufficient' ? 'text-[#994b43]' : 'text-[#8d681d]'}`}>{storage.status.toUpperCase()}</div><div className="mt-1 text-[10px] text-[#879599]">{storage.summary}</div></div><div><div className="archive-mono text-[9px] tracking-[.1em] text-[#829197]">CONFIDENCE</div><div className="mt-1 text-[12px] font-bold text-[#43545b]">{Math.round(finding.recommendation.confidence * 100)}%</div><div className="mt-1 text-[10px] text-[#879599]">Identity {Math.round(finding.need.identity.confidence * 100)}% / source evidence {option ? Math.round(option.confidence * 100) : 0}%</div></div></div>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-[#e3e8e7] pt-4"><div><div className="archive-mono text-[9px] tracking-[.1em] text-[#829197]">REVIEW STATE</div><div className="mt-1 text-[11px] font-bold tracking-[.06em] text-[#53656b]">{finding.review.status.replace(/_/g, ' ').toUpperCase()}</div></div><div className="text-right">{finding.recommendation.blockingReasons.length > 0 && <div className="archive-mono text-[9px] text-[#994b43]">BLOCKED / {finding.recommendation.blockingReasons.join(', ')}</div>}<div className="archive-mono mt-1 text-[9px] text-[#9aa7a7]">COMPUTED / {formatTime(finding.computedAt)}</div></div></div>
      </article>;
    })}</div>}
  </>;
}

const settingsGroups = [{ name: 'General', icon: SlidersHorizontal, fields: ['mockMode', 'dataDirectory', 'logLevel'] }, { name: 'Downloads', icon: Download, fields: ['downloadDirectory', 'temporaryDirectory', 'concurrentDownloads', 'maxRetries', 'bandwidthLimit'] }, { name: 'Archive', icon: Archive, fields: ['archiveDirectory', 'outputContainer', 'inspectionCacheMinutes', 'warningFreePercent', 'criticalFreePercent'] }, { name: 'Plex', icon: PlaySquare, fields: [] }, { name: 'AI', icon: Sparkles, fields: [] }, { name: 'Local Model', icon: Cpu, fields: [] }, { name: 'OpenAI', icon: Zap, fields: [] }, { name: 'Local Engine', icon: Terminal, fields: ['ytDlpPath', 'ffmpegPath', 'ffprobePath'] }, { name: 'Hardware Acceleration', icon: Cpu, fields: ['hardwareAcceleration', 'hardwareAccelerationMode'] }, { name: 'Network', icon: Network, fields: ['networkMode'] }, { name: 'Security', icon: ShieldCheck, fields: [] }, { name: 'Logging', icon: Terminal, fields: [] }];
function SettingsPage() {
  const queryClient = useQueryClient(); const { data, isLoading, isError, refetch } = useGetSettings(); const { data: dependencies } = useGetSystemDependencies(); const mutation = useUpdateSettings(); const [form, setForm] = useState<Partial<AppSettings>>({}); const [notice, setNotice] = useState('');
  useEffect(() => { if (data) setForm(data); }, [data]);
  const update = (key: keyof AppSettings, value: AppSettings[keyof AppSettings]) => setForm((current) => ({ ...current, [key]: value }));
  const save = () => { setNotice(''); mutation.mutate({ data: form as AppSettingsUpdate }, { onSuccess: (result) => { setForm(result); setNotice('Settings saved to the local node.'); queryClient.setQueryData(getGetSettingsQueryKey(), result); }, onError: () => setNotice('Settings could not be saved. The local node did not accept the update.') }); };
  if (isLoading) return <><PageIntro eyebrow="SYSTEM / SETTINGS" title="System settings" description="Loading editable local preferences." /><Skeleton className="h-[520px]" /></>;
  if (isError || !data) return <ErrorState title="Settings unavailable" message="Preferences could not be read from the local node." onRetry={() => refetch()} testId="button-retry-settings" />;
  return <><PageIntro eyebrow="SYSTEM / SETTINGS" title="System settings" description="Persistent preferences for the local-first control room. Changes are sent to the real settings API." action={<div className="flex items-center gap-3">{notice && <span className={`hidden text-[11px] sm:inline ${notice.includes('could not') ? 'text-[#c85b51]' : 'text-[#39736e]'}`} data-testid="status-settings-save">{notice}</span>}<button onClick={save} disabled={mutation.isPending} className="inline-flex items-center gap-2 bg-[#1d2b38] px-4 py-2.5 text-[11px] font-bold tracking-[.1em] text-[#f5f6f3] disabled:opacity-50" data-testid="button-save-settings"><Save size={14} /> {mutation.isPending ? 'SAVING' : 'SAVE CHANGES'}</button></div>} />{notice && <div className={`mb-4 text-[11px] sm:hidden ${notice.includes('could not') ? 'text-[#c85b51]' : 'text-[#39736e]'}`} data-testid="status-settings-save-mobile">{notice}</div>}<div className="grid gap-5 xl:grid-cols-[1fr_280px]"><div className="space-y-4">{settingsGroups.map(({ name, icon: Icon, fields }) => <SettingsGroup key={name} name={name} icon={Icon} fields={fields} form={form} update={update} />)}</div><aside className="archive-panel h-fit p-5 md:p-6"><div className="archive-mono text-[10px] tracking-[.14em] text-[#7f9194]">LOCAL DEPENDENCIES</div><h2 className="archive-display mt-1 text-lg font-extrabold">Capability check</h2><div className="mt-5 space-y-3">{dependencies?.length ? dependencies.map((dep) => <div key={dep.name} className="flex items-center gap-3" data-testid={`row-dependency-${dep.name}`}><span className={`status-dot ${dep.status === 'available' ? 'ready' : dep.status === 'missing' ? 'error' : 'warning'}`} /><div className="min-w-0"><div className="truncate text-[11px] font-semibold text-[#53656b]">{dep.name}</div><div className="archive-mono text-[9px] text-[#96a3a5]">{dep.version ?? dep.status}</div></div></div>) : <p className="text-[11px] leading-5 text-[#879599]">No dependency data returned yet.</p>}</div><div className="mt-6 border-t border-[#e3e8e7] pt-4 text-[10px] leading-5 text-[#879599]">Only values represented by the API are editable. Future sections stay visibly reserved.</div></aside></div></>;
}
function SettingsGroup({ name, icon: Icon, fields, form, update }: { name: string; icon: typeof SlidersHorizontal; fields: string[]; form: Partial<AppSettings>; update: (key: keyof AppSettings, value: AppSettings[keyof AppSettings]) => void }) {
  const [open, setOpen] = useState(fields.length > 0); const slug = name.toLowerCase().replace(/\s/g, '-');
  return <section className={`archive-panel overflow-hidden ${fields.length ? '' : 'opacity-75'}`} data-testid={`settings-group-${slug}`}><button onClick={() => setOpen((value) => !value)} className="flex w-full items-center justify-between px-5 py-4 text-left hover:bg-white/50" data-testid={`button-toggle-settings-${slug}`}><span className="flex items-center gap-3"><span className="grid h-8 w-8 place-items-center bg-[#e8efed] text-[#4e9690]"><Icon size={15} /></span><span className="archive-display text-[14px] font-extrabold text-[#354851]">{name}</span>{fields.length === 0 && <span className="archive-mono text-[8px] tracking-[.1em] text-[#9ba6a7]">RESERVED</span>}</span><ChevronRight size={16} className={`text-[#9aa7a7] transition-transform ${open ? 'rotate-90' : ''}`} /></button>{open && fields.length > 0 && <div className="grid gap-4 border-t border-[#e3e8e7]/60 px-5 py-5 md:grid-cols-2">{fields.map((field) => <SettingField key={field} field={field} form={form} update={update} />)}</div>}</section>;
}
function SettingField({ field, form, update }: { field: string; form: Partial<AppSettings>; update: (key: keyof AppSettings, value: AppSettings[keyof AppSettings]) => void }) {
  const key = field as keyof AppSettings; const value = form[key];
  if (field === 'mockMode' || field === 'hardwareAcceleration') return <label className="flex items-center justify-between gap-4 border border-[#e2e8e6] bg-white/50 px-3 py-3"><span><span className="block text-[11px] font-semibold text-[#53656b]">{field === 'mockMode' ? 'Mock mode' : 'Hardware acceleration'}</span><span className="mt-1 block text-[10px] text-[#94a1a3]">{field === 'mockMode' ? 'Use backend-provided demo data' : 'Allow accelerated media work'}</span></span><input type="checkbox" checked={Boolean(value)} onChange={(event) => update(key, event.target.checked)} className="h-4 w-4 accent-[#4e9690]" data-testid={`input-setting-${field}`} /></label>;
  const selectOptions: Record<string, string[]> = { logLevel: ['info', 'debug', 'warn', 'error'], networkMode: ['offline', 'local_only', 'allow_network'], hardwareAccelerationMode: ['auto', 'disabled'], outputContainer: ['mp4', 'mkv', 'webm'] };
   const labels: Record<string, string> = { dataDirectory: 'DATA DIRECTORY', downloadDirectory: 'DOWNLOAD DIRECTORY', archiveDirectory: 'ARCHIVE DIRECTORY', temporaryDirectory: 'TEMPORARY DIRECTORY', ytDlpPath: 'YT-DLP EXECUTABLE', ffmpegPath: 'FFMPEG EXECUTABLE', ffprobePath: 'FFPROBE EXECUTABLE', concurrentDownloads: 'CONCURRENT DOWNLOADS', maxRetries: 'MAX RETRIES', bandwidthLimit: 'BANDWIDTH LIMIT (BYTES / SEC)', inspectionCacheMinutes: 'INSPECTION CACHE (MINUTES)', warningFreePercent: 'WARNING FREE (%)', criticalFreePercent: 'CRITICAL FREE (%)' };
  if (selectOptions[field]) return <label><span className="archive-mono mb-2 block text-[10px] tracking-[.1em] text-[#6e8185]">{labels[field] ?? field.toUpperCase()}</span><select value={String(value ?? '')} onChange={(event) => update(key, event.target.value)} className="w-full border border-[#d6dfdc] bg-[#fbfcfa] px-3 py-2.5 text-[12px] outline-none" data-testid={`select-setting-${field}`}>{selectOptions[field].map((option) => <option key={option} value={option}>{option}</option>)}</select></label>;
  const numeric = ['concurrentDownloads', 'maxRetries', 'bandwidthLimit', 'inspectionCacheMinutes', 'warningFreePercent', 'criticalFreePercent'].includes(field);
  return <label><span className="archive-mono mb-2 block text-[10px] tracking-[.1em] text-[#6e8185]">{labels[field] ?? field.toUpperCase()}</span><input type={numeric ? 'number' : 'text'} min={numeric ? 0 : undefined} value={String(value ?? '')} onChange={(event) => update(key, numeric ? Number(event.target.value) : event.target.value)} className="w-full border border-[#d6dfdc] bg-[#fbfcfa] px-3 py-2.5 text-[12px] outline-none" data-testid={`input-setting-${field}`} /></label>;
}

function AuthLoading() {
  return <div className="flex min-h-[100dvh] items-center justify-center bg-[#f3f5f4]"><div className="archive-panel flex items-center gap-3 px-5 py-4"><span className="status-dot ready" /><span className="archive-mono text-[10px] tracking-[.14em] text-[#53656b]">LOADING SECURE SESSION</span></div></div>;
}

function LandingPage() {
  return <main className="archive-grid min-h-[100dvh] overflow-hidden px-5 py-8 md:px-12 md:py-12"><div className="mx-auto flex min-h-[calc(100dvh-6rem)] max-w-6xl flex-col"><header className="flex items-center justify-between"><Link href="/" className="flex items-center gap-3" data-testid="link-landing-logo"><div className="grid h-10 w-10 place-items-center border border-[#f4b942] bg-[#1d2b38] text-[#f4b942]"><Archive size={20} strokeWidth={1.7} /></div><div><div className="archive-display text-[16px] font-extrabold tracking-[.12em] text-[#1d2b38]">ARCHIVE</div><div className="archive-mono text-[8px] tracking-[.28em] text-[#71858a]">ASSISTANT / LOCAL</div></div></Link><div className="archive-mono flex items-center gap-2 text-[9px] tracking-[.12em] text-[#71858a]"><span className="status-dot ready" /> PRIVATE BY DEFAULT</div></header><section className="grid flex-1 items-center gap-12 py-16 lg:grid-cols-[1.05fr_.95fr] lg:gap-20"><div className="archive-fade"><div className="archive-mono mb-5 text-[10px] font-medium tracking-[.22em] text-[#4e9690]">PERSONAL MEDIA / CONTROL SYSTEM</div><h1 className="archive-display max-w-2xl text-5xl font-extrabold leading-[.98] tracking-[-.05em] text-[#1d2b38] md:text-7xl">Keep the signal.<br /><span className="text-[#4e9690]">Lose the noise.</span></h1><p className="mt-7 max-w-xl text-[15px] leading-7 text-[#65777d]">A local-first command center for inspecting, downloading, processing, and preserving the media that matters to you.</p><div className="mt-9 flex flex-wrap items-center gap-3"><Link href="/sign-in" className="bg-[#1d2b38] px-5 py-3.5 text-[11px] font-bold tracking-[.13em] text-[#f5f6f3] transition-colors hover:bg-[#263b4a]" data-testid="link-landing-sign-in">SIGN IN <ArrowUpRight size={14} className="ml-2 inline" /></Link><Link href="/sign-up" className="border border-[#b9cbc7] bg-white/55 px-5 py-3.5 text-[11px] font-bold tracking-[.13em] text-[#39736e] transition-colors hover:border-[#4e9690] hover:bg-[#eaf3ef]" data-testid="link-landing-sign-up">CREATE ACCOUNT</Link></div></div><div className="relative"><div className="absolute -inset-8 bg-[#dcebe7]/50 blur-3xl" /><div className="archive-panel relative overflow-hidden p-6 md:p-8"><div className="absolute right-0 top-0 h-1 w-28 bg-[#f4b942]" /><div className="mb-7 flex items-center justify-between"><div><div className="archive-mono text-[10px] tracking-[.16em] text-[#7f9194]">LOCAL NODE / READY</div><h2 className="archive-display mt-1 text-2xl font-extrabold text-[#263844]">Your archive, observed.</h2></div><ShieldCheck size={23} className="text-[#4e9690]" /></div><div className="space-y-3">{[['01', 'Inspect sources', 'Metadata and quality, before action'], ['02', 'Queue downloads', 'Durable jobs with honest progress'], ['03', 'Verify files', 'Safe movement into your library']].map(([number, title, copy]) => <div key={number} className="flex gap-4 border-t border-[#e3e8e7] py-4"><span className="archive-mono text-[10px] text-[#f0aa2a]">{number}</span><div><div className="text-[13px] font-bold text-[#43545b]">{title}</div><div className="mt-1 text-[11px] text-[#879599]">{copy}</div></div><Check size={15} className="ml-auto mt-1 text-[#4e9690]" /></div>)}</div><div className="mt-5 border-l-2 border-[#f4b942] bg-[#fff8e7] p-3 text-[11px] leading-5 text-[#80652e]">Sign in to access your private local control room.</div></div></div></section><footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[#d8e1de] pt-5 archive-mono text-[9px] tracking-[.1em] text-[#9aa7a7]"><span>ARCHIVE ASSISTANT / WINDOWS-FIRST</span><span>AUTHENTICATED WORKSPACE</span></footer></div></main>;
}

function SignInPage() {
  return <div className="flex min-h-[100dvh] items-center justify-center bg-[#f3f5f4] px-4 py-8"><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} /></div>;
}

function SignUpPage() {
  return <div className="flex min-h-[100dvh] items-center justify-center bg-[#f3f5f4] px-4 py-8"><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} /></div>;
}

function QueryCacheInvalidator() {
  const { userId } = useAppAuth();
  const previousUserId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (previousUserId.current !== undefined && previousUserId.current !== userId) {
      queryClient.clear();
    }
    previousUserId.current = userId;
  }, [userId]);
  return null;
}

function HomeRedirect() {
  const { isLoaded, isSignedIn } = useAppAuth();
  if (!isLoaded) return <AuthLoading />;
  return isSignedIn ? <Redirect to="/user-portal" /> : <LandingPage />;
}

function Workspace() {
  const [location] = useLocation();
  const { isLoaded, isSignedIn } = useAppAuth();
  if (!isLoaded) return <AuthLoading />;
  if (!isSignedIn) return <Redirect to="/" />;
  return <ErrorBoundary resetKey={location}><AppShell><Switch><Route path="/user-portal" component={Home} /><Route path="/assistant"><PlaceholderPage section="ASSISTANT" /></Route><Route path="/queue" component={QueuePage} /><Route path="/archive" component={ArchivePage} /><Route path="/discovery" component={DiscoveryPage} /><Route path="/plex" component={PlexPage} /><Route path="/sources" component={SourcePage} /><Route path="/history" component={HistoryPage} /><Route path="/settings" component={SettingsPage} /><Route component={NotFound} /></Switch></AppShell></ErrorBoundary>;
}

function Router() {
  if (authMode === 'local') {
    return <Switch><Route path="/" component={HomeRedirect} /><Route component={Workspace} /></Switch>;
  }
  return <Switch><Route path="/" component={HomeRedirect} /><Route path="/sign-in/*?" component={SignInPage} /><Route path="/sign-up/*?" component={SignUpPage} /><Route component={Workspace} /></Switch>;
}

function ClerkApp() {
  const [, setLocation] = useLocation();
  const stripBase = (path: string) => basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path;
  if (!clerkPubKey) throw new Error('Clerk mode requires a publishable key.');
  return <ClerkProvider publishableKey={clerkPubKey} proxyUrl={clerkProxyUrl} appearance={clerkAppearance} signInUrl={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} localization={{ signIn: { start: { title: 'Welcome back', subtitle: 'Sign in to your private archive workspace' } }, signUp: { start: { title: 'Create your archive account', subtitle: 'Start building a trusted local media archive' } } }} routerPush={(to) => setLocation(stripBase(to))} routerReplace={(to) => setLocation(stripBase(to), { replace: true })}><ClerkAuthBridge><ApplicationProviders /></ClerkAuthBridge></ClerkProvider>;
}

function ApplicationProviders() {
  return <QueryClientProvider client={queryClient}><QueryCacheInvalidator /><TooltipProvider><Router /><Toaster /></TooltipProvider></QueryClientProvider>;
}

function LocalApp() {
  return <AppAuthContext.Provider value={{ mode: 'local', userId: '__local__', isLoaded: true, isSignedIn: true, email: 'Local operator', initials: 'LO', signOut: () => undefined }}><ApplicationProviders /></AppAuthContext.Provider>;
}

function App() {
  return <WouterRouter base={basePath}>{authMode === 'clerk' ? <ClerkApp /> : <LocalApp />}</WouterRouter>;
}

export default App;

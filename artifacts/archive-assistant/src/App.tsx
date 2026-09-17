import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ClerkProvider, SignIn, SignUp, useAuth, useClerk, useUser } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import {
  Activity, Archive, ArrowDownToLine, ArrowUpRight, Bot, Check, ChevronRight, CircleHelp,
  CloudOff, Compass, Cpu, Download, FileCheck2, FolderOpen, HardDrive, History,
  Library, Link2, Menu, Network, Pause, Play, PlaySquare, RefreshCw, RotateCcw,
  Save, Search, Settings as SettingsIcon, ShieldCheck, SlidersHorizontal,
  Sparkles, Square, Terminal, Trash2, X, Zap,
} from 'lucide-react';
import {
  getGetDownloadsQueryKey, getGetPlexConfigQueryKey, getGetPlexInventoryQueryKey, getGetSettingsQueryKey, getGetSystemEventsQueryKey,
  getGetSystemOverviewQueryKey, getGetWebhookSecretStatusesQueryKey, useCancelDownload, useDeleteDownload,
  useGetDownloads, useGetPlexConfig, useGetPlexInventory, useGetSettings, useGetSystemDependencies,
  useGetWebhookSecretStatuses, useReplaceWebhookSecret,
  useGetSystemEvents, useGetSystemOverview, useGetAssistantOverview, useResearchAssistantCandidate, useResearchFromViewingHistory, useEvaluateViewingResearch, useSynthesizeViewingResearch, useReadPersonalCuration, useReadPersonalReasoning, useReadMediaProfile, useHealthCheck,
  usePauseDownload, usePrepareDownload, useRetryDownload, useResumeDownload,
  useStartDownload, useStartPlexSync, useTestPlexConnection, useUpdatePlexConfig, useUpdateSettings,
  useGetArchiveScan, useStartArchiveScan, useGetArchiveInventory, useGetArchiveRecord, useGetArchiveNamingProposals,
  useDiscoverArchiveMissingMedia, getDiscoverArchiveMissingMediaQueryKey,
  useUpdateArchiveRecordReview, useUpdateArchiveRecordReviews, getGetArchiveScanQueryKey, getGetArchiveInventoryQueryKey,
  getGetArchiveRecordQueryKey,
  useListAcquisitionRecommendations, useGenerateAcquisitionRecommendations, useListReviewItems,
  useApproveReviewQueueItem, useRejectReviewQueueItem, useDeferReviewQueueItem, useReopenReviewQueueItem,
  useCreateApprovedAcquisitionJob, useListArchiveOperations, useGetIntegrationStatuses,
  useSyncControlPlaneReviewItems, useCreateArchiveOperation, usePreflightArchiveOperation,
  useExecuteArchiveOperation, useCancelArchiveOperation, useRetryArchiveOperation,
  useRollbackArchiveOperation, useGetAcquisitionJobs, useLinkAcquisitionDownload,
  usePlanApprovedAcquisitionImport, useRefreshAcquisitionJob,
} from '@workspace/api-client-react';
import type { AcquisitionProvider, AppSettings, AppSettingsUpdate, DownloadJob, MediaFormat, MediaInspection, MissingMediaItem, ReviewSyncResult, RotateWebhookSecretBody, SystemEvent, WebhookSecretStatus } from '@workspace/api-client-react';
import { apiUrl } from '@/lib/desktop-api-base-url';
import { ErrorBoundary } from '@/components/error-boundary';
import { ArchiveAcquisitionPanel, type ArchiveAcquisitionTarget } from '@/components/archive-acquisition-panel';
import { ArchiveScanPanel } from '@/components/archive-scan-panel';
import { VisualMediaLibrary } from '@/components/visual-media-library';
import { StorageDiagnosticsPanel } from './components/storage-diagnostics-panel';
import { WorkloadSummary } from './components/workload-summary';
import { AcquisitionJobsPanel } from '@/components/acquisition-jobs-panel';
import { useArchiveScanEvents } from '@/hooks/use-archive-scan-events';
import { resolveScanLifecycle } from '@/lib/scan-lifecycle';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import DiscoverPage from '@/pages/discover';
import WorkloadDetailPage from '@/pages/workload-detail';
import IntelligentOrderingPage from '@/pages/intelligent-ordering';
import ArchiveHealthPage from '@/pages/archive-health';
import SourcesPage from '@/pages/sources';
import JellyfinPage from '@/pages/jellyfin';
import MonitoringPage from '@/pages/monitoring';
import { Link, Redirect, Route, Router as WouterRouter, Switch, useLocation } from 'wouter';

const queryClient = new QueryClient();
const navItems = [
  { label: 'HOME', href: '/user-portal', icon: Activity }, { label: 'ASSISTANT', href: '/assistant', icon: Bot }, { label: 'DISCOVER', href: '/discover', icon: Compass },
  { label: 'QUEUE', href: '/queue', icon: Download }, { label: 'ARCHIVE', href: '/archive', icon: Archive },
  { label: 'PLEX', href: '/plex', icon: PlaySquare }, { label: 'JELLYFIN', href: '/jellyfin', icon: PlaySquare }, { label: 'SOURCES', href: '/sources', icon: FolderOpen }, { label: 'MONITORING', href: '/monitoring', icon: RefreshCw },
  { label: 'HISTORY', href: '/history', icon: History }, { label: 'SETTINGS', href: '/settings', icon: SettingsIcon },
];
const authMode = import.meta.env.VITE_AUTH_MODE === 'clerk' ? 'clerk' : 'local';
const clerkPubKey = authMode === 'clerk'
  ? publishableKeyFromHost(window.location.hostname, import.meta.env.VITE_CLERK_PUBLISHABLE_KEY)
  : null;
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
// The API base URL is configured in main.tsx before this module is imported.
// It cannot be read at module scope here: the desktop shell injects it only
// after its sidecar is ready, which is long after these modules evaluate.

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
  error: 'ERROR', queued: 'WAITING TO START', inspecting: 'CHECKING THE SOURCE',
  downloading: 'DOWNLOADING', downloaded: 'DOWNLOADED', verifying: 'CHECKING THE FILE', moving: 'PUTTING IT IN YOUR ARCHIVE',
  complete: 'DONE AND VERIFIED', failed: 'FAILED — NOTHING CONFIRMED', cancelled: 'CANCELLED', paused: 'PAUSED',
  recovery_required: 'NEEDS A LOOK',
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
function humanJobPhase(status: string | undefined) {
  if (status === 'queued') return 'Waiting to start';
  if (status === 'inspecting') return 'Checking the source';
  if (status === 'downloading') return 'Downloading the file';
  if (status === 'downloaded') return 'Download finished; archive change is not confirmed';
  if (status === 'processing') return 'Preparing the downloaded file';
  if (status === 'verifying') return 'Checking the downloaded file';
  if (status === 'moving') return 'Putting the file in your archive';
  if (status === 'complete') return 'Downloaded and verified';
  if (status === 'failed') return 'The download failed; review what changed before retrying';
  if (status === 'recovery_required') return 'Something needs review before continuing';
  if (status === 'paused') return 'Paused; waiting for you to resume';
  if (status === 'cancelled') return 'Cancelled; no completion was recorded';
  return 'The system is handling this';
}
function errorText(error: unknown) {
  if (!error) return 'The local node did not accept the request.';
  if (typeof error === 'object' && error && 'message' in error) return String((error as { message?: string }).message);
  return 'The local node did not accept the request.';
}
function StatusPill({ status, label }: { status?: string; label?: string }) {
  return <span className="inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-white/70 px-2.5 py-1 text-[10px] font-bold tracking-[.1em] text-[#53636a]" data-testid={`status-${label?.toLowerCase().replace(/\s/g, '-') ?? status}`}><span className={`status-dot ${status ?? 'idle'}`} />{label ?? statusText(status)}</span>;
}
function Skeleton({ className = '' }: { className?: string }) { return <div className={`animate-pulse rounded bg-[#dfe6e5] ${className}`} />; }
function ErrorState({ title, message, onRetry, testId }: { title: string; message: string; onRetry?: () => void; testId?: string }) {
  return <section className="archive-panel p-6" data-testid={testId ?? 'panel-error-state'}><h2 className="archive-display text-xl font-extrabold text-[#263844]">{title}</h2><p className="mt-2 text-[12px] text-[#718187]">{message}</p>{onRetry && <button type="button" onClick={onRetry} className="mt-4 border border-[#d7e1de] px-3 py-2 text-[10px] font-bold tracking-[.1em] text-[#39736e]">TRY AGAIN</button>}</section>;
}
const placeholderCopy = {
  assistant: { eyebrow: 'ASSISTANT', title: 'Assistant', description: 'A read-only space for understanding what the archive knows.', icon: Bot },
  discover: { eyebrow: 'DISCOVER', title: 'Discover', description: 'Provider-backed discovery is reserved for a later surface.', icon: Compass },
  queue: { eyebrow: 'QUEUE', title: 'Queue', description: 'Queued work is shown only when durable state exists.', icon: Download },
  archive: { eyebrow: 'ARCHIVE', title: 'Archive', description: 'Archive inventory remains grounded in local records.', icon: Archive },
  plex: { eyebrow: 'PLEX', title: 'Plex', description: 'Provider state is shown only when it is available.', icon: PlaySquare },
  sources: { eyebrow: 'SOURCES', title: 'Sources', description: 'Source configuration is shown only when it is available.', icon: FolderOpen },
  history: { eyebrow: 'HISTORY', title: 'History', description: 'History is grounded in recorded events.', icon: History },
  settings: { eyebrow: 'SETTINGS', title: 'Settings', description: 'Runtime settings are stored locally.', icon: SettingsIcon },
} as const;

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
  return <div className="archive-shell flex flex-col md:flex-row"><div className={`fixed inset-0 z-30 bg-[#17232d]/45 transition-opacity md:static md:z-auto md:block md:bg-transparent ${menuOpen ? 'block opacity-100' : 'pointer-events-none hidden opacity-0'}`} onClick={() => setMenuOpen(false)} /><div className={`fixed inset-y-0 left-0 z-40 w-[230px] transition-transform md:static md:z-auto md:block md:translate-x-0 ${menuOpen ? 'translate-x-0' : '-translate-x-full'}`}><Sidebar onNavigate={() => setMenuOpen(false)} /></div><main className="min-w-0 flex-1"><Topbar onMenu={() => setMenuOpen(true)} /><div className="archive-grid min-h-[calc(100dvh-73px)] p-5 md:p-8">{children}<footer className="mx-auto mt-8 max-w-6xl border-t border-[#e3e8e7] pt-4 text-[10px] text-[#829095]"><span className="font-semibold text-[#53656b]">Archive Assistant</span> · Your personal media archive, understood. <span className="ml-1">Runs locally. Nothing changes without your approval.</span></footer></div></main></div>;
}
function PageIntro({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="mb-7 flex flex-col justify-between gap-5 md:flex-row md:items-end"><div className="archive-fade"><div className="archive-mono mb-2 text-[10px] font-medium tracking-[.2em] text-[#7a9093]">{eyebrow}</div><h1 className="archive-display text-3xl font-extrabold text-[#21303d] md:text-[38px]">{title}</h1><p className="mt-2 max-w-xl text-[13px] leading-6 text-[#718087]">{description}</p></div>{action}</div>;
}
function Readout({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'good' | 'warn' | 'neutral' }) {
  return <div className="flex items-center justify-between border-b border-[#e7ecea] pb-3 last:border-0"><span className="text-[#728287]">{label}</span><span className={`archive-mono text-[10px] font-medium ${tone === 'good' ? 'text-[#39736e]' : tone === 'warn' ? 'text-[#a77517]' : 'text-[#8a9899]'}`}>{value}</span></div>;
}
function ActivityRows({ events, emptyLabel = 'No events have been recorded yet.' }: { events?: SystemEvent[]; emptyLabel?: string }) {
  if (!events?.length) return <div className="flex min-h-[160px] flex-col items-center justify-center text-center"><Activity size={20} className="mb-3 text-[#9aa9aa]" /><p className="text-[12px] text-[#829095]">{emptyLabel}</p><p className="mt-1 text-[10px] text-[#a3aeae]">Proven system events will appear here.</p></div>;
  return <div className="divide-y divide-[#e3e8e7]">{events.map((event) => <div key={event.id} className="flex gap-3 py-3 first:pt-0 last:pb-0" data-testid={`row-event-${event.id}`}><span className={`status-dot mt-1.5 ${event.level === 'success' ? 'ready' : event.level === 'warning' ? 'warning' : event.level === 'error' ? 'error' : 'idle'}`} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><div className="text-[12px] leading-5 text-[#43545b]" data-testid={`text-event-message-${event.id}`}>{event.message}</div>{event.retentionClass === 'security' && <span className="archive-mono border border-[#d9bd77] bg-[#fff8e7] px-1.5 py-0.5 text-[8px] font-bold tracking-[.08em] text-[#8d681d]" data-testid={`badge-event-security-${event.id}`}>SECURITY AUDIT</span>}</div><div className="archive-mono mt-1 text-[9px] tracking-[.04em] text-[#97a3a4]">{event.source} / {formatTime(event.timestamp)}{event.operatorId ? ` / operator ${event.operatorId}` : ''}</div></div></div>)}</div>;
}
function MetricCard({ icon: Icon, label, value, status, note, accent = 'teal' }: { icon: typeof Activity; label: string; value: string; status?: string; note: string; accent?: 'teal' | 'amber' | 'red' }) {
  return <div className="archive-panel archive-fade min-h-[146px] p-5 transition-all duration-300 hover:-translate-y-0.5" data-testid={`card-metric-${label.toLowerCase().replace(/\s/g, '-')}`}><div className="mb-5 flex items-start justify-between"><div className={`grid h-8 w-8 place-items-center ${accent === 'amber' ? 'bg-[#fff0c9] text-[#a77517]' : accent === 'red' ? 'bg-[#f7e2de] text-[#a9483e]' : 'bg-[#dcebe7] text-[#39736e]'}`}><Icon size={16} /></div>{status && <StatusPill status={status} />}</div><div className="archive-mono text-[10px] tracking-[.12em] text-[#829197]">{label}</div><div className="archive-display mt-1 text-[25px] font-extrabold tracking-[-.04em] text-[#263844]" data-testid={`text-metric-${label.toLowerCase().replace(/\s/g, '-')}`}>{value}</div><div className="mt-1 text-[11px] text-[#879599]">{note}</div></div>;
}

function Home() {
  const { data: overview, isLoading, isError, refetch } = useGetSystemOverview();
  // Deep assistant analysis is intentionally deferred on Home. The bounded
  // workload summary above is the bootstrap readout; Assistant owns the
  // expensive naming/identity analysis when the operator opens it.
  const assistantOverview = useGetAssistantOverview({ query: { enabled: false, queryKey: ['assistant-overview-deferred'] } });

  if (isLoading) return <><PageIntro eyebrow="ARCHIVE ASSISTANT" title="Your archive, understood" description="Reading what matters right now." /><div className="archive-panel space-y-4 p-6"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-20" /><Skeleton className="h-20" /></div></>;
  if (isError || !overview) return <ErrorState title="The local archive could not be read" message="Nothing has been assumed or filled in. Try the readout again." onRetry={() => refetch()} testId="button-retry-overview" />;

  const actionable = assistantOverview.data?.groups.filter((group) => group.state === 'actionable') ?? [];
  const healthy = assistantOverview.data
    ? assistantOverview.data.summary.health === 'healthy' && actionable.length === 0
    : true;
  const waiting = assistantOverview.data?.summary.blockedCount ?? 0;

  return <>
    <PageIntro eyebrow="ARCHIVE ASSISTANT" title="Your archive, understood" description="Runs locally. Nothing changes without your approval." action={<button onClick={() => { refetch(); assistantOverview.refetch(); }} className="inline-flex items-center gap-2 border border-[var(--line)] bg-white/60 px-3.5 py-2.5 text-[10px] font-bold tracking-[.11em] text-[#5a6d73] hover:border-[#81999a] hover:bg-white" data-testid="button-refresh-overview"><RefreshCw size={14} /> REFRESH</button>} />
    {overview.aiStatus === 'placeholder' && <div className="mb-5 border-l-2 border-[#d9bd77] bg-[#fff8e7] px-4 py-3 text-[11px] text-[#80652e]" data-testid="banner-mock-mode"><div className="archive-mono text-[9px] font-bold tracking-[.12em]">DEMO MODE ACTIVE</div><div className="mt-1">Some results are simulated. Turn off Mock mode in Settings before evaluating your real archive.</div></div>}
    <WorkloadSummary />
    <section className="archive-panel mb-7 p-5 md:p-7" data-testid="panel-home-briefing">
      <div className="archive-mono text-[9px] tracking-[.16em] text-[#7f9194]">RIGHT NOW</div>
      <h2 className="archive-display mt-2 text-2xl font-extrabold text-[#263844]" data-testid="text-home-attention">{healthy ? 'Everything looks good.' : `${actionable.length} thing${actionable.length === 1 ? '' : 's'} need your attention.`}</h2>
      <p className="mt-2 max-w-xl text-[12px] leading-5 text-[#718187]">{healthy ? 'Nothing important needs your attention right now.' : 'Here is what matters most. Review the explanation before deciding.'}</p>
      {actionable.length > 0 ? <div className="mt-6 divide-y divide-[#e3e8e7]">{actionable.slice(0, 3).map((item) => <article key={item.id} className="py-5 first:pt-0 last:pb-0" data-testid={`home-finding-${item.id}`}><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="archive-display text-lg font-extrabold text-[#344851]">{item.title}</h3><p className="mt-1 text-[12px] leading-5 text-[#53656b]">{item.explanation}</p></div><span className="archive-mono text-[9px] font-bold tracking-[.1em] text-[#39736e]">{item.priority.toUpperCase()} PRIORITY</span></div><div className="mt-3 text-[11px] text-[#718187]"><span className="font-semibold text-[#53656b]">Next step:</span> {item.recommendedAction}</div><div className="mt-4 flex flex-wrap gap-3"><Link href="/archive/health" className="inline-flex items-center gap-1.5 bg-[#1d2b38] px-3.5 py-2.5 text-[10px] font-bold tracking-[.1em] text-white">UNDERSTAND FINDING <ArrowUpRight size={13} /></Link><Link href="/assistant" className="inline-flex items-center gap-1.5 border border-[#d7e1de] px-3.5 py-2.5 text-[10px] font-bold tracking-[.1em] text-[#39736e]">OPEN DECISION FLOW <ArrowUpRight size={13} /></Link></div><details className="mt-4"><summary className="cursor-pointer text-[10px] font-bold tracking-[.1em] text-[#39736e]">SHOW WHY AND EVIDENCE</summary><div className="mt-3 border-l-2 border-[#d9bd77] bg-[#fff8e7] p-3 text-[11px] leading-5 text-[#80652e]">{item.explanation}<div className="mt-1 text-[#9a7c35]">{item.itemCount} related item{item.itemCount === 1 ? '' : 's'} · evidence preserved</div></div></details></article>)}</div> : <div className="mt-6 border-l-2 border-[#4e9690] bg-[#f1f7f5] p-4" data-testid="panel-home-healthy"><div className="text-[13px] font-semibold text-[#39736e]">Nothing needs your attention.</div><div className="mt-1 text-[11px] text-[#56736f]">The archive is being observed. New findings will appear here when there is something meaningful to decide.</div></div>}
      {waiting > 0 && <div className="mt-6 border-t border-[#e3e8e7] pt-4 text-[11px] text-[#82765d]"><span className="font-semibold">{waiting} thing{waiting === 1 ? '' : 's'} waiting.</span> Nothing will change until the missing condition is understood.</div>}
    </section>
    <div className="flex flex-wrap gap-3 text-[10px] text-[#718187]"><Link href="/archive/health" className="font-semibold text-[#39736e]">View Archive Health <ArrowUpRight size={12} className="inline" /></Link><Link href="/assistant" className="font-semibold text-[#39736e]">Understand and decide <ArrowUpRight size={12} className="inline" /></Link><Link href="/history" className="font-semibold text-[#39736e]">See what happened <ArrowUpRight size={12} className="inline" /></Link></div>
  </>;
}

function QueuePage() {
  const queryClient = useQueryClient(); const { data: jobs, isLoading, isError, refetch } = useGetDownloads(); const [notice, setNotice] = useState('');
  const start = useStartDownload(); const pause = usePauseDownload(); const resume = useResumeDownload(); const cancel = useCancelDownload(); const retry = useRetryDownload(); const remove = useDeleteDownload();
  useEffect(() => { const source = new EventSource(apiUrl('/api/downloads/events')); const invalidate = () => { queryClient.invalidateQueries({ queryKey: getGetDownloadsQueryKey() }); queryClient.invalidateQueries({ queryKey: getGetSystemOverviewQueryKey() }); }; ['message', 'download', 'job.created', 'job.updated', 'job.completed', 'job.finished'].forEach((eventName) => source.addEventListener(eventName, invalidate)); source.onerror = () => { queryClient.invalidateQueries({ queryKey: getGetDownloadsQueryKey() }); }; return () => source.close(); }, [queryClient]);
  const persist = (mutation: { mutate: (data: { id: number }, options: { onSuccess: () => void; onError: (error: unknown) => void }) => void }, id: number, message: string) => mutation.mutate({ id }, { onSuccess: () => { setNotice(message); queryClient.invalidateQueries({ queryKey: getGetDownloadsQueryKey() }); queryClient.invalidateQueries({ queryKey: getGetSystemOverviewQueryKey() }); }, onError: (error) => setNotice(errorText(error)) });
  const action = (job: DownloadJob, kind: 'start' | 'pause' | 'resume' | 'cancel' | 'retry' | 'delete') => { if (kind === 'delete') { if (window.confirm(`Delete job #${job.id}? This only removes the job record.`)) persist(remove, job.id, `Job #${job.id} deleted.`); return; } if (kind === 'start') persist(start, job.id, `Job #${job.id} started.`); if (kind === 'pause') persist(pause, job.id, `Job #${job.id} paused.`); if (kind === 'resume') persist(resume, job.id, `Job #${job.id} resumed.`); if (kind === 'cancel') persist(cancel, job.id, `Job #${job.id} cancelled.`); if (kind === 'retry') persist(retry, job.id, `Job #${job.id} queued for retry.`); };
  if (isLoading) return <><PageIntro eyebrow="INGEST / PERSISTENT QUEUE" title="Download queue" description="Reading durable jobs from the local node." /><div className="space-y-3"><Skeleton className="h-32" /><Skeleton className="h-32" /><Skeleton className="h-32" /></div></>;
  if (isError) return <ErrorState title="Queue read failed" message="The persistent job list could not be read. No local queue state is being invented." onRetry={() => refetch()} testId="button-retry-queue" />;
  return <><PageIntro eyebrow="INGEST / PERSISTENT QUEUE" title="Download queue" description="What is already happening. Every status below is returned by the backend, not simulated in the browser." /><WorkloadSummary compact />{notice && <div className="mb-4 border-l-2 border-[#4e9690] bg-[#eaf3ef] p-3 text-[11px] text-[#39736e]" data-testid="status-queue-operation">{notice}</div>}<div className="mb-4 flex flex-wrap gap-2 archive-mono text-[9px] tracking-[.08em] text-[#7d8d90]"><span className="border border-[#d8e1de] bg-white/60 px-2 py-1">{jobs?.filter((job) => ['downloading', 'processing', 'verifying', 'moving'].includes(job.status)).length ?? 0} ACTIVE</span><span className="border border-[#d8e1de] bg-white/60 px-2 py-1">{jobs?.filter((job) => job.status === 'queued').length ?? 0} QUEUED</span><span className="border border-[#d8e1de] bg-white/60 px-2 py-1">{jobs?.length ?? 0} TOTAL</span></div>{jobs?.length ? <div className="space-y-3">{jobs.map((job) => <QueueRow key={job.id} job={job} onAction={action} />)}</div> : <div className="archive-panel flex min-h-[330px] flex-col items-center justify-center p-8 text-center"><Download size={28} className="mb-4 text-[#4e9690]" /><h2 className="archive-display text-2xl font-extrabold">Queue is clear</h2><p className="mt-2 max-w-sm text-[13px] leading-6 text-[#7d8c8f]">No persistent jobs are waiting. Start from a configured source when you are ready to queue real media.</p></div>}</>;
}
function QueueRow({ job, onAction }: { job: DownloadJob; onAction: (job: DownloadJob, kind: 'start' | 'pause' | 'resume' | 'cancel' | 'retry' | 'delete') => void }) {
  const active = ['downloading', 'processing', 'verifying', 'moving', 'inspecting'].includes(job.status); const canStart = job.status === 'queued'; const canPause = ['downloading', 'processing'].includes(job.status); const canResume = job.status === 'paused'; const canCancel = ['queued', 'inspecting', 'downloading', 'processing', 'verifying', 'moving', 'paused'].includes(job.status); const canRetry = ['failed', 'recovery_required'].includes(job.status);
  return <article className="archive-panel p-4 md:p-5" data-testid={`row-download-${job.id}`}><div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><StatusPill status={job.status} /><span className="archive-mono text-[9px] text-[#9aa6a7]">JOB {job.id}</span>{job.verification === 'passed' && <span className="inline-flex items-center gap-1 text-[9px] font-bold tracking-[.08em] text-[#39736e]"><ShieldCheck size={12} /> VERIFIED</span>}</div><div className="flex items-center gap-2"><h2 className="mt-2 truncate text-[15px] font-bold text-[#344851]" title={job.title} data-testid={`text-download-title-${job.id}`}>{job.title}</h2><Link href={`/workload/${encodeURIComponent(`download:${job.id}`)}?from=queue`} className="shrink-0 text-[9px] font-bold tracking-[.08em] text-[#39736e]">FULL STORY</Link></div><div className="mt-1 truncate text-[10px] text-[#8a989a]" title={job.sourceUrl}>{job.finalFilename}</div><div className="mt-1 text-[10px] text-[#829095]">The system will verify the file before calling this complete.</div></div><div className="flex flex-wrap gap-2">{canStart && <JobButton icon={Play} label="START" onClick={() => onAction(job, 'start')} testId={`button-start-download-${job.id}`} />}{canPause && <JobButton icon={Pause} label="PAUSE" onClick={() => onAction(job, 'pause')} testId={`button-pause-download-${job.id}`} />}{canResume && <JobButton icon={Play} label="RESUME" onClick={() => onAction(job, 'resume')} testId={`button-resume-download-${job.id}`} />}{canCancel && <JobButton icon={Square} label="CANCEL" onClick={() => onAction(job, 'cancel')} testId={`button-cancel-download-${job.id}`} />}{canRetry && <JobButton icon={RotateCcw} label="RETRY" onClick={() => onAction(job, 'retry')} testId={`button-retry-download-${job.id}`} />}{!active && <JobButton icon={Trash2} label="DELETE" onClick={() => onAction(job, 'delete')} testId={`button-delete-download-${job.id}`} danger />}</div></div><div className="mt-5 grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end"><div><div className="mb-2 flex justify-between text-[10px] text-[#7f8e91]"><span>{humanJobPhase(job.status)}</span><span className="archive-mono text-[#4e9690]">{Math.round(job.progress)}%</span></div><div className="h-2 bg-[#e5ece9]"><div className={`h-full origin-left transition-transform duration-500 ${active ? 'bg-[#f4b942]' : job.status === 'complete' ? 'bg-[#4e9690]' : job.status === 'failed' ? 'bg-[#c85b51]' : 'bg-[#9eadae]'}`} style={{ transform: `scaleX(${Math.min(1, Math.max(0, job.progress / 100))})` }} /></div></div><div className="grid grid-cols-2 gap-x-6 gap-y-1 text-right text-[10px] text-[#879598]"><span>{formatBytes(job.downloadedBytes)} / {formatBytes(job.totalBytes)}</span><span>{job.downloadSpeed ? `${formatBytes(job.downloadSpeed)}/s` : 'speed —'}</span><span>{job.etaSeconds ? `${job.etaSeconds}s remaining` : 'ETA —'}</span><span>{formatTime(job.createdAt)}</span></div></div>{job.errorMessage && <div className="mt-4 border-l-2 border-[#c85b51] bg-[#fcedea] p-3 text-[11px] leading-5 text-[#994b43]" data-testid={`text-download-error-${job.id}`}><strong>Something went wrong.</strong><div>{job.errorMessage}</div><div className="mt-1 text-[10px]">This does not confirm that the archive changed. Check the result before trying again.</div></div>}</article>;
}
function JobButton({ icon: Icon, label, onClick, testId, danger = false }: { icon: typeof Play; label: string; onClick: () => void; testId: string; danger?: boolean }) {
  return <button onClick={onClick} className={`inline-flex items-center gap-1.5 border px-2.5 py-2 text-[9px] font-bold tracking-[.08em] ${danger ? 'border-[#efd3cf] text-[#a34d45] hover:bg-[#fcedea]' : 'border-[#d7e1de] bg-white/70 text-[#607379] hover:border-[#8fb3ac] hover:text-[#39736e]'}`} data-testid={testId}><Icon size={12} />{label}</button>;
}

function HistoryPage() {
  const { data: jobs, isLoading: jobsLoading, isError: jobsError, refetch } = useGetDownloads(); const { data: events, isLoading: eventsLoading } = useGetSystemEvents(); const [tab, setTab] = useState<'jobs' | 'events'>('jobs');
  const history = jobs?.filter((job) => ['complete', 'failed', 'cancelled', 'recovery_required'].includes(job.status)) ?? [];
  if (jobsLoading) return <><PageIntro eyebrow="AUDIT / HISTORY" title="History" description="Loading completed work and operator signals." /><Skeleton className="h-[420px]" /></>;
  if (jobsError) return <ErrorState title="History read failed" message="Completed work could not be read from the local node." onRetry={() => refetch()} testId="button-retry-history" />;
  return <><PageIntro eyebrow="AUDIT / HISTORY" title="History" description="A factual record of completed, failed, cancelled jobs and system events." action={<div className="flex border border-[#d7e1de] bg-white/50 p-1"><button onClick={() => setTab('jobs')} className={`px-3 py-2 text-[10px] font-bold tracking-[.1em] ${tab === 'jobs' ? 'bg-[#1d2b38] text-[#f5f6f3]' : 'text-[#6c7d81]'}`} data-testid="button-history-jobs">JOBS</button><button onClick={() => setTab('events')} className={`px-3 py-2 text-[10px] font-bold tracking-[.1em] ${tab === 'events' ? 'bg-[#1d2b38] text-[#f5f6f3]' : 'text-[#6c7d81]'}`} data-testid="button-history-events">EVENTS</button></div>} /><WorkloadSummary compact />{tab === 'jobs' ? <section className="archive-panel overflow-hidden" data-testid="panel-download-history">{history.length ? <div className="divide-y divide-[#e3e8e7]">{history.map((job) => <div key={job.id} className="grid gap-3 p-4 md:grid-cols-[1fr_140px_150px] md:items-center md:px-5"><div className="min-w-0"><div className="flex items-center gap-2"><div className="truncate text-[12px] font-semibold text-[#43545b]">{job.title}</div><Link href={`/workload/${encodeURIComponent(`download:${job.id}`)}?from=history`} className="shrink-0 text-[9px] font-bold tracking-[.08em] text-[#39736e]">VIEW FULL STORY</Link></div><div className="mt-1 truncate text-[10px] text-[#8b999c]">{job.finalPath ?? job.finalFilename}</div><div className="mt-1 text-[10px] text-[#718187]">{job.status === 'complete' ? 'Downloaded and verified.' : job.status === 'failed' ? 'The download failed; archive change is not confirmed.' : job.status === 'cancelled' ? 'Cancelled; no completion was recorded.' : 'Review the recorded result before deciding what to do next.'}</div></div><StatusPill status={job.status} /><div className="archive-mono text-[10px] text-[#8b999c]">{formatTime(job.completedAt ?? job.createdAt)}</div></div>)}</div> : <div className="flex min-h-[280px] flex-col items-center justify-center p-8 text-center"><FileCheck2 size={25} className="mb-3 text-[#9aa9aa]" /><h2 className="archive-display text-xl font-extrabold">No terminal jobs yet</h2><p className="mt-2 text-[12px] text-[#829095]">Verified and failed outcomes will remain visible here.</p></div>}</section> : <section className="archive-panel p-5 md:p-6" data-testid="panel-event-history">{<div className="mb-5 border-l-2 border-[#f4b942] bg-[#fff8e7] p-3 text-[10px] leading-5 text-[#80652e]" data-testid="panel-history-retention-policy"><div className="archive-mono text-[9px] font-bold tracking-[.12em]">AUDIT RETENTION POLICY</div><div className="mt-1">Operational events older than 30 days are pruned only for the current operator. Security audit events, including webhook rotations, are retained indefinitely. Webhook secrets are never stored in or exposed by event history.</div></div>}{eventsLoading ? <div className="space-y-3"><Skeleton className="h-10" /><Skeleton className="h-10" /></div> : <ActivityRows events={events} emptyLabel="The event stream is currently empty." />}</section>}</>;
}

function PlaceholderPage({ section }: { section: keyof typeof placeholderCopy }) { const copy = placeholderCopy[section]; const Icon = copy.icon; return <><PageIntro eyebrow={copy.eyebrow} title={copy.title} description={copy.description} /><div className="archive-panel relative flex min-h-[420px] flex-col items-center justify-center overflow-hidden p-8 text-center"><div className="absolute left-0 top-0 h-1 w-24 bg-[#f4b942]" /><div className="absolute right-8 top-8 archive-mono text-[9px] tracking-[.16em] text-[#a2adae]">RESERVED / NO CLAIMS</div><div className="grid h-16 w-16 place-items-center border border-[#d6dfdc] bg-[#eaf0ed] text-[#4e9690]"><Icon size={27} strokeWidth={1.4} /></div><h2 className="archive-display mt-6 text-[25px] font-extrabold text-[#2b3d46]">Surface is reserved</h2><p className="mt-2 max-w-md text-[13px] leading-6 text-[#7c8a8d]">This workspace is intentionally honest about its current state. No records or capabilities are fabricated in this preview.</p><div className="mt-7 flex items-center gap-2 border border-[#e1e7e5] bg-[#f8faf8] px-3 py-2 archive-mono text-[9px] tracking-[.1em] text-[#799094]"><CircleHelp size={13} /> SAFE TO EXPLORE</div></div></>; }

/**
 * The review sync used to report a single total, which conflated observations
 * with decisions and produced numbers in the tens of thousands on a real
 * archive. Report what the operator actually has to act on, and keep the
 * observations visible as context rather than as a backlog.
 */
export function summariseReviewSync(result: ReviewSyncResult): string {
  const { severity } = result;
  const counts = severity.bySeverity;
  const escalated = (['critical', 'high', 'medium', 'low'] as const)
    .filter((level) => counts[level] > 0)
    .map((level) => `${counts[level]} ${level}`)
    .join(', ');
  const decisions = `${result.archiveFindingItems.toLocaleString()} finding${result.archiveFindingItems === 1 ? '' : 's'} need review`;
  const observations = `${result.informationalFindings.toLocaleString()} informational`;
  const naming = `${result.namingItems.toLocaleString()} naming proposal${result.namingItems === 1 ? '' : 's'}`;
  return escalated
    ? `${decisions} (${escalated}) · ${observations} · ${naming}.`
    : `${decisions} · ${observations} · ${naming}.`;
}

function AssistantPage() {
  const recommendations = useListAcquisitionRecommendations({ status: 'active' });
  const reviews = useListReviewItems();
  const operations = useListArchiveOperations();
  const providers = useGetIntegrationStatuses();
  const generate = useGenerateAcquisitionRecommendations();
  const approve = useApproveReviewQueueItem();
  const reject = useRejectReviewQueueItem();
  const defer = useDeferReviewQueueItem();
  const reopen = useReopenReviewQueueItem();
  const createJob = useCreateApprovedAcquisitionJob();
  const syncReviews = useSyncControlPlaneReviewItems();
  const createOperation = useCreateArchiveOperation();
  const preflightOperation = usePreflightArchiveOperation();
  const executeOperation = useExecuteArchiveOperation();
  const cancelOperation = useCancelArchiveOperation();
  const retryOperation = useRetryArchiveOperation();
  const rollbackOperation = useRollbackArchiveOperation();
  const acquisitionJobs = useGetAcquisitionJobs();
  const downloads = useGetDownloads();
  const linkDownload = useLinkAcquisitionDownload();
  const planImport = usePlanApprovedAcquisitionImport();
  const refreshAcquisition = useRefreshAcquisitionJob();
  const [notice, setNotice] = useState('');
  const refresh = async () => Promise.all([
    recommendations.refetch(),
    reviews.refetch(),
    operations.refetch(),
    providers.refetch(),
    acquisitionJobs.refetch(),
    downloads.refetch(),
  ]);
  const decide = async (itemId: number, next: 'approve' | 'reject' | 'defer' | 'reopen') => {
    const mutation = { approve, reject, defer, reopen }[next];
    await mutation.mutateAsync({ id: itemId, data: {} });
    await refresh();
  };
  const operate = async (operationId: number, next: 'preflight' | 'execute' | 'cancel' | 'retry' | 'rollback') => {
    if ((next === 'execute' || next === 'rollback') && !window.confirm(
      next === 'execute'
        ? 'Execute this approved, successfully preflighted filesystem operation?'
        : 'Roll back this completed filesystem operation?',
    )) return;
    try {
      if (next === 'preflight') await preflightOperation.mutateAsync({ id: operationId });
      if (next === 'execute') await executeOperation.mutateAsync({ id: operationId, data: { confirmed: true } });
      if (next === 'cancel') await cancelOperation.mutateAsync({ id: operationId });
      if (next === 'retry') await retryOperation.mutateAsync({ id: operationId });
      if (next === 'rollback') await rollbackOperation.mutateAsync({ id: operationId, data: { confirmed: true } });
      setNotice(`Operation #${operationId} ${next} completed.`);
      await refresh();
    } catch (error) {
      setNotice(errorText(error));
    }
  };
  // The acquisition back half. Linking and planning are separate deliberate
  // steps, and planning stops at a planned operation: the import is executed
  // through the same preflight and confirmation path as every other mutation.
  const acquire = async (action: () => Promise<unknown>, describe: (result: unknown) => string) => {
    try {
      const result = await action();
      setNotice(describe(result));
      await refresh();
    } catch (error) {
      setNotice(errorText(error));
    }
  };
  const blockedRecommendationIds = new Set((recommendations.data ?? []).filter((item) => item.blockers.length > 0 && item.reviewItemId !== null).map((item) => item.reviewItemId));
  const actionableReviews = (reviews.data ?? []).filter((item) => ['pending', 'reopened'].includes(item.state) && !blockedRecommendationIds.has(item.id));
  const blockedReviews = (reviews.data ?? []).filter((item) => blockedRecommendationIds.has(item.id));
  const pendingCount = actionableReviews.length;
  const blockedCount = (recommendations.data ?? []).filter((item) => item.blockers.length).length;
  const providerItems = providers.data?.integrations ?? [];
  const busy = generate.isPending || syncReviews.isPending || approve.isPending || reject.isPending || defer.isPending || reopen.isPending || createJob.isPending;
  return <>
    <PageIntro
      eyebrow="CONTROL PLANE / ASSISTANT"
      title="Review before action"
      description="Understand what needs a decision, why it matters, and what will happen next. Nothing is auto-approved or moved."
      action={<button disabled={busy} onClick={async () => { await generate.mutateAsync(); const result = await syncReviews.mutateAsync(); setNotice(summariseReviewSync(result)); await refresh(); }} className="inline-flex items-center gap-2 bg-[#1d2b38] px-4 py-2.5 text-[10px] font-bold tracking-[.11em] text-white disabled:opacity-50" data-testid="button-generate-recommendations"><Sparkles size={14} /> EVALUATE CURRENT STATE</button>}
    />
    {notice && <div className="mb-5 border-l-2 border-[#4e9690] bg-[#eaf3ef] px-4 py-3 text-[11px] text-[#39736e]">{notice}</div>}
    <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard icon={Sparkles} label="EVIDENCE ITEMS" value={String(recommendations.data?.length ?? 0)} note={`${blockedCount} need a blocker resolved`} status={blockedCount ? 'warning' : 'ready'} accent="amber" />
      <MetricCard icon={ShieldCheck} label="AWAITING REVIEW" value={String(pendingCount)} note="Explicit operator decisions" status={pendingCount ? 'warning' : 'ready'} />
      <MetricCard icon={Network} label="PROVIDERS READY" value={String(providerItems.filter((item) => item.operational).length)} note={`${providerItems.length} adapters checked`} status="idle" />
      <MetricCard icon={History} label="OPERATIONS" value={String(operations.data?.length ?? 0)} note="Durable audit history" status="idle" />
    </div>
    <div className="grid gap-5 xl:grid-cols-[1.35fr_.8fr]">
      <section className="archive-panel overflow-hidden" data-testid="panel-review-queue">
        <div className="flex items-center justify-between border-b border-[#e3e8e7] px-5 py-4"><div><div className="archive-mono text-[9px] tracking-[.14em] text-[#9a7c35]">APPROVAL QUEUE</div><h2 className="archive-display mt-1 text-lg font-extrabold">Decisions to make</h2></div><StatusPill status={pendingCount ? 'pending' : 'ready'} /></div>
        {actionableReviews.length ? <div className="divide-y divide-[#e3e8e7]">{actionableReviews.map((item) => <article key={item.id} className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><div className="text-[13px] font-bold text-[#354850]">{item.title}</div><Link href={`/workload/${encodeURIComponent(`review:${item.id}`)}?from=assistant`} className="text-[9px] font-bold tracking-[.08em] text-[#39736e]">FULL STORY</Link></div><div className="archive-mono mt-1 text-[9px] tracking-[.1em] text-[#8c999c]">{item.kind.replaceAll('_', ' ')}</div></div><StatusPill status={item.state} /></div>
          {Array.isArray(item.payload.blockers) && item.payload.blockers.length > 0 && <div className="mt-3 border-l-2 border-[#cf695f] bg-[#fff1ef] px-3 py-2 text-[11px] leading-5 text-[#8d4a45]">{item.payload.blockers.map(String).join(' ')}</div>}
          {item.kind === 'acquisition_recommendation' && <div className="mt-3 border-l-2 border-[#4e9690] bg-[#f1f7f5] px-3 py-2 text-[11px] leading-5 text-[#56736f]"><strong>What approval means:</strong> this records your decision. The download is not started by opening or approving this review; a separate job must be created and started. The system will keep its safety checks and verify the file where supported.</div>}
          <div className="mt-4 flex flex-wrap gap-2">
            {['pending', 'reopened'].includes(item.state) && <>
              <button onClick={() => decide(item.id, 'approve')} className="border border-[#5a938a] px-3 py-2 text-[9px] font-bold tracking-[.1em] text-[#39736e]">APPROVE</button>
              <button onClick={() => decide(item.id, 'defer')} className="border border-[#d2b66d] px-3 py-2 text-[9px] font-bold tracking-[.1em] text-[#80652e]">DEFER</button>
              <button onClick={() => decide(item.id, 'reject')} className="border border-[#d79a94] px-3 py-2 text-[9px] font-bold tracking-[.1em] text-[#9b514a]">REJECT</button>
            </>}
            {['approved', 'rejected', 'deferred'].includes(item.state) && <button onClick={() => decide(item.id, 'reopen')} className="border border-[#b8c5c2] px-3 py-2 text-[9px] font-bold tracking-[.1em] text-[#61767a]">REOPEN</button>}
            {item.state === 'approved' && item.kind === 'acquisition_recommendation' && <button onClick={async () => { await createJob.mutateAsync({ id: item.id }); await refresh(); }} className="bg-[#1d2b38] px-3 py-2 text-[9px] font-bold tracking-[.1em] text-white">CREATE / VIEW JOB</button>}
            {item.state === 'approved' && ['naming_proposal', 'archive_finding'].includes(item.kind) && typeof item.payload.sourcePath === 'string' && typeof item.payload.destinationPath === 'string' && item.payload.destinationPath && <button onClick={async () => {
              await createOperation.mutateAsync({ data: {
                action: item.payload.action === 'rename' ? 'rename' : 'move',
                sourceKind: item.kind,
                sourceId: String(item.payload.fileRecordId ?? item.id),
                sourcePath: item.payload.sourcePath as string,
                destinationPath: item.payload.destinationPath as string,
                reviewItemId: item.id,
              } });
              setNotice(`Approved operation planned from review #${item.id}. Preflight is still required.`);
              await refresh();
            }} className="bg-[#1d2b38] px-3 py-2 text-[9px] font-bold tracking-[.1em] text-white">PLAN SAFE OPERATION</button>}
          </div>
          {item.decisions.length > 0 && <div className="mt-3 text-[10px] text-[#8b999c]">{item.decisions.length} durable decision{item.decisions.length === 1 ? '' : 's'} · last {formatTime(item.decisions.at(-1)?.createdAt ?? item.updatedAt)}</div>}
        </article>)}</div> : <div className="p-8 text-center text-[12px] text-[#829095]">No review items. Evaluate the current state to reconcile recommendations.</div>}
      </section>
      <div className="space-y-5">
        <section className="archive-panel p-5" data-testid="panel-blocked-review-items"><div className="archive-mono text-[9px] tracking-[.12em] text-[#8d681d]">WAITING / BLOCKED</div><h2 className="archive-display mt-1 text-lg font-extrabold">{blockedReviews.length.toLocaleString()} decisions are waiting on a blocker</h2><p className="mt-2 text-[11px] leading-5 text-[#82765d]">These items remain available as evidence, but approval is not meaningful until their provider or source blocker is resolved.</p></section><section className="archive-panel p-5" data-testid="panel-recommendation-evidence"><div className="archive-mono text-[9px] tracking-[.14em] text-[#7d9093]">RECOMMENDATION EVIDENCE</div><div className="mt-4 space-y-4">{(recommendations.data ?? []).map((recommendation) => <article key={recommendation.id} className="border-t border-[#e3e8e7] pt-3"><div className="flex justify-between gap-3"><div className="text-[11px] font-bold text-[#42545b]">{recommendation.title}</div><span className="archive-mono text-[9px] uppercase text-[#80652e]">{recommendation.priority} / {recommendation.confidence}</span></div><p className="mt-2 text-[10px] leading-5 text-[#66787d]">{String(recommendation.evidence.reason ?? 'Evidence is recorded in the recommendation payload.')}</p>{recommendation.blockers.length > 0 && <ul className="mt-2 list-disc pl-4 text-[10px] leading-5 text-[#9b514a]">{recommendation.blockers.map(blocker => <li key={blocker}>{blocker}</li>)}</ul>}<p className="mt-2 border-l-2 border-[#4e9690] pl-2 text-[10px] leading-5 text-[#39736e]">{recommendation.recommendedAction}</p></article>)}{!(recommendations.data ?? []).length && <p className="text-[11px] text-[#829095]">Evaluate current state to generate deterministic recommendations.</p>}</div></section>
        <section className="archive-panel p-5" data-testid="panel-provider-health"><div className="archive-mono text-[9px] tracking-[.14em] text-[#7d9093]">PROVIDER HEALTH</div><div className="mt-4 space-y-3">{providerItems.map((provider) => <div key={provider.id} className="flex items-center justify-between gap-3 border-t border-[#e3e8e7] pt-3"><div><div className="text-[11px] font-bold text-[#42545b]">{provider.name}</div><div className="mt-1 text-[9px] text-[#8b999c]">{provider.detail}</div></div><StatusPill status={provider.configured ? provider.state : 'not_configured'} /></div>)}</div></section>
        <AcquisitionJobsPanel
          jobs={acquisitionJobs.data ?? []}
          downloads={downloads.data ?? []}
          busy={linkDownload.isPending || planImport.isPending || refreshAcquisition.isPending}
          onLinkDownload={(jobId, downloadJobId) => acquire(
            () => linkDownload.mutateAsync({ id: jobId, data: { downloadJobId } }),
            () => `Acquisition job #${jobId} linked to download #${downloadJobId}.`,
          )}
          onPlanImport={(jobId, destinationPath) => acquire(
            () => planImport.mutateAsync({ id: jobId, data: { destinationPath } }),
            (operation) => `Planned import operation #${(operation as { id: number }).id}. It requires preflight and explicit execution confirmation.`,
          )}
          onRefreshJob={(jobId) => acquire(
            () => refreshAcquisition.mutateAsync({ id: jobId }),
            () => `Refreshed acquisition job #${jobId} from its provider.`,
          )}
        />
        <section className="archive-panel p-5" data-testid="panel-operation-history"><div className="archive-mono text-[9px] tracking-[.14em] text-[#7d9093]">SAFE OPERATIONS</div><div className="mt-4 space-y-3">{(operations.data ?? []).slice(0, 8).map((operation) => <div key={operation.id} className="border-t border-[#e3e8e7] pt-3"><div className="flex items-center justify-between"><span className="text-[11px] font-bold uppercase text-[#42545b]">{operation.action} #{operation.id}</span><StatusPill status={operation.status} /></div><div className="mt-1 truncate text-[9px] text-[#8b999c]">{operation.destinationPath}</div>{operation.errorMessage && <div className="mt-2 text-[10px] text-[#a24d46]">{operation.errorMessage}</div>}<div className="mt-2 flex flex-wrap gap-1">{operation.status === 'planned' && <button onClick={() => operate(operation.id, 'preflight')} className="border px-2 py-1 text-[8px] font-bold">PREFLIGHT</button>}{operation.status === 'ready' && <button onClick={() => operate(operation.id, 'execute')} className="bg-[#1d2b38] px-2 py-1 text-[8px] font-bold text-white">EXECUTE</button>}{['planned', 'preflight', 'ready', 'failed'].includes(operation.status) && <button onClick={() => operate(operation.id, 'cancel')} className="border px-2 py-1 text-[8px] font-bold">CANCEL</button>}{['failed', 'cancelled'].includes(operation.status) && operation.retryCount < operation.maxRetries && <button onClick={() => operate(operation.id, 'retry')} className="border px-2 py-1 text-[8px] font-bold">RETRY</button>}{operation.status === 'completed' && <button onClick={() => operate(operation.id, 'rollback')} className="border border-[#d79a94] px-2 py-1 text-[8px] font-bold text-[#9b514a]">ROLLBACK</button>}</div>{operation.events.length > 0 && <details className="mt-2 text-[9px] text-[#75868a]"><summary>{operation.events.length} audit events</summary>{operation.events.map(event => <div key={event.id} className="mt-1">{formatTime(event.createdAt)} · {event.detail}</div>)}</details>}</div>)}{!(operations.data ?? []).length && <p className="text-[11px] leading-5 text-[#829095]">No operations have been planned. Filesystem mutation remains disabled.</p>}</div></section>
      </div>
    </div>
  </>;
}

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

  return <><PageIntro eyebrow="MEDIA HOST / PLEX" title="What Plex knows" description="A trusted view of the media host's current inventory." action={<StatusPill status={data.configured ? data.status : 'not_configured'} label={data.configured ? statusText(data.status) : 'NOT CONFIGURED'} />} /><section className="archive-panel mb-5 border-l-2 border-[#4e9690] p-5 md:p-7" data-testid="panel-plex-briefing"><div className="flex flex-wrap items-start justify-between gap-4"><div><div className="archive-mono text-[9px] tracking-[.16em] text-[#7f9194]">PLEX / CURRENT READOUT</div><h2 className="archive-display mt-2 text-2xl font-extrabold text-[#263844]">{isConnected ? 'Plex is connected.' : isConfigured ? 'Plex is configured but not connected.' : 'Plex is not connected yet.'}</h2><p className="mt-2 text-[12px] leading-5 text-[#718187]">{data.libraryCount ? `${data.libraryCount} librar${data.libraryCount === 1 ? 'y' : 'ies'} · ${data.itemCount.toLocaleString()} items currently known.` : 'Connect Plex to compare what it knows with your local archive.'}</p>{data.lastSuccessfulSyncAt && <p className="mt-1 text-[11px] text-[#829095]">Last checked {formatTime(data.lastSuccessfulSyncAt)}.</p>}</div><div className="flex flex-wrap gap-2"><button type="button" onClick={handleTestConnection} disabled={!data.configured || testConn.isPending || isSyncing} className="border border-[#d6dfdc] bg-white/70 px-3 py-2 text-[10px] font-bold tracking-[.08em] text-[#53656b] disabled:opacity-50" data-testid="button-test-connection">{testConn.isPending ? 'CHECKING' : 'TEST CONNECTION'}</button><button type="button" onClick={handleStartSync} disabled={!canSync || startSync.isPending || isSyncing} className="bg-[#39736e] px-3 py-2 text-[10px] font-bold tracking-[.08em] text-white disabled:opacity-50" data-testid="button-start-sync">{isSyncing ? 'SYNCING' : 'SYNC INVENTORY'}</button></div></div></section><details className="mb-5"><summary className="cursor-pointer archive-panel p-4 text-[10px] font-bold tracking-[.1em] text-[#39736e]">CONNECTION SETTINGS AND TECHNICAL DETAILS</summary><div className="grid gap-5 pt-4 xl:grid-cols-[1fr_330px]"><form className="archive-panel p-5 md:p-7" data-testid="panel-plex-form" onSubmit={(event) => { event.preventDefault(); save(); }}><div className="mb-7 flex items-start gap-3 border-b border-[#e3e8e7] pb-5"><div className="grid h-9 w-9 place-items-center bg-[#fff0c9] text-[#a77517]"><PlaySquare size={18} /></div><div><h2 className="archive-display text-lg font-extrabold">Server endpoint</h2><p className="mt-1 text-[11px] text-[#859296]">Credentials stay on the local API</p></div></div><label className="mb-5 block"><span className="archive-mono mb-2 block text-[10px] tracking-[.1em] text-[#6e8185]">SERVER URL</span><div className="flex items-center border border-[#d6dfdc] bg-[#fbfcfa] focus-within:border-[#4e9690]"><Link2 size={15} className="ml-3 text-[#8a9b9e]" /><input autoComplete="url" value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="http://localhost:32400" className="w-full bg-transparent px-3 py-3 text-[13px] outline-none" data-testid="input-plex-server-url" /></div></label><label className="block"><span className="archive-mono mb-2 block text-[10px] tracking-[.1em] text-[#6e8185]">PLEX TOKEN <span className="text-[#a7b0b0]">/ OPTIONAL UPDATE</span></span><input autoComplete="current-password" type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder={data.hasToken ? 'Token is stored — enter to replace' : 'Paste token when ready'} className="w-full border border-[#d6dfdc] bg-[#fbfcfa] px-3 py-3 text-[13px] outline-none focus:border-[#4e9690]" data-testid="input-plex-token" /></label><div className="mt-7 flex flex-wrap items-center gap-3"><button type="submit" disabled={mutation.isPending || isSyncing} className="inline-flex items-center gap-2 bg-[#1d2b38] px-4 py-3 text-[11px] font-bold tracking-[.1em] text-[#f5f6f3] disabled:opacity-50" data-testid="button-save-plex">{mutation.isPending ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />} {mutation.isPending ? 'SAVING' : 'SAVE CONFIGURATION'}</button>{notice && <span className={`text-[11px] ${notice.includes('failed') || notice.includes('could not') ? 'text-[#c85b51]' : 'text-[#39736e]'}`} data-testid="status-plex-save">{notice}</span>}</div></form><section className="archive-panel h-fit p-5 md:p-6 flex flex-col gap-4" data-testid="panel-plex-status"><div className="archive-mono text-[10px] tracking-[.14em] text-[#7f9194]">NODE CONNECTION</div><h2 className="archive-display text-lg font-extrabold -mt-3">State & Actions</h2><div className="space-y-4 text-[12px]"><Readout label="Endpoint stored" value={data.configured ? 'YES' : 'NO'} tone={data.configured ? 'good' : 'warn'} /><Readout label="Token present" value={data.hasToken ? 'YES' : 'NO'} tone={data.hasToken ? 'good' : 'warn'} /><Readout label="Connection" value={statusText(data.connectionStatus)} tone={data.connectionStatus === 'connection_failed' ? 'warn' : isConnected ? 'good' : 'neutral'} /><Readout label="Synchronization" value={statusText(data.syncStatus)} tone={data.syncStatus === 'sync_error' ? 'warn' : isSynced ? 'good' : 'neutral'} /><Readout label="Libraries" value={String(data.libraryCount)} tone={data.libraryCount ? 'good' : 'neutral'} /><Readout label="Items / media" value={`${data.itemCount} / ${data.mediaCount}`} tone={data.itemCount ? 'good' : 'neutral'} /><Readout label="Last attempted" value={formatTime(data.lastAttemptedAt)} /><Readout label="Last successful" value={formatTime(data.lastSuccessfulSyncAt)} tone={data.lastSuccessfulSyncAt ? 'good' : 'neutral'} /></div><div className="mt-2 flex flex-col gap-2"><button type="button" onClick={handleTestConnection} disabled={!data.configured || testConn.isPending || isSyncing} className="inline-flex justify-center items-center gap-2 border border-[#d6dfdc] bg-white/50 px-4 py-2 text-[10px] font-bold tracking-[.1em] text-[#53656b] disabled:opacity-50 hover:bg-[#eaf0ed] transition-colors" data-testid="button-test-connection">{testConn.isPending ? <RefreshCw size={13} className="animate-spin" /> : <Network size={13} />}{testConn.isPending ? 'VERIFYING' : 'TEST CONNECTION'}</button><button type="button" onClick={handleStartSync} disabled={!canSync || startSync.isPending || isSyncing} className="inline-flex justify-center items-center gap-2 border border-[#4e9690] bg-[#eaf3ef] px-4 py-2 text-[10px] font-bold tracking-[.1em] text-[#39736e] disabled:opacity-50 hover:bg-[#dcebe7] transition-colors" data-testid="button-start-sync">{isSyncing || startSync.isPending ? <RefreshCw size={13} className="animate-spin" /> : <Download size={13} />}{isSyncing ? 'SYNCING INVENTORY' : startSync.isPending ? 'STARTING SYNC' : 'SYNC INVENTORY'}</button></div>{data.lastError && <div className="mt-2 border-l-2 border-[#c85b51] bg-[#fcedea] p-3 text-[11px] leading-5 text-[#994b43]" data-testid="text-plex-error">{data.lastError}</div>}</section></div></details>{showInventory && <section className="mt-7 archive-panel p-5 md:p-7" data-testid="panel-plex-inventory"><div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><div className="archive-mono text-[10px] tracking-[.14em] text-[#7f9194]">LOCAL INVENTORY</div><h2 className="archive-display mt-1 text-2xl font-extrabold text-[#263844]">Synchronized Libraries</h2></div>{data.lastSuccessfulSyncAt && <div className="text-left sm:text-right"><div className="archive-mono text-[10px] tracking-[.12em] text-[#7f9194]">LAST SYNC</div><div className="mt-1 text-[12px] font-semibold text-[#4e9690]">{formatTime(data.lastSuccessfulSyncAt)}</div></div>}</div>{inventoryLoading && !inventory ? <div className="space-y-4"><Skeleton className="h-20" /><Skeleton className="h-20" /></div> : inventory?.libraries?.length ? <div className="space-y-6">{inventory.libraries.map(library => <div key={library.id} className="border border-[#e3e8e7] bg-[#fbfcfa]" data-testid={`library-${library.id}`}><div className="flex items-center justify-between border-b border-[#e3e8e7] bg-[#f3f5f4] px-4 py-3"><div className="flex items-center gap-3"><Library size={16} className="text-[#4e9690]" /><h3 className="text-[13px] font-bold text-[#344851]">{library.name}</h3><span className="archive-mono rounded-sm bg-[#e3e8e7] px-2 py-0.5 text-[9px] tracking-[.1em] text-[#65767a]">{library.type.toUpperCase()}</span></div><div className="archive-mono text-[10px] text-[#7f9194]">{library.itemCount} ITEMS</div></div><div className="grid gap-3 p-4 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">{inventory.items.filter(item => item.libraryId === library.id).slice(0, 8).map(item => <div key={item.id} className="flex gap-3 border border-[#f0f4f3] bg-white p-3 transition-colors hover:border-[#d6dfdc]" data-testid={`inventory-item-${item.id}`}><div className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden bg-[#e8efed] text-[#8ca3a0]">{item.thumbPathAvailable ? <img src={apiUrl(`/api/plex/artwork/${encodeURIComponent(item.ratingKey)}`)} alt="" loading="lazy" className="h-full w-full object-cover" onError={(event) => { event.currentTarget.style.display = 'none'; }} /> : item.itemType === 'movie' ? <PlaySquare size={16} /> : <FolderOpen size={16} />}</div><div className="min-w-0 flex-1"><div className="truncate text-[12px] font-bold text-[#344851]" title={item.title}>{item.title}</div><div className="mt-1 text-[10px] text-[#7f9194]">{item.year ? `${item.year} • ` : ''}{item.itemType}</div><div className="archive-mono mt-1 text-[9px] text-[#a0afaf]">{item.mediaCount} MEDIA / {item.partCount} PARTS</div></div></div>)}{inventory.items.filter(item => item.libraryId === library.id).length > 8 && <div className="flex items-center justify-center border border-dashed border-[#d6dfdc] bg-[#f8faf8] p-3 text-[11px] font-semibold text-[#8ca3a0]">+ {inventory.items.filter(item => item.libraryId === library.id).length - 8} MORE</div>}{inventory.items.filter(item => item.libraryId === library.id).length === 0 && <div className="col-span-full py-4 text-center text-[11px] text-[#8ca3a0]">No items populated in this library.</div>}</div></div>)}</div> : !isSyncing && <div className="flex flex-col items-center justify-center border border-dashed border-[#d6dfdc] bg-[#f8faf8] p-8 text-center text-[#7f9194]"><Library size={24} className="mb-3 text-[#a0afaf]" /><div className="text-[12px] font-semibold">No libraries found</div><div className="mt-1 text-[11px]">The synchronized inventory is empty.</div></div>}</section>}</>;
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
  filename?: string;
  path?: string;
  integrityClassification?: string | null;
  integritySummary?: string | null;
  errorMessage?: string | null;
  qualityStatus: string;
  qualitySummary: string;
  qualityDifferences: string[];
  duplicateOfId: number | null;
  plexMatch: { title: string; year: number | null; qualityDifferences: string[]; providerLabel?: string | null } | null;
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

  if (record.integrityClassification === 'corrupt_or_malformed_container') {
    finding = 'FFprobe classified this file as a corrupt or malformed media container.';
    why = record.integritySummary || 'The archive scan found a container-level media integrity failure.';
    consider = 'Keep the file for investigation, compare it with another source, and do not delete or repair it automatically.';
    assessment = 'MEDIA INTEGRITY / INVESTIGATE';
  } else if (record.integrityClassification === 'inspection_unavailable') {
    finding = 'The archive file was discovered, but FFprobe could not inspect it operationally.';
    why = record.integritySummary || 'The failure may come from access, tooling, or another non-media condition.';
    consider = 'Check the path, permissions, and local FFprobe configuration before treating this as media damage.';
    assessment = 'INSPECTION / INVESTIGATE';
  } else if (record.qualityStatus === 'file_missing') {
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
    const provider = (record.plexMatch.providerLabel || 'Plex').toUpperCase();
    finding = `LOCAL is matched to ${provider} item "${record.plexMatch.title}"${record.plexMatch.year ? ` (${record.plexMatch.year})` : ''}, with quality differences already reported by the system.`;
    if (severity === 'HIGH') {
      why = `A high-impact visual or dynamic-range difference exists between LOCAL and ${provider}.`;
    } else if (severity === 'MEDIUM') {
      why = `A codec difference exists between LOCAL and ${provider} and may affect compatibility or playback characteristics.`;
    } else {
      why = 'The reported differences are limited to lower-impact technical metadata.';
    }
    consider = `Review the supplied LOCAL / ${provider} differences: ${differences.join('; ')}`;
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
export function ArchiveRecordPanel({ id, onClose }: { id: number; onClose: () => void }) {
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

      {record.integrityClassification && (
        <div className={`mt-6 border-l-2 p-4 text-[11px] leading-5 ${record.integrityClassification === 'corrupt_or_malformed_container' ? 'border-[#c85b51] bg-[#fcedea] text-[#994b43]' : 'border-[#d9bd77] bg-[#fff8e7] text-[#80652e]'}`} data-testid="panel-media-integrity">
          <div className="archive-mono mb-3 text-[10px] tracking-[.14em]">
            {record.integrityClassification === 'corrupt_or_malformed_container'
              ? 'ARCHIVE HEALTH / MEDIA INTEGRITY'
              : 'ARCHIVE HEALTH / INSPECTION'}
          </div>
          <div className="font-bold">{record.integritySummary}</div>
          {record.path && <div className="mt-2 break-all"><span className="font-bold">PATH / </span>{record.path}</div>}
          {record.errorMessage && <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words border-t border-current/20 pt-3 font-mono text-[10px]">{record.errorMessage}</pre>}
          <div className="mt-3 text-[10px]">No automatic repair or deletion was attempted.</div>
        </div>
      )}

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
           <div className="archive-mono text-[10px] tracking-[.14em] text-[#7f9194] mb-3">{(record.plexMatch.providerLabel || 'PLEX').toUpperCase()} MATCH</div>
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

export function ArchivePage() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState('');
  const [selectedRecordId, setSelectedRecordId] = useState<number | null>(null);
  const [selectedRecordIds, setSelectedRecordIds] = useState<number[]>([]);
  const [selectedNamingIds, setSelectedNamingIds] = useState<number[]>([]);
  const [powerRenamerBusy, setPowerRenamerBusy] = useState(false);
  const [powerRenamerNotice, setPowerRenamerNotice] = useState<string | null>(null);
  const [bulkNotice, setBulkNotice] = useState('');
  const [bulkFailures, setBulkFailures] = useState<Array<{ id: number; error: string }>>([]);
  const [view, setView] = useState<'library' | 'local' | 'naming_proposals' | 'plex_only' | 'missing_media'>('library');
  const [filter, setFilter] = useState<'all' | 'queue' | 'duplicates' | 'conflicts' | 'integrity' | 'missing' | 'local_only' | 'reviewed' | 'unresolved'>('all');
  const [acquisitionTarget, setAcquisitionTarget] = useState<ArchiveAcquisitionTarget | null>(null);

  const [isScanning, setIsScanning] = useState(false);
  const scanEvents = useArchiveScanEvents({
    onScanStarted: () => {
      queryClient.invalidateQueries({ queryKey: getGetArchiveScanQueryKey() });
    },
    onScanFinished: () => {
      queryClient.invalidateQueries({ queryKey: getGetArchiveScanQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetArchiveInventoryQueryKey() });
    }
  });
  const { data: scan, isLoading: scanLoading, refetch: refetchScan } = useGetArchiveScan({
    query: {
      // Interval polling is only a fallback while the SSE feed is down; the
      // live event stream drives updates when connected.
      refetchInterval: isScanning && !scanEvents.connected ? 2000 : false,
      queryKey: getGetArchiveScanQueryKey()
    }
  });

  // A connected live feed is authoritative about whether a scan is running; a
  // persisted `scanning` with no live session is interrupted residue, not an
  // active scan. Merging the two with OR let the stale record win forever.
  const scanLifecycle = resolveScanLifecycle({
    persistedStatus: scan?.status,
    liveStatus: scanEvents.status,
    liveConnected: scanEvents.connected,
    liveHasSession: Boolean(scanEvents.sessionId),
  });
  const scanInterrupted = scanLifecycle === 'interrupted';

  useEffect(() => {
    const wasScanning = isScanning;
    const nowScanning = scanLifecycle === 'scanning';
    setIsScanning(nowScanning);

    if (wasScanning && !nowScanning) {
      queryClient.invalidateQueries({ queryKey: getGetArchiveInventoryQueryKey() });
    }
  }, [scanLifecycle, isScanning, queryClient]);

  const { data: inventory, isLoading: invLoading, isError: invError, refetch: refetchInv } = useGetArchiveInventory({
    query: {
      refetchInterval: isScanning && !scanEvents.connected ? 3000 : false,
      queryKey: getGetArchiveInventoryQueryKey()
    }
  });

  const { data: namingProposals, isLoading: namingLoading, isError: namingError, refetch: refetchNaming } = useGetArchiveNamingProposals();

  async function planPowerRenamer() {
    if (!selectedNamingIds.length) return;
    setPowerRenamerBusy(true); setPowerRenamerNotice(null);
    try {
      const response = await fetch(apiUrl('/api/archive/power-renamer/plan'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileRecordIds: selectedNamingIds }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Power Renamer could not create a supervised plan.');
      setPowerRenamerNotice(`Plan created for ${result.summary.files} files. Review item ${result.reviewItemId} is pending approval; nothing has changed.`);
      setSelectedNamingIds([]);
    } catch (error) { setPowerRenamerNotice(error instanceof Error ? error.message : 'Power Renamer could not create a plan.'); }
    finally { setPowerRenamerBusy(false); }
  }

  const startScan = useStartArchiveScan();
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
   else if (filter === 'integrity') displayedRecords = records.filter(r => r.integrityClassification === 'corrupt_or_malformed_container' || r.integrityClassification === 'inspection_unavailable');
  else if (filter === 'missing') displayedRecords = records.filter(r => r.scanStatus === 'missing' || r.qualityStatus === 'file_missing');
  else if (filter === 'local_only') displayedRecords = records.filter(r => r.qualityStatus === 'local_only');
  else if (filter === 'reviewed') displayedRecords = records.filter(r => r.reviewStatus === 'reviewed');
  else if (filter === 'unresolved') displayedRecords = records.filter(r => ['unreviewed', 'unresolved'].includes(r.reviewStatus));

  const plexOnly = inventory?.plexOnly ?? [];
  // The reference media server is operator-selected; label the provider-only
  // view with whichever server actually produced the inventory.
  const providerName = (inventory?.providerLabel ?? 'Plex').toUpperCase();
  const showPlex = view === 'plex_only';
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
            {isScanning ? 'SCANNING' : scanInterrupted ? 'RESUME INVENTORY SCAN' : 'START INVENTORY SCAN'}
          </button>
        }
      />

      {notice && (
        <div className={`mb-5 border-l-2 p-3 text-[11px] leading-5 ${notice.includes('failed') || notice.includes('could not') ? 'border-[#c85b51] bg-[#fcedea] text-[#994b43]' : 'border-[#4e9690] bg-[#eaf3ef] text-[#39736e]'}`} data-testid="status-archive-scan">
          {notice}
        </div>
      )}

      {scanInterrupted && (
        <div
          className="mb-5 border-l-2 border-[#d9bd77] bg-[#fff8e7] p-3 text-[11px] leading-5 text-[#80652e]"
          data-testid="status-archive-scan-interrupted"
        >
          The last archive scan stopped before it finished, most likely because the application was
          closed while it was running. {scan?.scannedFiles ? `${scan.scannedFiles.toLocaleString()} files were already examined and ` : 'Files already examined were kept, and '}
          starting a scan will resume from where it stopped rather than beginning again.
        </div>
      )}

      <ArchiveScanPanel live={scanEvents} />

      {scan && <section className="mb-7 border-l-2 border-[#4e9690] bg-[#f1f7f5] p-4" data-testid="panel-archive-readout"><div className="flex flex-wrap items-baseline justify-between gap-3"><div><div className="archive-display text-lg font-extrabold text-[#263844]">{scan.status === 'completed' ? 'Your archive has been checked.' : scan.status === 'not_scanned' ? 'Your archive has not been checked yet.' : scan.status === 'scanning' ? 'Your archive is being checked.' : 'The last archive check needs attention.'}</div><div className="mt-1 text-[11px] text-[#56736f]">{scan.completedAt ? `Last checked ${formatTime(scan.completedAt)}.` : 'Start a scan when you are ready.'}</div></div><span className="archive-mono text-[10px] text-[#39736e]">{scan.activeFiles.toLocaleString()} known files</span></div><details className="mt-4 border-t border-[#c9dfd9] pt-3"><summary className="cursor-pointer text-[10px] font-bold tracking-[.1em] text-[#39736e]">SHOW INVENTORY DETAILS</summary><div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3"><MetricCard icon={FileCheck2} label="ACTIVE FILES" value={String(scan.activeFiles)} note="Verified local media" status={isScanning ? 'processing' : 'ready'} /><MetricCard icon={Activity} label="SCAN FAILURES" value={String(scan.failedFiles)} note={`${inventory?.summary?.integrityFailureCount ?? 0} integrity / ${inventory?.summary?.inspectionFailureCount ?? 0} operational`} accent={scan.failedFiles ? 'red' : 'teal'} status={scan.failedFiles ? 'error' : 'idle'} /><MetricCard icon={ShieldCheck} label="ARCHIVE HEALTH" value={(inventory?.summary?.healthStatus ?? 'healthy').replace('_', ' ').toUpperCase()} note="Pre-existing media findings stay visible" accent={inventory?.summary?.healthStatus === 'attention_required' ? 'amber' : 'teal'} status={inventory?.summary?.healthStatus === 'attention_required' ? 'error' : 'ready'} /><MetricCard icon={Archive} label="MISSING FILES" value={String(scan.missingCount)} note="Known but missing" accent={scan.missingCount ? 'red' : 'teal'} status={scan.missingCount ? 'error' : 'idle'} /><MetricCard icon={Library} label="DUPLICATES" value={String(scan.duplicateCount)} note="Identical files found" accent={scan.duplicateCount ? 'amber' : 'teal'} /><MetricCard icon={Activity} label="QUALITY CONFLICTS" value={String(scan.qualityConflictCount)} note="Multiple versions exist" accent={scan.qualityConflictCount ? 'amber' : 'teal'} /></div></details></section>}

      {view === 'library' && <div className="mb-3 flex justify-end"><button type="button" onClick={() => setView('local')} className="border border-[#d6dfdc] bg-white px-3 py-2 text-[10px] font-bold tracking-[.08em] text-[#53656b] hover:border-[#4e9690]" data-testid="tab-local-inventory">LOCAL REVIEW</button></div>}
      {view === 'library' ? <VisualMediaLibrary onLocalReview={() => setView('local')} /> : <div className={`grid items-start gap-5 ${selectedRecordId || acquisitionTarget ? 'xl:grid-cols-[minmax(0,1fr)_380px]' : 'grid-cols-1'}`}>
        <section className="archive-panel flex min-h-[500px] flex-col" data-testid="panel-archive-list">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#e3e8e7] bg-[#fbfcfa] p-4 md:px-6">
            <div className="flex flex-wrap gap-2">
              <button onClick={() => { setView('library'); setSelectedRecordId(null); setAcquisitionTarget(null); setSelectedRecordIds([]); setBulkNotice(''); setBulkFailures([]); }} className="bg-[#dcebe7] px-3 py-1.5 text-[10px] font-bold tracking-[.1em] text-[#39736e]" data-testid="tab-browse-archive">BROWSE ARCHIVE</button>
              <button onClick={() => { setView('local'); setFilter('all'); setSelectedRecordId(null); setAcquisitionTarget(null); setSelectedRecordIds([]); setBulkNotice(''); setBulkFailures([]); }} className={`px-3 py-1.5 text-[10px] font-bold tracking-[.1em] ${view === 'local' ? 'bg-[#dcebe7] text-[#39736e]' : 'text-[#8a9b9e] hover:bg-[#f3f5f4]'}`} data-testid="tab-local-inventory">LOCAL REVIEW</button>
              <button onClick={() => { setView('naming_proposals'); setSelectedRecordId(null); setAcquisitionTarget(null); setSelectedRecordIds([]); setBulkNotice(''); setBulkFailures([]); }} className={`px-3 py-1.5 text-[10px] font-bold tracking-[.1em] ${view === 'naming_proposals' ? 'bg-[#dcebe7] text-[#39736e]' : 'text-[#8a9b9e] hover:bg-[#f3f5f4]'}`} data-testid="tab-naming-proposals">NAMING PROPOSALS</button>
              <button onClick={() => { setView('plex_only'); setSelectedRecordId(null); setAcquisitionTarget(null); setSelectedRecordIds([]); setBulkNotice(''); setBulkFailures([]); }} className={`px-3 py-1.5 text-[10px] font-bold tracking-[.1em] ${view === 'plex_only' ? 'bg-[#dcebe7] text-[#39736e]' : 'text-[#8a9b9e] hover:bg-[#f3f5f4]'}`} data-testid="tab-plex-only">{providerName} ONLY ({plexOnly.length})</button>
              <button onClick={() => { setView('missing_media'); setSelectedRecordId(null); setAcquisitionTarget(null); setSelectedRecordIds([]); setBulkNotice(''); setBulkFailures([]); }} className={`px-3 py-1.5 text-[10px] font-bold tracking-[.1em] ${view === 'missing_media' ? 'bg-[#dcebe7] text-[#39736e]' : 'text-[#8a9b9e] hover:bg-[#f3f5f4]'}`} data-testid="tab-missing-media">MISSING MEDIA</button>
            </div>

            {view === 'local' && (
              <div className="flex flex-wrap items-center gap-2">
                {(['all', 'queue', 'duplicates', 'conflicts', 'integrity', 'missing', 'local_only', 'reviewed', 'unresolved'] as const).map(f => (
                  <button key={f} onClick={() => { setFilter(f); setSelectedRecordIds([]); setBulkNotice(''); setBulkFailures([]); }} className={`archive-mono text-[9px] tracking-[.08em] px-2 py-1 border ${filter === f ? 'border-[#4e9690] bg-[#eaf3ef] text-[#39736e]' : 'border-[#d6dfdc] bg-white text-[#7f9194] hover:border-[#aabfba]'}`}>
                    {f === 'queue' ? 'REVIEW QUEUE' : f.replace('_', ' ').toUpperCase()}
                  </button>
                ))}
              </div>
            )}
          </div>

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
            {view === 'missing_media' ? (
              <ArchiveMissingMediaView onRequest={(item, providerId) => setAcquisitionTarget({ kind: 'missing', item, providerId })} />
            ) : view === 'naming_proposals' ? (
              namingLoading ? (
                <div className="flex min-h-[250px] items-center justify-center archive-mono text-[10px] tracking-[.12em] text-[#7f9194]" data-testid="status-naming-proposals-loading">ANALYSING ARCHIVE NAMING...</div>
              ) : namingError ? (
                <ErrorState title="Naming intelligence unavailable" message="Naming proposals could not be loaded from the local node." onRetry={() => refetchNaming()} testId="button-retry-naming-proposals" />
              ) : !namingProposals?.results.length ? (
                <EmptyState icon={Sparkles} title="No naming proposals" description="The archive currently has no naming changes requiring review." />
              ) : (
                <div className="space-y-3" data-testid="panel-naming-proposals">
                  <div className="archive-panel border-l-2 border-[#39736e] bg-[#f1f8f5] p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3"><div><div className="archive-mono text-[9px] tracking-[.14em] text-[#39736e]">POWER RENAMER / SUPERVISED MODE</div><p className="mt-1 text-[12px] text-[#43545b]">Select safe proposals to build a collision-safe, reversible batch. Approval and preflight are still required.</p></div><button disabled={!selectedNamingIds.length || powerRenamerBusy} onClick={planPowerRenamer} className="bg-[#1d2b38] px-4 py-2 text-[10px] font-bold tracking-[.1em] text-white disabled:opacity-40">{powerRenamerBusy ? 'PLANNING…' : `PLAN ${selectedNamingIds.length || ''} RENAME${selectedNamingIds.length === 1 ? '' : 'S'}`}</button></div>
                    {powerRenamerNotice && <p className="mt-3 text-[11px] font-semibold text-[#39736e]">{powerRenamerNotice}</p>}
                  </div>
                  {namingProposals.results.map(proposal => (

                    <div key={proposal.fileRecordId} className="border border-[#e1e8e5] bg-white/50 p-4">
                      {proposal.proposedPath && proposal.operation !== 'uncertain/no_action' && !proposal.collision && proposal.researchGrade === 'corroborated' && <label className="mb-3 flex items-center gap-2 text-[10px] font-bold tracking-[.08em] text-[#39736e]"><input type="checkbox" checked={selectedNamingIds.includes(proposal.fileRecordId)} onChange={() => setSelectedNamingIds(current => current.includes(proposal.fileRecordId) ? current.filter(id => id !== proposal.fileRecordId) : [...current, proposal.fileRecordId])} className="h-4 w-4 accent-[#39736e]" /> INCLUDE IN POWER RENAMER PLAN</label>}
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
                        <span className={`archive-mono text-[9px] ${proposal.researchGrade === 'corroborated' ? 'text-[#39736e]' : 'text-[#a77517]'}`}>RESEARCH / {(proposal.researchGrade ?? 'blocked').toUpperCase()}</span>
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
                      <div className="mt-3 archive-mono text-[9px] tracking-[.08em] text-[#a0afaf]">PROPOSAL ONLY / NO FILESYSTEM ACTION</div>
                    </div>
                  ))}
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
                        <div className="flex items-center gap-3"><div className="grid h-12 w-9 shrink-0 place-items-center overflow-hidden bg-[#e8efed] text-[#7f9c98]">{r.plexMatch ? <img src={apiUrl(`/api/plex/artwork/${encodeURIComponent(r.plexMatch.ratingKey)}`)} alt="" loading="lazy" className="h-full w-full object-cover" onError={(event) => { event.currentTarget.style.display = 'none'; }} /> : <Library size={16} />}</div><div className="min-w-0"><div className="truncate text-[13px] font-semibold text-[#344851]" title={r.plexMatch?.title ?? r.filename}>{r.plexMatch?.title ?? r.filename}</div><div className="mt-1 text-[10px] text-[#829095]">{r.plexMatch ? `${r.plexMatch.year ? `${r.plexMatch.year} · ` : ''}${r.mediaType ?? 'Media'} · local file found` : 'Local identity not matched to the configured host'}</div></div></div><div className="mt-2 truncate text-[10px] text-[#a0aaaa]" title={r.path}>{r.filename}</div><div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px]">
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
                          {r.integrityClassification && (
                            <span className={`archive-mono tracking-[.05em] ${r.integrityClassification === 'corrupt_or_malformed_container' ? 'text-[#994b43]' : 'text-[#a77517]'}`}>
                              {r.integrityClassification === 'corrupt_or_malformed_container' ? 'MEDIA INTEGRITY' : 'INSPECTION UNAVAILABLE'}
                            </span>
                          )}
                          <span className="text-[#8a9b9e]">{formatBytes(r.sizeBytes)}</span>
                        </div>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        {r.scanStatus === 'missing' && <span className="grid h-6 place-items-center bg-[#fcedea] px-2 text-[9px] font-bold text-[#c85b51]">MISSING</span>}
                        {r.integrityClassification === 'corrupt_or_malformed_container' && <span className="grid h-6 place-items-center bg-[#fcedea] px-2 text-[9px] font-bold text-[#994b43]">CORRUPT / MALFORMED</span>}
                        {r.integrityClassification === 'inspection_unavailable' && <span className="grid h-6 place-items-center bg-[#fff0c9] px-2 text-[9px] font-bold text-[#8d681d]">INSPECTION FAILED</span>}
                        {r.plexMatch && <span className="grid h-6 place-items-center bg-[#fff0c9] px-2 text-[9px] font-bold text-[#a77517]">IN PLEX</span>}
                        {r.reviewStatus !== 'not_applicable' && <span className={`grid h-6 place-items-center px-2 text-[9px] font-bold ${r.reviewStatus === 'reviewed' ? 'bg-[#eaf3ef] text-[#39736e]' : r.reviewStatus === 'deferred' ? 'bg-[#fff0c9] text-[#8d681d]' : 'bg-[#fcedea] text-[#994b43]'}`}>{r.reviewStatus.replace(/_/g, ' ').toUpperCase()}</span>}
                      </div>
                      </button>
                      <button
                        type="button"
                        onClick={() => setAcquisitionTarget({ kind: 'finding', record: r })}
                        className="self-center mr-3 inline-flex shrink-0 items-center border border-[#d6dfdc] bg-white px-2.5 py-2 text-[9px] font-bold tracking-[.06em] text-[#39736e] hover:border-[#4e9690] hover:bg-[#eaf3ef]"
                        data-testid={`button-request-archive-record-${r.id}`}
                      >
                        REQUEST MEDIA
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

        <div className="space-y-5">
          {selectedRecordId && <ArchiveRecordPanel id={selectedRecordId} onClose={() => setSelectedRecordId(null)} />}
          {acquisitionTarget && (
            <ArchiveAcquisitionPanel
              key={acquisitionTarget.kind === 'finding' ? `finding-${acquisitionTarget.record.id}` : `missing-${acquisitionTarget.item.externalId}`}
              target={acquisitionTarget}
              onClose={() => setAcquisitionTarget(null)}
            />
          )}
        </div>
      </div>}
    </>
  );
}

function ArchiveMissingMediaView({
  onRequest,
}: {
  onRequest: (item: MissingMediaItem, providerId: AcquisitionProvider) => void;
}) {
  const { data, isLoading, isError, error, refetch } = useDiscoverArchiveMissingMedia(undefined, {
    query: { retry: false, queryKey: getDiscoverArchiveMissingMediaQueryKey() },
  });

  if (isLoading) return <div className="p-6"><Skeleton className="h-[260px]" /></div>;
  if (isError) {
    return (
      <div className="p-6">
        <ErrorState
          title="Missing-media discovery failed"
          message={`The provider could not return missing media: ${errorText(error)}`}
          onRetry={() => refetch()}
          testId="button-retry-missing-media"
        />
      </div>
    );
  }

  const items = data?.items ?? [];
  return (
    <div className="space-y-4 p-4 md:p-6" data-testid="panel-missing-media">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#e3e8e7] pb-4">
        <div>
          <div className="archive-mono text-[9px] tracking-[.14em] text-[#7f9194]">
            PROVIDER DISCOVERY / {data?.providerId?.toUpperCase() ?? 'UNKNOWN'}
          </div>
          <h3 className="archive-display mt-1 text-lg font-extrabold text-[#354851]">Missing media</h3>
          <p className="mt-1 max-w-xl text-[11px] leading-5 text-[#829197]">
            Provider findings are shown beside archive truth. Requests create separate acquisition jobs and do not rewrite local records.
          </p>
        </div>
        <button type="button" onClick={() => refetch()} className="inline-flex items-center gap-2 border border-[#d6dfdc] bg-white px-3 py-2 text-[10px] font-bold tracking-[.08em] text-[#53656b]" data-testid="button-refresh-missing-media">
          <RefreshCw size={13} /> REFRESH
        </button>
      </div>
      {items.length ? (
        <div className="space-y-2">
          {items.map((item) => (
            <div key={`${item.externalId}-${item.title}`} className="flex flex-col gap-3 border border-[#e1e8e5] bg-white/60 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-[12px] font-semibold text-[#43545b]">{item.title}</div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 archive-mono text-[9px] text-[#8a9b9e]">
                  <span>{item.mediaType.toUpperCase()}</span>
                  <span>EXTERNAL ID {item.externalId}</span>
                  {item.year ? <span>{item.year}</span> : null}
                </div>
                {item.detail && <div className="mt-2 text-[10px] text-[#829197]">{item.detail}</div>}
              </div>
              <div className="flex shrink-0 gap-2">
                <button type="button" onClick={() => onRequest(item, data!.providerId)} className="inline-flex items-center gap-2 border border-[#4e9690] bg-[#eaf3ef] px-3 py-2 text-[9px] font-bold tracking-[.07em] text-[#39736e]" data-testid={`button-lookup-missing-media-${item.externalId}`}>
                  LOOK UP
                </button>
                <button type="button" onClick={() => onRequest(item, data!.providerId)} className="inline-flex items-center gap-2 bg-[#39736e] px-3 py-2 text-[9px] font-bold tracking-[.07em] text-white" data-testid={`button-request-missing-media-${item.externalId}`}>
                  REQUEST
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState icon={FolderOpen} title="No missing media reported" description="The selected provider did not report any missing items." />
      )}
    </div>
  );
}

const settingsGroups = [{ name: 'General', icon: SlidersHorizontal, fields: ['mockMode', 'dataDirectory', 'logLevel', 'startWithWindows'] }, { name: 'Downloads', icon: Download, fields: ['downloadDirectory', 'temporaryDirectory', 'concurrentDownloads', 'maxRetries', 'bandwidthLimit'] }, { name: 'Archive', icon: Archive, fields: ['archiveDirectory', 'outputContainer', 'inspectionCacheMinutes', 'warningFreePercent', 'criticalFreePercent'] }, { name: 'Local Engine', icon: Terminal, fields: ['ytDlpPath', 'ffmpegPath', 'ffprobePath'] }, { name: 'Hardware Acceleration', icon: Cpu, fields: ['hardwareAcceleration', 'hardwareAccelerationMode'] }, { name: 'Network', icon: Network, fields: ['networkMode'] }];
type UpdateStatus = { available: boolean; version: string | null; date: string | null; body: string | null };

function UpdaterPanel() {
  const [status, setStatus] = useState<'idle' | 'checking' | 'available' | 'current' | 'error' | 'installing'>('idle');
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [message, setMessage] = useState('Release updates are checked only when requested.');
  const check = async () => {
    setStatus('checking');
    try {
      const result = await invoke<UpdateStatus>('check_for_update');
      setUpdate(result);
      setStatus(result.available ? 'available' : 'current');
      setMessage(result.available ? `Signed release ${result.version ?? ''} is ready for review.` : 'This release is up to date.');
    } catch {
      setStatus('error');
      setMessage('Update checks are unavailable in this build or the release endpoint did not answer.');
    }
  };
  const install = async () => {
    setStatus('installing');
    setMessage('Downloading the approved signed release. The app will restart after installation.');
    try {
      await invoke('install_update');
    } catch {
      setStatus('error');
      setMessage('The signed update was not installed. The current app and local data remain unchanged.');
    }
  };
  return <section className="archive-panel p-5 md:p-6" data-testid="panel-updater"><div className="flex items-start justify-between gap-4"><div><div className="archive-mono text-[10px] tracking-[.14em] text-[#7f9194]">RELEASE CHANNEL / SIGNED</div><h2 className="archive-display mt-1 text-lg font-extrabold">Application updates</h2><p className="mt-2 text-[11px] leading-5 text-[#879599]">Updates come from signed GitHub releases. Nothing installs without operator approval.</p></div><RefreshCw size={17} className={status === 'checking' ? 'animate-spin text-[#39736e]' : 'text-[#7f9194]'} /></div><div className="mt-4 flex flex-wrap items-center gap-3"><button type="button" onClick={check} disabled={status === 'checking' || status === 'installing'} className="border border-[#4e9690] bg-[#eaf3ef] px-3 py-2 text-[10px] font-bold tracking-[.08em] text-[#39736e] disabled:opacity-50" data-testid="button-check-updates">CHECK FOR UPDATES</button>{status === 'available' && <button type="button" onClick={install} className="bg-[#39736e] px-3 py-2 text-[10px] font-bold tracking-[.08em] text-white" data-testid="button-install-update">INSTALL {update?.version ?? 'UPDATE'}</button>}</div><div className={`mt-3 text-[10px] leading-5 ${status === 'error' ? 'text-[#994b43]' : 'text-[#71858a]'}`} data-testid="status-updater">{message}</div></section>;
}

function SettingsPage() {
  const queryClient = useQueryClient(); const { data, isLoading, isError, refetch } = useGetSettings(); const { data: dependencyStatus } = useGetSystemDependencies(); const mutation = useUpdateSettings(); const [form, setForm] = useState<Partial<AppSettings>>({}); const [notice, setNotice] = useState('');
  useEffect(() => { if (data) setForm(data); }, [data]);
  const update = (key: keyof AppSettings, value: AppSettings[keyof AppSettings]) => setForm((current) => ({ ...current, [key]: value }));
  const save = () => { setNotice(''); mutation.mutate({ data: form as AppSettingsUpdate }, { onSuccess: async (result) => { setForm(result); setNotice('Settings saved to the local node.'); queryClient.setQueryData(getGetSettingsQueryKey(), result); try { await invoke('set_start_with_windows', { enabled: result.startWithWindows }); } catch { setNotice('Settings saved, but Windows startup could not be updated in this build.'); } }, onError: () => setNotice('Settings could not be saved. The local node did not accept the update.') }); };
  if (isLoading) return <><PageIntro eyebrow="SYSTEM / SETTINGS" title="System settings" description="Loading editable local preferences." /><Skeleton className="h-[520px]" /></>;
  if (isError || !data) return <ErrorState title="Settings unavailable" message="Preferences could not be read from the local node." onRetry={() => refetch()} testId="button-retry-settings" />;
  return <><PageIntro eyebrow="SYSTEM / SETTINGS" title="System settings" description="Persistent preferences for the local-first control room. Changes are sent to the real settings API." action={<div className="flex items-center gap-3">{notice && <span className={`hidden text-[11px] sm:inline ${notice.includes('could not') ? 'text-[#c85b51]' : 'text-[#39736e]'}`} data-testid="status-settings-save">{notice}</span>}<button onClick={save} disabled={mutation.isPending} className="inline-flex items-center gap-2 bg-[#1d2b38] px-4 py-2.5 text-[11px] font-bold tracking-[.1em] text-[#f5f6f3] disabled:opacity-50" data-testid="button-save-settings"><Save size={14} /> {mutation.isPending ? 'SAVING' : 'SAVE CHANGES'}</button></div>} />{notice && <div className={`mb-4 text-[11px] sm:hidden ${notice.includes('could not') ? 'text-[#c85b51]' : 'text-[#39736e]'}`} data-testid="status-settings-save-mobile">{notice}</div>}<StorageDiagnosticsPanel /><UpdaterPanel /><WebhookSecretPanel /><div className="grid gap-5 xl:grid-cols-[1fr_280px]"><div className="space-y-4">{settingsGroups.filter(({ fields }) => fields.length > 0).map(({ name, icon: Icon, fields }) => <SettingsGroup key={name} name={name} icon={Icon} fields={fields} form={form} update={update} />)}</div><aside className="archive-panel h-fit p-5 md:p-6"><div className="archive-mono text-[10px] tracking-[.14em] text-[#7f9194]">LOCAL DEPENDENCIES</div><h2 className="archive-display mt-1 text-lg font-extrabold">Capability check</h2>{dependencyStatus?.mediaBundle ? <div className="mt-5 border border-[#c9dfd9] bg-[#f1f9f5] p-3" data-testid="panel-media-bundle"><div className="flex items-center justify-between gap-3"><div className="archive-mono text-[9px] font-bold tracking-[.12em] text-[#39736e]">NATIVE MEDIA BUNDLE</div><span className="archive-mono bg-[#dcebe7] px-1.5 py-1 text-[9px] font-bold text-[#39736e]" data-testid="text-media-bundle-architecture">{dependencyStatus.mediaBundle.architecture.toUpperCase()}</span></div><div className="mt-2 text-[11px] font-semibold text-[#53656b]">{dependencyStatus.mediaBundle.targetTriple}</div><div className="mt-1 archive-mono text-[9px] text-[#799094]">yt-dlp {dependencyStatus.mediaBundle.ytDlpVersion} / FFmpeg {dependencyStatus.mediaBundle.ffmpegVersion}</div><div className="mt-2 text-[10px] leading-4 text-[#6e8583]">Managed native tools selected for this desktop build.</div></div> : <div className="mt-5 border border-[#e5e9e7] bg-[#f8faf8] p-3 text-[10px] leading-4 text-[#879599]" data-testid="panel-media-bundle-empty">No managed media bundle was detected. System tools or operator overrides may be in use.</div>}<div className="mt-5 space-y-3">{dependencyStatus?.dependencies?.length ? dependencyStatus.dependencies.map((dep) => <div key={dep.name} className="flex items-center gap-3" data-testid={`row-dependency-${dep.name}`}><span className={`status-dot ${dep.status === 'available' ? 'ready' : dep.status === 'missing' ? 'error' : 'warning'}`} /><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><div className="truncate text-[11px] font-semibold text-[#53656b]">{dep.name}</div><span className={`archive-mono px-1 py-0.5 text-[8px] font-bold tracking-[.08em] ${dep.source === 'override' ? 'bg-[#fff0c9] text-[#8d681d]' : dep.source === 'bundled' ? 'bg-[#dcebe7] text-[#39736e]' : 'bg-[#eef1f0] text-[#879599]'}`} data-testid={`badge-dependency-source-${dep.name}`}>{dep.source.toUpperCase()}</span></div><div className="archive-mono text-[9px] text-[#96a3a5]">{dep.version ?? dep.status}</div></div></div>) : <p className="text-[11px] leading-5 text-[#879599]">No dependency data returned yet.</p>}</div><div className="mt-6 border-t border-[#e3e8e7] pt-4 text-[10px] leading-5 text-[#879599]">Only versions, architecture, and source labels are shown here; filesystem paths are intentionally omitted.</div></aside></div></>;
}

type WebhookForm = {
  secret: string;
  mode: RotateWebhookSecretBody['mode'];
  overlapMinutes: string;
};

const webhookProviders = ['sonarr', 'radarr'] as const;

function WebhookSecretPanel() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useGetWebhookSecretStatuses();
  const mutation = useReplaceWebhookSecret();
  const [forms, setForms] = useState<Record<typeof webhookProviders[number], WebhookForm>>({
    sonarr: { secret: '', mode: 'overlap', overlapMinutes: '60' },
    radarr: { secret: '', mode: 'overlap', overlapMinutes: '60' },
  });
  const [notice, setNotice] = useState('');

  const updateForm = (provider: typeof webhookProviders[number], changes: Partial<WebhookForm>) => {
    setForms((current) => ({ ...current, [provider]: { ...current[provider], ...changes } }));
  };
  const save = (provider: typeof webhookProviders[number]) => {
    const form = forms[provider];
    const overlapMinutes = Number(form.overlapMinutes);
    if (!form.secret.trim()) {
      setNotice(`Enter a new ${provider} webhook secret before saving.`);
      return;
    }
    if (form.mode === 'overlap' && (!Number.isInteger(overlapMinutes) || overlapMinutes < 1 || overlapMinutes > 1440)) {
      setNotice('Overlap duration must be a whole number between 1 and 1440 minutes.');
      return;
    }
    setNotice('');
    mutation.mutate(
      {
        provider,
        data: {
          secret: form.secret,
          mode: form.mode,
          ...(form.mode === 'overlap' ? { overlapMinutes } : {}),
        },
      },
      {
        onSuccess: () => {
          updateForm(provider, { secret: '' });
          setNotice(`${provider[0].toUpperCase()}${provider.slice(1)} webhook secret updated.`);
          queryClient.invalidateQueries({ queryKey: getGetWebhookSecretStatusesQueryKey() });
        },
        onError: () => setNotice(`${provider[0].toUpperCase()}${provider.slice(1)} webhook secret could not be updated.`),
      },
    );
  };

  return <section className="archive-panel mb-5 p-5 md:p-6" data-testid="panel-webhook-secrets">
    <div className="flex items-start justify-between gap-4">
      <div>
        <div className="archive-mono text-[10px] tracking-[.14em] text-[#7f9194]">INTEGRATION SECURITY</div>
        <h2 className="archive-display mt-1 text-lg font-extrabold">Provider webhooks</h2>
        <p className="mt-2 max-w-2xl text-[11px] leading-5 text-[#7d8b8e]">Secrets are never shown after saving. Use overlap while updating Sonarr or Radarr, then switch the provider to the new secret before the overlap expires.</p>
      </div>
      <ShieldCheck size={18} className="shrink-0 text-[#4e9690]" />
    </div>
    {notice && <div className={`mt-4 text-[11px] ${notice.includes('could not') || notice.includes('Enter') || notice.includes('duration') ? 'text-[#c85b51]' : 'text-[#39736e]'}`} data-testid="status-webhook-secret">{notice}</div>}
    {isLoading ? <Skeleton className="mt-5 h-32" /> : isError || !data ? <div className="mt-5 flex items-center justify-between gap-4 border-t border-[#e3e8e7] pt-4 text-[11px] text-[#879599]"><span>Webhook configuration could not be read.</span><button type="button" onClick={() => refetch()} className="border border-[var(--line)] px-3 py-2 text-[10px] font-bold tracking-[.08em] text-[#5a6d73]" data-testid="button-retry-webhook-secrets">RETRY</button></div> : <div className="mt-5 grid gap-4 border-t border-[#e3e8e7] pt-5 md:grid-cols-2">{webhookProviders.map((provider) => <WebhookSecretRow key={provider} provider={provider} status={data.providers.find((item) => item.provider === provider)} form={forms[provider]} disabled={mutation.isPending} onChange={(changes) => updateForm(provider, changes)} onSave={() => save(provider)} />)}</div>}
  </section>;
}

function WebhookSecretRow({ provider, status, form, disabled, onChange, onSave }: { provider: typeof webhookProviders[number]; status?: WebhookSecretStatus; form: WebhookForm; disabled: boolean; onChange: (update: Partial<WebhookForm>) => void; onSave: () => void }) {
  const configured = status?.configured ?? false;
  const overlap = status?.overlapUntil ? `OLD SECRET ACCEPTED UNTIL ${new Date(status.overlapUntil).toLocaleString()}` : 'CUTOVER ONLY';
  const diagnostics = status?.diagnostics;
  const counts = diagnostics?.counts ?? { accepted: 0, rejected: 0, unavailable: 0, malformed: 0 };
  return <div className="border border-[#e3e8e7] bg-white/45 p-4" data-testid={`webhook-row-${provider}`}>
    <div className="flex items-center justify-between gap-3">
      <div><div className="archive-display text-[14px] font-extrabold text-[#354851]">{provider[0].toUpperCase()}{provider.slice(1)}</div><div className="mt-1 flex items-center gap-2 archive-mono text-[9px] tracking-[.08em] text-[#7f9194]"><span className={`status-dot ${configured ? 'ready' : 'warning'}`} />{configured ? 'CONFIGURED' : 'NOT CONFIGURED'}</div></div>
      {status?.overlapUntil && <span className="text-right text-[9px] leading-4 text-[#9a6f32]" data-testid={`text-webhook-overlap-${provider}`}>{overlap}</span>}
    </div>
    <label className="mt-4 block text-[10px] font-bold tracking-[.08em] text-[#71858a]">NEW SECRET<input type="password" value={form.secret} onChange={(event) => onChange({ secret: event.target.value })} placeholder="Enter a new secret" autoComplete="new-password" className="mt-2 block w-full border border-[#d8e1de] bg-white px-3 py-2.5 text-[12px] text-[#354851] outline-none focus:border-[#4e9690]" data-testid={`input-webhook-secret-${provider}`} /></label>
    <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_110px]">
      <label className="block text-[10px] font-bold tracking-[.08em] text-[#71858a]">ROTATION PATH<select value={form.mode} onChange={(event) => onChange({ mode: event.target.value as WebhookForm['mode'] })} className="mt-2 block w-full border border-[#d8e1de] bg-white px-3 py-2.5 text-[11px] text-[#354851] outline-none focus:border-[#4e9690]" data-testid={`select-webhook-mode-${provider}`}><option value="overlap">Overlap old secret</option><option value="cutover">Cut over immediately</option></select></label>
      {form.mode === 'overlap' && <label className="block text-[10px] font-bold tracking-[.08em] text-[#71858a]">MINUTES<input type="number" min="1" max="1440" step="1" value={form.overlapMinutes} onChange={(event) => onChange({ overlapMinutes: event.target.value })} className="mt-2 block w-full border border-[#d8e1de] bg-white px-3 py-2.5 text-[11px] text-[#354851] outline-none focus:border-[#4e9690]" data-testid={`input-webhook-overlap-${provider}`} /></label>}
    </div>
    <div className="mt-4 border-t border-[#e3e8e7] pt-4" data-testid={`panel-webhook-diagnostics-${provider}`}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="archive-mono text-[9px] tracking-[.12em] text-[#7f9194]">DELIVERY DIAGNOSTICS / LAST 24 HOURS</div>
          <div className="mt-1 text-[10px] text-[#879599]">{diagnostics?.lastReceivedAt ? `Last delivery ${formatTime(diagnostics.lastReceivedAt)}` : 'No delivery has reached this node yet.'}</div>
        </div>
        {diagnostics?.lastResult && <span className="archive-mono text-[9px] font-bold tracking-[.08em] text-[#39736e]">LAST: {diagnostics.lastResult.toUpperCase()}</span>}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] sm:grid-cols-4">
        {(['accepted', 'rejected', 'unavailable', 'malformed'] as const).map((result) => <div key={result} className="border border-[#e3e8e7] bg-white/60 px-2.5 py-2" data-testid={`text-webhook-${result}-${provider}`}><div className="archive-mono text-[9px] tracking-[.08em] text-[#879599]">{result.toUpperCase()}</div><div className="archive-display mt-1 text-lg font-extrabold text-[#354851]">{counts[result]}</div></div>)}
      </div>
      <div className="mt-3 text-[10px] leading-5 text-[#879599]">Counts contain outcomes only. Request bodies, signatures, and both webhook secrets are never displayed or stored.</div>
    </div>
    <button type="button" onClick={onSave} disabled={disabled} className="mt-4 w-full bg-[#39736e] px-3 py-2.5 text-[10px] font-bold tracking-[.1em] text-white disabled:opacity-50" data-testid={`button-save-webhook-${provider}`}>{disabled ? 'SAVING' : 'SAVE WEBHOOK SECRET'}</button>
  </div>;
}
function SettingsGroup({ name, icon: Icon, fields, form, update }: { name: string; icon: typeof SlidersHorizontal; fields: string[]; form: Partial<AppSettings>; update: (key: keyof AppSettings, value: AppSettings[keyof AppSettings]) => void }) {
  const [open, setOpen] = useState(fields.length > 0); const slug = name.toLowerCase().replace(/\s/g, '-');
  return <section className="archive-panel overflow-hidden" data-testid={`settings-group-${slug}`}><button onClick={() => setOpen((value) => !value)} className="flex w-full items-center justify-between px-5 py-4 text-left hover:bg-white/50" data-testid={`button-toggle-settings-${slug}`}><span className="flex items-center gap-3"><span className="grid h-8 w-8 place-items-center bg-[#e8efed] text-[#4e9690]"><Icon size={15} /></span><span className="archive-display text-[14px] font-extrabold text-[#354851]">{name}</span></span><ChevronRight size={16} className={`text-[#9aa7a7] transition-transform ${open ? 'rotate-90' : ''}`} /></button>{open && fields.length > 0 && <div className="grid gap-4 border-t border-[#e3e8e7]/60 px-5 py-5 md:grid-cols-2">{fields.map((field) => <SettingField key={field} field={field} form={form} update={update} />)}</div>}</section>;
}
function SettingField({ field, form, update }: { field: string; form: Partial<AppSettings>; update: (key: keyof AppSettings, value: AppSettings[keyof AppSettings]) => void }) {
  const key = field as keyof AppSettings; const value = form[key];
  if (field === 'mockMode' || field === 'hardwareAcceleration' || field === 'startWithWindows') return <label className="flex items-center justify-between gap-4 border border-[#e2e8e6] bg-white/50 px-3 py-3"><span><span className="block text-[11px] font-semibold text-[#53656b]">{field === 'mockMode' ? 'Mock mode' : field === 'hardwareAcceleration' ? 'Hardware acceleration' : 'Start Archive Assistant with Windows'}</span><span className="mt-1 block text-[10px] text-[#94a1a3]">{field === 'mockMode' ? 'Use backend-provided demo data' : field === 'hardwareAcceleration' ? 'Allow accelerated media work' : 'Launch quietly to the system tray. Existing installs stay disabled until enabled.'}</span></span><input type="checkbox" checked={Boolean(value)} onChange={(event) => update(key, event.target.checked)} className="h-4 w-4 accent-[#4e9690]" data-testid={`input-setting-${field}`} /></label>;
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

function DesktopLifecycleBridge() {
  const [, setLocation] = useLocation();
  const client = useQueryClient();
  useEffect(() => {
    let dispose: (() => void) | undefined;
    listen<string>('tray://action', async (event) => {
      switch (event.payload) {
        case 'open': await invoke('open_archive_assistant').catch(() => undefined); break;
        case 'scan':
          await fetch(apiUrl('/api/archive/scan'), { method: 'POST' }).catch(() => undefined);
          client.invalidateQueries({ queryKey: getGetArchiveScanQueryKey() });
          break;
        case 'plex':
          await fetch(apiUrl('/api/plex/sync'), { method: 'POST' }).catch(() => undefined);
          client.invalidateQueries({ queryKey: getGetPlexConfigQueryKey() });
          client.invalidateQueries({ queryKey: getGetPlexInventoryQueryKey() });
          break;
        case 'activity': setLocation('/history'); break;
        case 'settings': setLocation('/settings'); break;
      }
    }).then((unlisten) => { dispose = unlisten; }).catch(() => undefined);
    return () => dispose?.();
  }, [client, setLocation]);
  return null;
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
  return <ErrorBoundary resetKey={location}><AppShell><Switch><Route path="/user-portal" component={Home} /><Route path="/workload/:workloadId" component={WorkloadDetailPage} /><Route path="/archive/ordering/:proposalId" component={IntelligentOrderingPage} /><Route path="/archive/health" component={ArchiveHealthPage} /><Route path="/assistant" component={AssistantPage} /><Route path="/discover" component={DiscoverPage} /><Route path="/queue" component={QueuePage} /><Route path="/archive" component={ArchivePage} /><Route path="/plex" component={PlexPage} /><Route path="/jellyfin" component={JellyfinPage} /><Route path="/sources" component={SourcesPage} /><Route path="/monitoring" component={MonitoringPage} /><Route path="/history" component={HistoryPage} /><Route path="/settings" component={SettingsPage} /><Route component={NotFound} /></Switch></AppShell></ErrorBoundary>;
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
  return <QueryClientProvider client={queryClient}><QueryCacheInvalidator /><DesktopLifecycleBridge /><TooltipProvider><Router /><Toaster /></TooltipProvider></QueryClientProvider>;
}

function LocalApp() {
  return <AppAuthContext.Provider value={{ mode: 'local', userId: '__local__', isLoaded: true, isSignedIn: true, email: 'Local operator', initials: 'LO', signOut: () => undefined }}><ApplicationProviders /></AppAuthContext.Provider>;
}

function App() {
  return <WouterRouter base={basePath}>{authMode === 'clerk' ? <ClerkApp /> : <LocalApp />}</WouterRouter>;
}

export default App;

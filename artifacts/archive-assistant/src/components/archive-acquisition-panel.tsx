import { useEffect, useState } from 'react';
import {
  Search,
  X,
  RefreshCw,
  AlertTriangle,
  ShieldCheck,
} from 'lucide-react';
import {
  useLookupArchiveMedia,
  getLookupArchiveMediaQueryKey,
} from '@workspace/api-client-react';
import type {
  AcquisitionProvider,
  ArchiveInventoryRecord,
  MediaLookupRecord,
  MissingMediaItem,
} from '@workspace/api-client-react';

export type ArchiveAcquisitionTarget =
  | {
      kind: 'finding';
      record: ArchiveInventoryRecord;
    }
  | {
      kind: 'missing';
      item: MissingMediaItem;
      providerId: AcquisitionProvider;
    };

function errorText(error: unknown) {
  if (error && typeof error === 'object' && 'error' in error) {
    const message = (error as { error?: unknown }).error;
    if (typeof message === 'string') return message;
  }
  return error instanceof Error ? error.message : 'The provider request could not be completed.';
}

function defaultProvider(target: ArchiveAcquisitionTarget): AcquisitionProvider {
  if (target.kind === 'missing') return target.providerId;
  return target.record.mediaType?.toLowerCase().includes('movie') ? 'radarr' : 'sonarr';
}

function defaultQuery(target: ArchiveAcquisitionTarget) {
  if (target.kind === 'missing') return target.item.title;
  return target.record.filename.replace(/\.[^.]+$/, '').replace(/[._-]+/g, ' ').trim();
}

function targetLabel(target: ArchiveAcquisitionTarget) {
  return target.kind === 'missing' ? target.item.title : target.record.filename;
}

export function ArchiveAcquisitionPanel({
  target,
  onClose,
}: {
  target: ArchiveAcquisitionTarget;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(() => defaultQuery(target));
  const [providerId, setProviderId] = useState<AcquisitionProvider>(() => defaultProvider(target));
  const [lookupParams, setLookupParams] = useState<{
    query: string;
    mediaType?: string;
    providerId: AcquisitionProvider;
  } | undefined>();
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setQuery(defaultQuery(target));
    setProviderId(defaultProvider(target));
    setLookupParams(undefined);
    setNotice(null);
  }, [target]);

  const lookup = useLookupArchiveMedia(lookupParams, {
    query: {
      enabled: Boolean(lookupParams),
      retry: false,
      queryKey: getLookupArchiveMediaQueryKey(lookupParams),
    },
  });
  const mediaType = target.kind === 'missing'
    ? target.item.mediaType
    : target.record.mediaType ?? (providerId === 'radarr' ? 'movie' : 'series');

  return (
    <aside className="archive-panel h-fit overflow-hidden" data-testid="panel-archive-acquisition">
      <div className="flex items-start justify-between border-b border-[#e3e8e7] bg-[#fbfcfa] p-5">
        <div>
          <div className="archive-mono text-[9px] tracking-[.16em] text-[#7f9194]">
            {target.kind === 'missing' ? 'MISSING MEDIA / REQUEST' : 'ARCHIVE FINDING / REQUEST'}
          </div>
          <h2 className="archive-display mt-1 max-w-[260px] text-lg font-extrabold text-[#354851]">
            Request media
          </h2>
        </div>
        <button type="button" onClick={onClose} className="text-[#8a9b9e] hover:text-[#354851]" aria-label="Close acquisition request" data-testid="button-close-acquisition">
          <X size={17} />
        </button>
      </div>

      <div className="space-y-5 p-5">
        <div className="border-l-2 border-[#f4b942] bg-[#fff8e7] px-3 py-2.5 text-[11px] leading-5 text-[#80652e]" data-testid="text-acquisition-target">
          <div className="font-semibold">{targetLabel(target)}</div>
          <div className="mt-1 text-[10px]">
            {target.kind === 'missing'
              ? target.item.detail ?? 'Reported missing by the provider.'
              : `${target.record.qualityStatus.replace(/_/g, ' ')} finding · archive remains unchanged`}
          </div>
        </div>

        <div className="space-y-3">
          <div className="archive-mono text-[9px] tracking-[.13em] text-[#7f9194]">PROVIDER LOOKUP</div>
          <div className="grid gap-2 sm:grid-cols-[1fr_110px]">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="min-w-0 border border-[#d6dfdc] bg-[#fbfcfa] px-3 py-2.5 text-[12px] outline-none focus:border-[#4e9690]"
              placeholder="Search title or external ID"
              aria-label="Media lookup query"
              data-testid="input-acquisition-query"
            />
            <select
              value={providerId}
              onChange={(event) => setProviderId(event.target.value as AcquisitionProvider)}
              className="border border-[#d6dfdc] bg-[#fbfcfa] px-2 py-2.5 text-[11px] outline-none focus:border-[#4e9690]"
              aria-label="Acquisition provider"
              data-testid="select-acquisition-provider"
            >
              <option value="sonarr">SONARR</option>
              <option value="radarr">RADARR</option>
            </select>
          </div>
          <button
            type="button"
            disabled={!query.trim() || lookup.isFetching}
            onClick={() => {
              setNotice(null);
              setLookupParams({ query: query.trim(), mediaType, providerId });
            }}
            className="inline-flex items-center gap-2 border border-[#4e9690] bg-[#eaf3ef] px-3 py-2 text-[10px] font-bold tracking-[.08em] text-[#39736e] disabled:opacity-50"
            data-testid="button-lookup-acquisition"
          >
            {lookup.isFetching ? <RefreshCw size={13} className="animate-spin" /> : <Search size={13} />}
            LOOK UP MEDIA
          </button>
        </div>

        {lookupParams && lookup.isError && (
          <div className="flex gap-2 border border-[#e2b9b4] bg-[#fcedea] p-3 text-[11px] leading-5 text-[#994b43]" role="alert" data-testid="status-acquisition-lookup-error">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>Provider lookup failed: {errorText(lookup.error)}</span>
          </div>
        )}

        {lookupParams && !lookup.isFetching && lookup.data?.records.length === 0 && !lookup.isError && (
          <div className="text-[11px] text-[#829197]" data-testid="status-acquisition-no-results">
            No provider matches were found. The archive finding was not changed.
          </div>
        )}

        {lookup.data?.records.length ? (
          <div className="space-y-2" data-testid="list-acquisition-results">
            <div className="archive-mono text-[9px] tracking-[.13em] text-[#7f9194]">SELECT A PROVIDER MATCH</div>
            {lookup.data.records.map((result: MediaLookupRecord) => (
              <div key={`${result.source}-${result.externalId}`} className="border border-[#e1e8e5] bg-white p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[12px] font-semibold text-[#43545b]">{result.title}</div>
                    <div className="mt-1 archive-mono text-[9px] text-[#8a9b9e]">
                      {result.source.toUpperCase()} / {result.externalId}{result.year ? ` / ${result.year}` : ''}
                    </div>
                  </div>
                  <span className="shrink-0 border border-[#b9cbc7] bg-[#eaf3ef] px-2.5 py-2 text-[9px] font-bold tracking-[.06em] text-[#39736e]">
                    LOOKUP ONLY
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        <div className="border-t border-[#e3e8e7] pt-4">
          <div className="archive-mono text-[9px] tracking-[.13em] text-[#7f9194]">APPROVAL REQUIRED</div>
          <div className="mt-2 flex items-center gap-2 text-[11px] font-semibold text-[#39736e]">
            <ShieldCheck size={14} /> PROVIDER WORK HAS NOT STARTED
          </div>
          <p className="mt-3 text-[11px] leading-5 text-[#66787d]">
            Provider work begins only after this item becomes an acquisition recommendation, its owner-scoped review is approved, and an operator explicitly selects CREATE / VIEW JOB in the Assistant approval queue.
          </p>
          <button type="button" onClick={() => setNotice('Open Assistant, evaluate the current state, approve the acquisition recommendation, then select CREATE / VIEW JOB to start provider work.')} className="mt-3 inline-flex items-center gap-2 border border-[#d6dfdc] bg-white px-3 py-2 text-[10px] font-bold tracking-[.08em] text-[#53656b] hover:border-[#81999a]" data-testid="button-explain-acquisition-approval">
            <ShieldCheck size={13} /> SHOW REQUIRED STEPS
          </button>
        </div>

        {notice && (
          <div className="border border-[#b9cbc7] bg-[#eaf3ef] p-3 text-[11px] leading-5 text-[#39736e]" role="status" aria-live="polite" data-testid="status-acquisition-request">
            {notice}
          </div>
        )}
      </div>
    </aside>
  );
}
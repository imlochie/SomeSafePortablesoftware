import { useEffect, useState } from 'react';
import {
  Search,
  X,
  Send,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';
import {
  useLookupArchiveMedia,
  useRequestArchiveAcquisition,
  getLookupArchiveMediaQueryKey,
} from '@workspace/api-client-react';
import type {
  AcquisitionJob,
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

function archiveIdentity(target: ArchiveAcquisitionTarget) {
  if (target.kind === 'missing') {
    return {
      source: 'provider-missing-media',
      externalId: target.item.externalId,
      title: target.item.title,
      mediaType: target.item.mediaType,
      year: target.item.year,
      detail: target.item.detail,
    };
  }
  return {
    source: 'archive-finding',
    recordId: target.record.id,
    archiveItemId: target.record.archiveItemId,
    filename: target.record.filename,
    path: target.record.path,
    relativePath: target.record.relativePath,
    checksum: target.record.checksum,
    mediaType: target.record.mediaType,
    scanStatus: target.record.scanStatus,
    qualityStatus: target.record.qualityStatus,
  };
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
  const [policyReason, setPolicyReason] = useState('');
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  useEffect(() => {
    setQuery(defaultQuery(target));
    setProviderId(defaultProvider(target));
    setLookupParams(undefined);
    setPolicyReason('');
    setNotice(null);
  }, [target]);

  const lookup = useLookupArchiveMedia(lookupParams, {
    query: {
      enabled: Boolean(lookupParams),
      retry: false,
      queryKey: getLookupArchiveMediaQueryKey(lookupParams),
    },
  });
  const acquisition = useRequestArchiveAcquisition();

  const mediaType = target.kind === 'missing'
    ? target.item.mediaType
    : target.record.mediaType ?? (providerId === 'radarr' ? 'movie' : 'series');

  const requestMedia = (result: {
    title: string;
    year: number | null;
    externalId: string;
    mediaType: string;
    source?: AcquisitionProvider;
  }) => {
    const selectedProvider = result.source ?? providerId;
    setNotice(null);
    acquisition.mutate({
      data: {
        mediaType: result.mediaType,
        title: result.title,
        year: result.year,
        externalId: result.externalId,
        sourceId: result.externalId,
        providerId: selectedProvider,
        archiveIdentity: archiveIdentity(target),
        policyDecision: {
          decision: 'approved',
          reason: policyReason.trim() || 'Operator approved acquisition from the archive review flow.',
          source: target.kind === 'missing' ? 'missing-media' : 'archive-finding',
        },
        metadata: {
          source: target.kind === 'missing' ? 'archive-missing-media' : 'archive-finding',
        },
        start: true,
      },
    }, {
      onSuccess: (job: AcquisitionJob) => {
        setNotice({
          tone: job.state === 'failed' ? 'bad' : 'good',
          text: job.state === 'failed'
            ? `Acquisition #${job.id} failed: ${job.errorMessage ?? 'The provider rejected the request.'}`
            : `Acquisition #${job.id} is ${job.state.replace(/_/g, ' ')}. Archive data was not changed.`,
        });
      },
      onError: (error) => {
        setNotice({ tone: 'bad', text: `Acquisition request failed: ${errorText(error)}` });
      },
    });
  };

  const requestDirect = () => {
    requestMedia({
      title: target.kind === 'missing' ? target.item.title : target.record.filename,
      year: target.kind === 'missing' ? target.item.year : null,
      externalId: target.kind === 'missing' ? target.item.externalId : '',
      mediaType,
      source: providerId,
    });
  };

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
                  <button
                    type="button"
                    disabled={acquisition.isPending}
                    onClick={() => requestMedia(result)}
                    className="inline-flex shrink-0 items-center gap-1.5 bg-[#39736e] px-2.5 py-2 text-[9px] font-bold tracking-[.06em] text-white disabled:opacity-50"
                    data-testid={`button-request-provider-match-${result.externalId}`}
                  >
                    <Send size={11} /> REQUEST
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        <div className="border-t border-[#e3e8e7] pt-4">
          <div className="archive-mono text-[9px] tracking-[.13em] text-[#7f9194]">POLICY DECISION</div>
          <div className="mt-2 flex items-center gap-2 text-[11px] font-semibold text-[#39736e]">
            <CheckCircle2 size={14} /> APPROVED FOR ACQUISITION
          </div>
          <textarea
            value={policyReason}
            onChange={(event) => setPolicyReason(event.target.value)}
            className="mt-3 min-h-[62px] w-full resize-y border border-[#d6dfdc] bg-[#fbfcfa] px-3 py-2 text-[11px] outline-none focus:border-[#4e9690]"
            placeholder="Optional reason for this operator decision"
            aria-label="Policy decision reason"
            data-testid="input-acquisition-policy-reason"
          />
          <button
            type="button"
            disabled={acquisition.isPending}
            onClick={requestDirect}
            className="mt-3 inline-flex items-center gap-2 border border-[#d6dfdc] bg-white px-3 py-2 text-[10px] font-bold tracking-[.08em] text-[#53656b] hover:border-[#81999a] disabled:opacity-50"
            data-testid="button-request-direct-acquisition"
          >
            {acquisition.isPending ? <RefreshCw size={13} className="animate-spin" /> : <Send size={13} />}
            REQUEST THIS ITEM
          </button>
        </div>

        {notice && (
          <div className={`border p-3 text-[11px] leading-5 ${notice.tone === 'bad' ? 'border-[#e2b9b4] bg-[#fcedea] text-[#994b43]' : 'border-[#b9cbc7] bg-[#eaf3ef] text-[#39736e]'}`} role="status" aria-live="polite" data-testid="status-acquisition-request">
            {notice.text}
          </div>
        )}
      </div>
    </aside>
  );
}
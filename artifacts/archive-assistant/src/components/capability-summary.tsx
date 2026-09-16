/**
 * What Archive Assistant can actually do.
 *
 * The engine has always known this — `/action-capabilities` reports every
 * family with its support flag, whether it touches files, its risk, and now
 * its reversibility. Nothing rendered it, so seven declared-but-unimplemented
 * families were simply invisible. That defeats the reason they are declared:
 * the product is supposed to be able to say "not yet" instead of pretending a
 * capability does not exist.
 *
 * This is deliberately not a technical registry dump. It answers one operator
 * question — "what can I do, and what happens if I'm wrong?" — using the
 * engine's own words.
 */
import {
  Check,
  CircleAlert,
  Clock,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  TriangleAlert,
} from 'lucide-react';
import {
  useListActionCapabilities,
  type ActionCapability,
} from '@workspace/api-client-react';

/** Plain-language names. The engine's `type` is a code, not a label. */
const familyLabel: Record<string, string> = {
  rename: 'Rename files to the archive convention',
  move: 'Move files to a different archive path',
  import: 'Import verified downloads into the archive',
  reconcile: 'Confirm archive ↔ Plex identity links',
  delete: 'Remove files from the archive',
  restore: 'Restore a previously removed file',
  acquire: 'Request missing media from a provider',
  link: 'Associate a record with an external identity',
  unlink: 'Remove an association between records',
  metadata_update: 'Correct metadata on archive records',
  plex_sync: 'Register or refresh an item in Plex',
};

const reversibilityChip: Record<string, { label: string; className: string; icon: typeof RotateCcw }> = {
  reversible: { label: 'UNDOABLE', className: 'border-[#b9d6cf] bg-[#eaf3ef] text-[#39736e]', icon: RotateCcw },
  conditional: { label: 'UNDOABLE IF…', className: 'border-[#d9bd77] bg-[#fff8e7] text-[#8d681d]', icon: TriangleAlert },
  irreversible: { label: 'ONE-WAY', className: 'border-[#e0b3ad] bg-[#fcedea] text-[#994b43]', icon: ShieldAlert },
};

function CapabilityRow({ capability }: { capability: ActionCapability }) {
  const chip = reversibilityChip[capability.reversibility.kind] ?? reversibilityChip.conditional;
  const ChipIcon = chip.icon;
  return (
    <div
      className={`flex flex-wrap items-start justify-between gap-3 border-b border-[#eef2f0] py-3 last:border-b-0 ${
        capability.supported ? '' : 'opacity-70'
      }`}
      data-testid={`row-capability-${capability.type}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {capability.supported ? (
            <Check size={13} className="shrink-0 text-[#4e9690]" />
          ) : (
            <Clock size={13} className="shrink-0 text-[#a0afaf]" />
          )}
          <span className="text-[12px] font-semibold text-[#21303d]">
            {familyLabel[capability.type] ?? capability.type}
          </span>
          {!capability.supported && (
            <span
              className="border border-[#d6dfdc] bg-[#f4f9f7] px-2 py-0.5 archive-mono text-[9px] font-bold tracking-[.1em] text-[#7f9194]"
              data-testid={`badge-capability-unavailable-${capability.type}`}
            >
              NOT AVAILABLE YET
            </span>
          )}
        </div>
        <p className="mt-1 pl-[21px] text-[11px] leading-5 text-[#5c6d73]">
          {/* Only describe consequences for things that can actually run. */}
          {capability.supported
            ? capability.reversibility.explanation
            : 'Declared so the product can name it honestly. It refuses to plan or execute until it is wired end to end.'}
        </p>
      </div>
      {capability.supported && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <span
            className="border border-[#d6dfdc] bg-white px-2 py-1 archive-mono text-[9px] tracking-[.08em] text-[#5c6d73]"
            data-testid={`badge-capability-files-${capability.type}`}
          >
            {capability.mutatesFiles ? 'TOUCHES FILES' : 'RECORDS ONLY'}
          </span>
          <span
            className={`inline-flex items-center gap-1 border px-2 py-1 archive-mono text-[9px] font-bold tracking-[.08em] ${chip.className}`}
            data-testid={`badge-capability-reversibility-${capability.type}`}
          >
            <ChipIcon size={11} /> {chip.label}
          </span>
        </div>
      )}
    </div>
  );
}

export function CapabilitySummary() {
  const { data, isLoading, isError, refetch } = useListActionCapabilities();

  if (isLoading) {
    return (
      <section className="archive-panel p-5" data-testid="panel-capabilities-loading">
        <div className="h-24 animate-pulse bg-[#f4f9f7]" />
      </section>
    );
  }

  if (isError) {
    return (
      <section className="archive-panel p-6 text-center" data-testid="panel-capabilities-error">
        <CircleAlert size={20} className="mx-auto mb-3 text-[#c85b51]" />
        <p className="text-[12px] leading-5 text-[#7d8c8f]">
          The capability list could not be read. Nothing is being assumed about what this
          installation can do.
        </p>
        <button
          onClick={() => refetch()}
          className="mt-3 inline-flex items-center gap-2 bg-[#1d2b38] px-4 py-2.5 text-[10px] font-bold tracking-[.1em] text-[#f5f6f3]"
          data-testid="button-retry-capabilities"
        >
          <RefreshCw size={13} /> RETRY
        </button>
      </section>
    );
  }

  const capabilities = data ?? [];
  const available = capabilities.filter((entry) => entry.supported);
  const planned = capabilities.filter((entry) => !entry.supported);

  return (
    <section className="archive-panel p-5 md:p-6" data-testid="panel-capabilities">
      <div className="archive-mono text-[9px] tracking-[.12em] text-[#7f9194]">CAPABILITIES / WHAT THIS CAN DO</div>
      <h3 className="archive-display mt-1 text-lg font-extrabold text-[#21303d]" data-testid="text-capabilities-headline">
        {available.length} of {capabilities.length} actions are available
      </h3>
      <p className="mt-1 max-w-2xl text-[12px] leading-5 text-[#5c6d73]">
        Every action below runs through the same review: you approve it, the engine re-checks the
        conditions, and the result is verified and recorded. The AI can propose, never approve.
      </p>

      <div className="mt-4" data-testid="list-capabilities-available">
        {available.map((capability) => (
          <CapabilityRow key={capability.type} capability={capability} />
        ))}
      </div>

      {planned.length > 0 && (
        <div className="mt-5 border-t border-[#e7ecea] pt-4" data-testid="list-capabilities-planned">
          <div className="archive-mono text-[9px] tracking-[.12em] text-[#7f9194]">
            DECLARED BUT NOT WIRED / {planned.length}
          </div>
          <div className="mt-2">
            {planned.map((capability) => (
              <CapabilityRow key={capability.type} capability={capability} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

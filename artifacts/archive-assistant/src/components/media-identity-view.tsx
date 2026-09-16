/**
 * The unified media world.
 *
 * Archive Assistant's premise is that the filesystem and Plex are two
 * observations of one media world, not two libraries to be connected. Until
 * now the product could only show the moments where that world needed a
 * mutation — a reconcile proposal — and never the world itself.
 *
 * This view renders the reconciliation report as one object per piece of
 * media: what is on disk, what Plex believes, and how the two relate. It is
 * deliberately read-mostly. Understanding is automatic; only mutation goes
 * through the action layer.
 *
 * The identity audit is folded in here rather than living at its own URL. It is
 * not a separate report; it is more knowledge about these same objects, so it
 * belongs on the object it describes. The audit answers the question the
 * reconciliation report cannot: "is what we believe about this file actually
 * sound?"
 *
 * It also gives the `uncertain` findings somewhere to live. The planner refuses
 * to propose them because asking an operator to rubber-stamp an ambiguous guess
 * is the failure mode approval exists to prevent — but refusing to propose is
 * not the same as hiding, and "I don't know, here is why" is a real answer.
 */
import { useState } from 'react';
import {
  CircleAlert,
  CircleHelp,
  FileQuestion,
  Layers,
  Link2,
  RefreshCw,
  ScanSearch,
  TriangleAlert,
} from 'lucide-react';
import {
  useGetArchiveIdentityAudit,
  useGetArchiveReconciliation,
  type IdentityAuditResult,
  type ReconciliationResult,
  type ReconciliationPlexItem,
} from '@workspace/api-client-react';

type Classification = 'matched' | 'local_only' | 'plex_only' | 'duplicate' | 'quality_conflict' | 'uncertain';

/**
 * Each classification stated as what it means for the operator, not as a
 * database category. The "meaning" line answers "so what?", which is the
 * question a raw classification never answers.
 */
const classificationCopy: Record<Classification, {
  label: string;
  meaning: string;
  tone: string;
  badge: string;
}> = {
  matched: {
    label: 'MATCHED',
    meaning: 'The archive and Plex agree about this item.',
    tone: 'border-[#b9d6cf]',
    badge: 'border-[#b9d6cf] bg-[#eaf3ef] text-[#39736e]',
  },
  quality_conflict: {
    label: 'QUALITY DIFFERS',
    meaning: 'Both sides have this item, but they do not describe it the same way.',
    tone: 'border-[#d9bd77]',
    badge: 'border-[#d9bd77] bg-[#fff8e7] text-[#8d681d]',
  },
  uncertain: {
    label: 'AMBIGUOUS',
    meaning: 'Several Plex items could be this file. Archive Assistant will not guess.',
    tone: 'border-[#d9bd77]',
    badge: 'border-[#d9bd77] bg-[#fff8e7] text-[#8d681d]',
  },
  local_only: {
    label: 'NOT IN PLEX',
    meaning: 'This file exists on disk but Plex does not know about it.',
    tone: 'border-[#d6dfdc]',
    badge: 'border-[#d6dfdc] bg-white text-[#5c6d73]',
  },
  plex_only: {
    label: 'NOT ON DISK',
    meaning: 'Plex lists this item but no archive file backs it.',
    tone: 'border-[#d6dfdc]',
    badge: 'border-[#d6dfdc] bg-white text-[#5c6d73]',
  },
  duplicate: {
    label: 'DUPLICATE',
    meaning: 'More than one archive file claims this identity.',
    tone: 'border-[#e0b3ad]',
    badge: 'border-[#e0b3ad] bg-[#fcedea] text-[#994b43]',
  },
};

/**
 * The eight audit types in the operator's language.
 *
 * The engine's `reason` string is always shown verbatim underneath; these
 * labels only name the category so a list of concerns can be skimmed. Nothing
 * here re-derives or second-guesses the finding.
 */
const auditTypeCopy: Record<string, string> = {
  suspicious_year: 'YEAR LOOKS WRONG',
  numeric_title: 'NUMBER IN TITLE',
  collection_prefix: 'COLLECTION FOLDER',
  missing_year: 'NO YEAR',
  year_conflict: 'YEAR DISAGREES',
  title_conflict: 'TITLE DISAGREES',
  multiple_candidates: 'SEVERAL MATCHES',
  unresolved: 'UNIDENTIFIED',
};

/**
 * Confidence here is confidence that the *concern is real*, not confidence in
 * a fix. A high-confidence title conflict means the system is sure the two
 * titles disagree — it says nothing about which one is correct. The wording
 * has to carry that distinction or it invites exactly the wrong conclusion.
 */
const auditConfidenceCopy: Record<string, string> = {
  high: 'Certain this is worth a look',
  medium: 'Probably worth a look',
  low: 'Weak signal',
};

function auditTypeLabel(auditType: string): string {
  return auditTypeCopy[auditType] ?? auditType.replace(/_/g, ' ').toUpperCase();
}

const FILTERS: readonly { id: 'all' | 'concerns' | Classification; label: string }[] = [
  { id: 'all', label: 'EVERYTHING' },
  { id: 'concerns', label: 'NEEDS REVIEW' },
  { id: 'matched', label: 'MATCHED' },
  { id: 'uncertain', label: 'AMBIGUOUS' },
  { id: 'quality_conflict', label: 'QUALITY' },
  { id: 'local_only', label: 'NOT IN PLEX' },
  { id: 'plex_only', label: 'NOT ON DISK' },
];

function strategyLabel(strategy: string): string {
  return strategy.replace(/_/g, ' ');
}

/** One piece of media, with both observations of it side by side. */
function IdentityRow({
  result,
  index,
  audits,
}: {
  result: ReconciliationResult;
  index: number;
  audits: IdentityAuditResult[];
}) {
  const classification = (result.classification as Classification) ?? 'uncertain';
  const copy = classificationCopy[classification] ?? classificationCopy.uncertain;
  const local = result.local;
  const plex = result.plex;
  const differences = result.quality?.differences ?? [];

  return (
    <div
      className={`border-l-2 ${copy.tone} bg-white p-4`}
      data-testid={`row-media-identity-${index}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-[#21303d]" data-testid={`text-identity-title-${index}`}>
            {plex?.title ?? local?.relativePath ?? local?.path ?? 'Unidentified item'}
          </div>
          <div className="mt-0.5 text-[11px] leading-5 text-[#5c6d73]">{copy.meaning}</div>
        </div>
        <span
          className={`shrink-0 border px-2.5 py-1.5 archive-mono text-[9px] font-bold tracking-[.1em] ${copy.badge}`}
          data-testid={`badge-identity-classification-${index}`}
        >
          {copy.label}
        </span>
      </div>

      {/* The two observations, always in the same order so the eye can compare. */}
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div className="border border-[#e7ecea] bg-[#f9fbfa] p-3">
          <div className="archive-mono text-[9px] tracking-[.12em] text-[#7f9194]">ON DISK</div>
          {local ? (
            <>
              <div className="mt-1 break-all text-[11px] leading-5 text-[#344851]" data-testid={`text-identity-local-${index}`}>
                {local.relativePath ?? local.path}
              </div>
              <div className="mt-1 archive-mono text-[9px] tracking-[.08em] text-[#a0afaf]">
                {local.mediaType?.toUpperCase()}{local.scanStatus ? ` / ${local.scanStatus.toUpperCase()}` : ''}
              </div>
            </>
          ) : (
            <div className="mt-1 text-[11px] leading-5 text-[#8b999c]" data-testid={`text-identity-local-${index}`}>
              No archive file backs this item.
            </div>
          )}
        </div>

        <div className="border border-[#e7ecea] bg-[#f9fbfa] p-3">
          <div className="archive-mono text-[9px] tracking-[.12em] text-[#7f9194]">IN PLEX</div>
          {plex ? (
            <>
              <div className="mt-1 text-[11px] leading-5 text-[#344851]" data-testid={`text-identity-plex-${index}`}>
                {plex.title}{plex.year ? ` (${plex.year})` : ''}
              </div>
              <div className="mt-1 archive-mono text-[9px] tracking-[.08em] text-[#a0afaf]">
                {plex.libraryName ?? 'LIBRARY'}{plex.ratingKey ? ` / ${plex.ratingKey}` : ''}
              </div>
            </>
          ) : (
            <div className="mt-1 text-[11px] leading-5 text-[#8b999c]" data-testid={`text-identity-plex-${index}`}>
              Plex does not list this item.
            </div>
          )}
        </div>
      </div>

      {/* Why the system believes what it believes. */}
      <div className="mt-2 flex flex-wrap items-center gap-3 archive-mono text-[9px] tracking-[.1em] text-[#8b999c]">
        <span data-testid={`text-identity-strategy-${index}`}>
          EVIDENCE / {strategyLabel(result.matchingStrategy ?? 'unknown').toUpperCase()}
        </span>
        {typeof result.candidateCount === 'number' && (
          <span>{result.candidateCount} {result.candidateCount === 1 ? 'CANDIDATE' : 'CANDIDATES'}</span>
        )}
      </div>

      {differences.length > 0 && (
        <div className="mt-2 text-[11px] leading-5 text-[#8d681d]" data-testid={`text-identity-differences-${index}`}>
          Differs on: {differences.join(', ')}.
        </div>
      )}

      {/*
        Ambiguity is shown, not hidden. The planner refuses to propose these,
        and the honest thing is to say why rather than drop them silently.
      */}
      {classification === 'uncertain' && (
        <div className="mt-3 border-l-2 border-[#f4b942] bg-[#fff8e7] p-3" data-testid={`panel-identity-ambiguity-${index}`}>
          <div className="archive-mono text-[9px] tracking-[.12em] text-[#8d681d]">NOT OFFERED AS AN ACTION</div>
          <p className="mt-1 text-[11px] leading-5 text-[#8d681d]">
            {result.ambiguityCandidates?.length
              ? `${result.ambiguityCandidates.length} Plex items match this file equally well, so confirming one would be a guess.`
              : 'The available evidence does not identify a single Plex item, so confirming one would be a guess.'}
          </p>
          {result.ambiguityCandidates?.length ? (
            <ul className="mt-2 space-y-1">
              {result.ambiguityCandidates.slice(0, 4).map((candidate: ReconciliationPlexItem, position: number) => (
                <li key={position} className="text-[11px] leading-5 text-[#8d681d]">
                  · {candidate.title ?? candidate.ratingKey}
                  {candidate.year ? ` (${candidate.year})` : ''}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}

      {/*
        What the identity audit noticed about this same file. One file can raise
        several concerns, so they are listed rather than collapsed to a verdict.
        Every line is engine text: `reason`, `evidence`, `recommendedInterpretation`.
      */}
      {audits.length > 0 && (
        <div className="mt-3 border border-[#e7ecea] bg-[#f9fbfa] p-3" data-testid={`panel-identity-audit-${index}`}>
          <div className="archive-mono text-[9px] tracking-[.12em] text-[#7f9194]">
            IDENTITY AUDIT / {audits.length} {audits.length === 1 ? 'CONCERN' : 'CONCERNS'}
          </div>
          <div className="mt-2 space-y-3">
            {audits.map((audit, position) => (
              <div key={`${audit.auditType}-${position}`} data-testid={`row-identity-audit-${index}-${position}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`border px-2 py-1 archive-mono text-[9px] font-bold tracking-[.1em] ${
                      audit.needsReview
                        ? 'border-[#d9bd77] bg-[#fff8e7] text-[#8d681d]'
                        : 'border-[#b9d6cf] bg-[#eaf3ef] text-[#39736e]'
                    }`}
                    data-testid={`badge-identity-audit-type-${index}-${position}`}
                  >
                    {auditTypeLabel(audit.auditType)}
                  </span>
                  <span className="archive-mono text-[9px] tracking-[.1em] text-[#a0afaf]">
                    {auditConfidenceCopy[audit.confidence] ?? audit.confidence}
                  </span>
                  {!audit.needsReview && (
                    <span className="archive-mono text-[9px] tracking-[.1em] text-[#39736e]">RESOLVED BY EVIDENCE</span>
                  )}
                </div>
                <p className="mt-1.5 text-[11px] leading-5 text-[#344851]">{audit.reason}</p>
                {audit.evidence.length > 0 && (
                  <ul className="mt-1 space-y-0.5" data-testid={`list-identity-audit-evidence-${index}-${position}`}>
                    {audit.evidence.map((line, evidenceIndex) => (
                      <li key={evidenceIndex} className="archive-mono text-[9px] leading-4 tracking-[.04em] text-[#7f9194]">
                        · {line}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-1.5 text-[11px] leading-5 text-[#5c6d73]">
                  {audit.recommendedInterpretation}
                </p>
              </div>
            ))}
          </div>
          {/*
            The audit reads evidence; it does not plan. Saying so prevents the
            panel from reading like a queue of pending fixes.
          */}
          <p className="mt-3 border-t border-[#e7ecea] pt-2 text-[11px] leading-5 text-[#7f9194]">
            Reading the evidence changed nothing. Any correction is a separate action you approve.
          </p>
        </div>
      )}
    </div>
  );
}

export function MediaIdentityView() {
  const [filter, setFilter] = useState<'all' | 'concerns' | Classification>('all');
  const { data, isLoading, isError, refetch } = useGetArchiveReconciliation({ page: 1, pageSize: 100 });
  /*
    The audit is a second read of the same world, joined on fileRecordId — an
    exact key both reports carry, so no path-string matching is needed. It is
    intentionally not allowed to fail the view: if the audit cannot be read the
    identity picture is still true, just less annotated.
  */
  const auditQuery = useGetArchiveIdentityAudit({ page: 1, pageSize: 200 });

  if (isLoading) {
    return (
      <section className="archive-panel p-5" data-testid="panel-media-identity-loading">
        <div className="h-32 animate-pulse bg-[#f4f9f7]" />
      </section>
    );
  }

  if (isError) {
    return (
      <section className="archive-panel p-6 text-center" data-testid="panel-media-identity-error">
        <CircleAlert size={22} className="mx-auto mb-3 text-[#c85b51]" />
        <h3 className="archive-display text-lg font-extrabold text-[#21303d]">The media world could not be read</h3>
        <p className="mx-auto mt-2 max-w-sm text-[12px] leading-5 text-[#7d8c8f]">
          No relationships are being inferred in the browser. Retry to read the current state.
        </p>
        <button
          onClick={() => refetch()}
          className="mt-4 inline-flex items-center gap-2 bg-[#1d2b38] px-4 py-2.5 text-[10px] font-bold tracking-[.1em] text-[#f5f6f3]"
          data-testid="button-retry-media-identity"
        >
          <RefreshCw size={13} /> RETRY
        </button>
      </section>
    );
  }

  const summary = data?.summary;
  const results = data?.results ?? [];

  const auditResults = auditQuery.data?.results ?? [];
  const auditsByFile = new Map<number, IdentityAuditResult[]>();
  for (const audit of auditResults) {
    const existing = auditsByFile.get(audit.fileRecordId);
    if (existing) existing.push(audit);
    else auditsByFile.set(audit.fileRecordId, [audit]);
  }
  const auditsFor = (entry: ReconciliationResult): IdentityAuditResult[] => {
    const fileRecordId = entry.local?.fileRecordId;
    return typeof fileRecordId === 'number' ? auditsByFile.get(fileRecordId) ?? [] : [];
  };
  /*
    "Needs review" is the engine's own needsReview flag, not a severity we
    invent. A corroborated finding stays visible on its row but does not pull
    the file into this filter.
  */
  const concernCount = auditResults.filter((audit) => audit.needsReview).length;
  const filesWithConcerns = results.filter((entry) => auditsFor(entry).some((audit) => audit.needsReview)).length;

  const visible = filter === 'all'
    ? results
    : filter === 'concerns'
      ? results.filter((entry) => auditsFor(entry).some((audit) => audit.needsReview))
      : results.filter((entry) => entry.classification === filter);

  const cards: { id: Classification | 'total'; label: string; value: number; icon: typeof Layers; tone: string }[] = [
    { id: 'total', label: 'LOCAL FILES', value: summary?.localCount ?? 0, icon: Layers, tone: 'text-[#39736e]' },
    { id: 'matched', label: 'MATCHED', value: summary?.matchedCount ?? 0, icon: Link2, tone: 'text-[#39736e]' },
    { id: 'uncertain', label: 'AMBIGUOUS', value: summary?.uncertainCount ?? 0, icon: CircleHelp, tone: 'text-[#8d681d]' },
    { id: 'quality_conflict', label: 'QUALITY', value: summary?.qualityConflictCount ?? 0, icon: TriangleAlert, tone: 'text-[#8d681d]' },
    { id: 'local_only', label: 'NOT IN PLEX', value: summary?.localOnlyCount ?? 0, icon: FileQuestion, tone: 'text-[#5c6d73]' },
    { id: 'plex_only', label: 'NOT ON DISK', value: summary?.plexOnlyCount ?? 0, icon: ScanSearch, tone: 'text-[#5c6d73]' },
  ];

  return (
    <section className="space-y-4" data-testid="panel-media-identity">
      <div>
        <div className="archive-mono text-[9px] tracking-[.12em] text-[#7f9194]">MEDIA IDENTITY / ONE WORLD, TWO OBSERVATIONS</div>
        <h3 className="archive-display mt-1 text-lg font-extrabold text-[#21303d]" data-testid="text-media-identity-headline">
          {summary?.localCount ?? 0} archive {summary?.localCount === 1 ? 'file' : 'files'} and {summary?.plexCount ?? 0} Plex {summary?.plexCount === 1 ? 'item' : 'items'}
        </h3>
        <p className="mt-1 max-w-3xl text-[12px] leading-5 text-[#5c6d73]">
          Archive Assistant reads both sides and works out what they have in common. Understanding
          happens automatically; nothing here changes a file or a record until you approve an action.
        </p>
      </div>

      {/*
        A standing summary of what the audit thinks, stated as a question of
        soundness rather than a count of errors. Silence here is meaningful, so
        the clean case says so explicitly instead of rendering nothing.
      */}
      {auditQuery.isError ? (
        <div className="border border-[#e1e8e5] bg-white p-3" data-testid="panel-identity-audit-unavailable">
          <p className="text-[11px] leading-5 text-[#7f9194]">
            The identity audit could not be read, so these items are shown without it. What you see
            below is still the current archive and Plex state.
          </p>
        </div>
      ) : auditResults.length > 0 ? (
        <div className="border-l-2 border-[#d9bd77] bg-[#fff8e7] p-3" data-testid="panel-identity-audit-summary">
          <div className="archive-mono text-[9px] tracking-[.12em] text-[#8d681d]">IDENTITY AUDIT</div>
          <p className="mt-1 text-[12px] leading-5 text-[#8d681d]" data-testid="text-identity-audit-summary">
            {concernCount > 0
              ? `${concernCount} ${concernCount === 1 ? 'concern' : 'concerns'} about what these files are, across ${filesWithConcerns} ${filesWithConcerns === 1 ? 'file' : 'files'}.`
              : `${auditResults.length} ${auditResults.length === 1 ? 'observation' : 'observations'}, all resolved by evidence. Nothing needs your review.`}
          </p>
        </div>
      ) : !auditQuery.isLoading ? (
        <div className="border-l-2 border-[#b9d6cf] bg-[#eaf3ef] p-3" data-testid="panel-identity-audit-clean">
          <div className="archive-mono text-[9px] tracking-[.12em] text-[#39736e]">IDENTITY AUDIT</div>
          <p className="mt-1 text-[12px] leading-5 text-[#39736e]" data-testid="text-identity-audit-summary">
            No identity problems found. Every observed file has a title and year the evidence agrees with.
          </p>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
        {cards.map((card) => (
          <div key={card.id} className="border border-[#e1e8e5] bg-white p-3" data-testid={`stat-identity-${card.id}`}>
            <card.icon size={14} className={card.tone} />
            <div className="mt-2 archive-display text-xl font-extrabold text-[#21303d]">{card.value}</div>
            <div className="archive-mono text-[9px] tracking-[.1em] text-[#8b999c]">{card.label}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-1">
        {FILTERS.map((entry) => (
          <button
            key={entry.id}
            onClick={() => setFilter(entry.id)}
            className={`border px-3 py-2 archive-mono text-[9px] font-bold tracking-[.1em] ${
              filter === entry.id
                ? 'border-[#1d2b38] bg-[#1d2b38] text-[#f5f6f3]'
                : 'border-[#d6dfdc] bg-white text-[#5c6d73]'
            }`}
            data-testid={`button-identity-filter-${entry.id}`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {visible.length ? (
        <div className="space-y-2" data-testid="list-media-identity">
          {visible.map((result, index) => (
            <IdentityRow
              key={`${result.classification}-${index}`}
              result={result}
              index={index}
              audits={auditsFor(result)}
            />
          ))}
        </div>
      ) : (
        <div className="archive-panel p-8 text-center" data-testid="panel-media-identity-empty">
          <p className="text-[12px] leading-6 text-[#7d8c8f]">
            {!results.length
              ? 'No media has been observed yet. Run an archive scan and a Plex sync to build the picture.'
              : filter === 'concerns'
                ? 'No file currently needs an identity review.'
                : 'Nothing in this category right now.'}
          </p>
        </div>
      )}
    </section>
  );
}

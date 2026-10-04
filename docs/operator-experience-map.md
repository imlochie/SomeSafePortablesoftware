# Operator experience map

Status: proposal, September 2026. Nothing here is built. This document maps the
intended operator experience and, for each screen, records what the existing
API can serve today and what would have to be built. It is written to be argued
with before any UI work starts.

The guiding change is a shift in what the application is for:

> Current: here are the systems inside Archive Assistant.
>
> Intended: here is what your archive is, what I understand about it, what is
> happening, and what you can do next.

## The problem, stated precisely

The navigation is organised by subsystem — Home, Assistant, Queue, Archive,
Plex, Sources, History, Settings. That mirrors the architecture, so the
operator has to do the synthesis the application should be doing.

But the deeper problem is not layout. It is that **the application reports its
internal counters rather than interpreting them**, and the counters are
currently misleading.

### The 42,605 problem

`syncControlPlaneReviewItems` in `services/review-sync.ts` creates one review
item per naming proposal and **one per archive record whose review status is
not `not_applicable`**, with no severity filter. A record becomes reviewable
whenever its `qualityStatus` is one of `duplicate`, `lower_quality_version`,
`higher_quality_available`, `file_missing` or `needs_review`
(`reviewableQualityStatuses`, `services/archive.ts`).

`higher_quality_available` is assigned when the local file **ranks higher** than
the matched Plex version. That is good news about the archive. It is not a
decision the operator needs to make, and on a large archive it is tens of
thousands of rows.

So "42,605 awaiting review" does not mean 42,605 decisions. It means: every
file that differs from Plex in any direction produced a row. The number is
technically correct and operationally meaningless, which is worse than being
wrong, because it looks authoritative.

**This is a data-model gap, not a presentation gap.** No severity or priority
concept exists on archive findings anywhere in the API: `grep` for `priority`
or `severity` across `services/archive.ts` and `services/review-sync.ts`
returns nothing. Acquisition recommendations do have `priority`
(`services/acquisition-intelligence.ts`), which is the model to copy.

No amount of UI redesign fixes this. A prettier screen rendering 42,605
undifferentiated rows is still unusable. **Severity has to be introduced in the
API first**, and that ordering is the single most important conclusion in this
document.

## The four layers

The vocabulary the interface should enforce, and never blur:

| Layer | Meaning | Example | Where it lives today |
|---|---|---|---|
| Fact | Something the system knows | This file exists; Plex has this item; these two files share a SHA-256 | `file_record`, `plex_item`, scan results |
| Finding | Something the system discovered | These files appear related; this Plex item has no local file | `qualityStatus`, reconciliation results |
| Recommendation | What the system thinks you should do | Keep this version; rename this file | `acquisition_recommendation`, naming proposals |
| Action | Something that changes state | Move, rename, delete, acquire | `archive_operation`, acquisition jobs |

The existing architecture already separates these. The interface does not
currently express the separation, which is why a raw finding count reads as if
it were a queue of pending actions.

## Confidence

Every finding should carry, and show, how strongly it is believed:

- **Certain** — identical checksums. No judgement required.
- **Likely** — fingerprint, runtime and codec match; metadata differs.
- **Needs verification** — a relationship was found, evidence is weak.
- **Observation** — noticed, no action recommended.

The engines already compute this distinction; `archive.ts` distinguishes an
exact SHA-256 duplicate from a normalised-fingerprint duplicate, and states the
difference in `qualitySummary`. The identity audit exposes a `byConfidence`
breakdown. The classification exists in the data and is discarded at the
presentation boundary.

Confidence and severity are different axes and both are needed. A certain
finding can be unimportant (an exact duplicate of a 2 MB sample file); an
uncertain one can be urgent (a possible corruption in a rare recording).

---

## Screen by screen

### 1. Overview — the archive command centre

Replaces Home. Answers: what is my archive, what is wrong, what do you want
from me.

```
Your archive is connected and understood.
  37,572 local files · 35,000 Plex items · last analysed 2 minutes ago

  Plex connected and synchronised
  309 duplicate groups detected
  167 files require investigation

WHAT NEEDS ATTENTION
  Fixable now        167 scan failures            Review failures →
  Decisions needed   309 duplicate groups         Review duplicates →
  Recommendations    N acquisition suggestions    Open recommendations →
```

**Servable today:** every count above. `readArchiveInventory().summary` provides
`duplicateCount`, `missingCount`, `qualityConflictCount`, `plexOnlyCount`,
`localOnlyCount`, `integrityFailureCount`, `inspectionFailureCount`,
`healthStatus`, `reviewedCount`, `unresolvedCount`. Reconciliation provides
matched and local/Plex-only counts. Recommendations carry `priority` already.

**Needs building:** the tiering itself. "Fixable now" versus "decisions needed"
versus "observations" is a severity judgement the API does not currently make.
Also **duplicate *groups***: the API reports duplicate *files*
(`duplicateCount`), not groups. 309 groups and 618 duplicate files are
different statements and the interface must not conflate them.

### 2. Assistant — archive intelligence

Stops dumping counters; interprets them.

```
I analysed 37,572 files and compared them with your Plex inventory.

  167 problems            files that could not be fully processed
  309 duplicate groups    multiple copies of the same media
  4,205 decisions         enough evidence to suggest an action
  18,000+ observations    metadata differences, no action recommended

RECOMMENDED NEXT ACTION
  Review duplicate movie files
  Most appear to be identical copies with different filenames.
                                                  Review 309 groups →
```

**Servable today:** the underlying findings.

**Needs building:** the split between "decisions" and "observations" — the
severity work again — and the "recommended next action" selection, which is a
new ranking concept. Note this screen is where the 42,605 number currently
appears; it cannot be fixed here, only downstream of severity.

### 3. Discoveries — findings with evidence

A finding should read as an argument, not a label:

```
The Matrix (1999)                            Possible duplicate
High confidence
Two copies with identical runtime, resolution and matching fingerprints.

  D:\Archive\Movies\The Matrix (1999).mkv        8.4 GB  1080p
  F:\Movies\Matrix\The Matrix 1999 1080p.mkv     8.4 GB  1080p

SUGGESTED ACTION  keep the higher-quality copy, archive the other
                                                     Review decision →
```

**Servable today:** `qualitySummary`, `qualityDifferences`, `duplicateOfId`,
`plexMatch`, checksums and the full file metadata are all on the inventory
record. The evidence exists; it is simply not rendered as evidence.

**Needs building:** grouping duplicates into groups rather than listing paired
rows, and the confidence label as a first-class field rather than something
inferred from prose.

### 4. Archive — an explorer, not a dashboard

Browse by location, media type, issues, duplicates, quality versions, recently
discovered. Full-text search across the archive. Filters for movies, TV,
unmatched, duplicates, needs review.

**Servable today:** the record set and all filter dimensions exist. Naming
proposals and identity audit already support server-side filtering and
pagination.

**Needs building:** search. There is no text-search endpoint over
`file_record`, and doing it client-side over 37k records is not viable. This is
a real backend addition, though a small one.

### 5. Activity — watch the machine think

The live feed already streams nine event types over SSE
(`services/scan-events.ts`, `use-archive-scan-events.ts`) and
`archive-scan-panel.tsx` renders per-file stages. The substance exists; it is
underexposed. Progress, the current file, the latest discovery and a running
log should be prominent during a scan rather than a status strip.

**Servable today:** essentially all of it.

**Needs building:** mostly presentation. Worth noting this is the cheapest
high-impact screen in the list.

### 6. Connections — Plex as a sense, not a department

Once configured, Plex is one input among several. Group Plex, the local
archive, sources and acquisition providers under one Connections screen, each
showing status, scale and a way in.

**Servable today:** all of it. `useGetIntegrationStatuses` already reports
operational state per adapter; Plex and Jellyfin are already interchangeable
providers.

**Needs building:** nothing beyond layout. This is pure information
architecture.

### Proposed navigation

```
Overview      what is happening and what needs attention
Archive       browse and understand everything you have
Discoveries   duplicates, conflicts, missing media, relationships
Assistant     recommendations and decisions
Activity      live jobs, queue and history
Connections   Plex, providers, sources, storage
Settings
```

Seven items, same as today, but ordered by the operator's journey rather than
by subsystem. Queue and History collapse into Activity; Plex and Sources
collapse into Connections; Discoveries is new and is where the current Archive
page's finding lists belong.

---

## Sequencing

The screens are not independent, and building them in the wrong order produces
a prettier version of the current problem.

1. **Severity and finding groups in the API.** Classify findings into
   actionable versus observational; group duplicates into groups. Without this
   the Overview and Assistant screens cannot be honest. This is the blocking
   dependency.
2. **Overview.** Highest value per unit of work once severity exists.
3. **Activity.** Cheapest real improvement; the data already streams.
4. **Discoveries.** Evidence-first finding presentation.
5. **Connections.** Pure layout.
6. **Archive explorer.** Largest, and needs a search endpoint.

## What this does not change

The safety model stays exactly as it is. Findings recommend; only an approved,
preflighted, explicitly confirmed operation mutates a file. Nothing in this
redesign introduces a path from a finding to a filesystem change that skips
review — and the four-layer vocabulary above exists partly to make such a
shortcut obviously wrong if anyone proposes one later.

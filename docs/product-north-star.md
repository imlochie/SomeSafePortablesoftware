# Product North Star: Minimize Human Media-Archive Mental Load

Archive Assistant exists to reduce the cognitive effort required to maintain, understand, curate, and use a personal media archive.

The system should absorb complexity internally and present the user with:

1. what matters;
2. why it matters;
3. what the system already knows;
4. what is uncertain;
5. what, if anything, the user needs to decide.

The user should not need to understand scanner lifecycles, reconciliation records, acquisition jobs, provider adapters, archive operations, identity audits, research synthesis, or evidence graphs. Those are implementation concepts.

The product translates them into human concepts:

```text
Watch · Fix · Review · Add · Investigate · Wait · Done
```

## Workload rule

The Assistant should consolidate low-level findings into the smallest number of meaningful human decisions. A page containing many technically distinct findings is not necessarily useful.

A workload item should leave active attention when it is:

- resolved;
- consciously deferred;
- explicitly dismissed;
- waiting on an external dependency; or
- no longer relevant.

The default state should be calm. If nothing important requires attention, say so clearly.

## Progressive disclosure

Information is revealed in layers:

```text
summary → explanation → evidence → technical detail
```

Long reasoning, evidence, provenance, and diagnostic sections are collapsed by default. Raw IDs, provider payload details, and operational diagnostics belong at the deepest level.

## Product flow

```text
OBSERVE
   ↓
UNDERSTAND
   ↓
FILTER
   ↓
PRIORITIZE
   ↓
EXPLAIN
   ↓
ASK ONE HUMAN QUESTION
   ↓
EXECUTE SAFELY
   ↓
VERIFY
   ↓
GET OUT OF THE WAY
```

Recommendations, research, and curation must not silently become acquisition actions. Human approval and the existing control-plane boundaries remain authoritative.

## Feature discoverability rule

Every major capability must have:

- one canonical UI home;
- one clear entry point;
- predictable return navigation;
- a useful default state;
- explicit empty, blocked, uncertain, and unavailable states;
- a clear human decision, if one is needed;
- a visible completion or waiting state.

Capabilities must not exist only as APIs or hidden developer surfaces.

## The Grandma Test

Important workflows must be usable by someone with no Plex, provider, acquisition, identity, or archive-management knowledge.

For every workflow, the UI must make these questions answerable without specialist context:

```text
What am I looking at?
Why is this here?
What decision am I being asked to make?
What happens if I press this?
What will change if I approve it?
If something fails, did anything actually change?
What does the system know, think, or not know?
```

Translate implementation concepts into human language. For example:

```text
Acquisition recommendation #4821
  → The Bear is missing 2 episodes

Identity confidence: 0.82
  → I'm fairly confident these are the right episodes

Provider unavailable
  → I can't check your Plex library right now

Operation awaiting approval
  → Ready to add these episodes; review before I make changes
```

The user should be able to rely on the system without being afraid of breaking the archive.

## Unified workload

The user should never have to remember where they saw something. Home, Assistant, Queue, and History form one continuous story:

```text
found
  → explained
  → waiting for you
  → approved
  → being handled
  → verified
  → done
```

Other valid paths include:

```text
found → uncertain → waiting
found → waiting on external dependency
found → dismissed → removed from active workload
```

The product should summarize workload across surfaces in human terms:

```text
2 things need you
3 things are being handled
1 thing is waiting
4 interesting things found
Nothing else needs your attention.
```

A user should be able to investigate an item in Assistant, follow its progress in Queue, and find the verified outcome in History without mentally stitching those systems together.

## Design goal

```text
simple at first glance,
powerful when explored,
and increasingly helpful as the system learns the archive.
```

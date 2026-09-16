# UI Information Architecture

This document is the product-wide UI contract for Archive Assistant. It applies across the Home, Assistant, Discover, Archive, Queue, Providers, History, and Settings surfaces. New intelligence features must fit this structure rather than adding another isolated dashboard panel.

## Stable mental jobs

```text
HOME       What matters?
ASSISTANT   Investigate and reason
DISCOVER   What is out there?
ARCHIVE    What is physically here?
QUEUE      What is happening?
PROVIDERS  What do external systems know?
HISTORY    What happened?
SETTINGS   How does it work?
```

Internal milestone names such as v2, v3, v4, v5, v6, and v7 must not become user-facing navigation concepts.

## Home hierarchy

Home is the calm briefing surface:

```text
What deserves attention
Continue watching
Media pulse
Discover
Archive health
```

It should prioritize meaningful decisions over raw finding counts. The default question is:

> What matters right now?

Suggested workload groupings are:

```text
NOW       needs attention
SOON      worth doing, not urgent
WAITING   blocked by an external dependency
INTERESTING discovered and worth exploring
NOTHING   healthy; no decision needed
```

## Assistant hierarchy

Assistant is where the user investigates a question or explanation:

```text
Why this?
Evidence
Research
Decisions
```

Research synthesis, multi-perspective reasoning, profile context, and curation should be progressively disclosed rather than rendered as simultaneous full-detail panels.

## Shared disclosure grammar

Every insight or media card should use the same information layers:

### Always visible

- title;
- status or priority;
- one-sentence reason;
- primary human action, if one exists.

### Expandable

- why this matters;
- supporting evidence;
- counter-evidence;
- unknowns;
- conflicts;
- confidence;
- archive state.

### Advanced

- source chips;
- provider details;
- raw IDs;
- provenance;
- diagnostics.

Technical detail should never be the default presentation.

## Reusable visual grammar

Future UI work should reuse shared primitives equivalent to:

```text
InsightCard
EvidenceDisclosure
ReasoningPanel
PriorityBadge
ConfidenceBadge
UnknownState
BlockedState
SourceChip
Timeline
MediaCard
Section
EmptyState
```

A new feature should compose these primitives instead of introducing a bespoke visual language.

## State handling

Every feature must define:

- loading;
- empty;
- unavailable;
- blocked;
- uncertain;
- ready;
- completed or dismissed.

Unknown data should be summarized when it is not useful at the top level. For example:

```text
3 details unavailable
```

with the individual unknowns available through disclosure.

## Navigation and completion

Each capability has one canonical home and a predictable path back. A task should disappear from active workload after resolution, conscious deferral, dismissal, external blocking, or loss of relevance.

A clean UI is not one that removes functionality. It is one that reorganizes functionality so that complexity appears only when the user asks for it.

## Accessibility and density

The interface should adapt to evidence density:

- sparse evidence produces a compact card with one clear reason;
- rich evidence produces collapsed sections that can be explored;
- long content never expands by default solely because it exists;
- priority, confidence, blocked, and unknown states must not depend on color alone;
- keyboard and screen-reader paths must reach disclosure controls and primary actions.

## Acceptance rule for future features

A feature is not complete merely because an endpoint and component exist. It is complete when a user can discover it, understand why it matters, inspect evidence if needed, make the requested decision, and understand when the work is finished or waiting.

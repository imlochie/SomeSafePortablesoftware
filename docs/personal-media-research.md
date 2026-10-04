# Personal Media Research Engine v1

The first research source is TVMaze's documented public API. It is used only for explicit, read-only title search and bounded research. The application does not crawl the catalog or scrape pages. TVMaze supplies show identity, premiere date, genres, a 10-point rating when available, and a provider `weight` retained as source data. Missing fields remain unavailable.

## v1 external search

`GET /api/assistant/research?query=...` performs an explicit TVMaze search and evaluates archive state and watch-history evidence. Research does not mutate acquisition, archive, Plex, Jellyfin, or playback state.

## v2 relationship candidate generation

`GET /api/assistant/research/history` performs an explicit, bounded, one-hop expansion from watched provider items. It uses exact title plus compatible year matching against TVMaze before expansion; uncertain seeds are not expanded. Supported relationships are direct `same_cast` and `same_creator` credits. Each relationship retains the watched source item, person ID/name, provider candidate ID, and direct strength. Candidates already present by normalized title are filtered; ambiguous archive matches remain uncertain.

The request is bounded to 20 watched seeds and 100 candidates. Genre, era, franchise, semantic similarity, embeddings, and recursive expansion are not used for candidate generation because this source does not provide a trustworthy bounded relationship endpoint for those concepts.

## v3 contextual evaluation

`GET /api/assistant/research/evaluations` consumes the bounded v2 candidate set and exposes `personalRelevance`, `confidence`, `whyYou`, `whyThis`, `whyNow`, `recommendationEvidence`, and `unknowns`.

Recent or repeated watched evidence, or multiple converging relationships, can produce high relevance; one relationship alone produces medium relevance; no personal evidence produces unknown. Confidence is separate and is reduced when rating or archive identity evidence is unavailable or uncertain. No numeric score or ranking is produced.

## v4 multi-source synthesis

`GET /api/assistant/research/synthesis` consumes the v3 evaluated candidate set and reconciles TVMaze evidence with the official IMDb access boundary. IMDb is used only when the server has configured `IMDB_API_URL_TEMPLATE` and `IMDB_API_TOKEN`; otherwise its status is `unavailable: not_configured`. The configured URL must be an authorized official IMDb API/Data Exchange endpoint; the application does not scrape IMDb.com.

TVMaze audience ratings and IMDb audience ratings are comparable audience metrics for agreement/conflict detection. IMDb popularity and vote-count metrics remain separate from rating. Critic metrics are never compared directly with audience ratings. Comparable audience ratings within one point support agreement; a difference of one point or more is reported as a conflict.

Source evidence preserves source IDs, categories, values, scales, observation times, and provenance. Missing metrics become unknown, not negative evidence. Personal relevance, confidence, `whyYou`, `whyThis`, and `whyNow` are preserved from v3. No universal score or ranking is introduced.

A research recommendation is not an acquisition recommendation. All research endpoints are read-only and do not create jobs, approvals, downloads, playback changes, or archive mutations. This is not yet deep research: there is no multi-provider identity graph, review synthesis, franchise graph, or watchlist integration.

## v5 personalized curation

`GET /api/assistant/research/curation` consumes the v4 synthesis set and exposes two independent ranked views: `watch` and `archive`. Watch priority favors active and recent related viewing, then other watched relationships. Archive priority favors repeated viewing, converging relationships, and a confirmed archive gap. The two views use the same candidate identity but retain separate reasons and ranks; there is no universal score.

Actual viewing remains stronger than downloaded/archive presence. Archive state and approval state are preserved as context. Every curation item includes priority type, priority, rank, reasons, supporting evidence, conflicts, unknowns, confidence, archive state, and `approvalState: not_created`. Curation does not create acquisition jobs or approvals. Ranking is deterministic and ends at read-only watch/archive candidates.

## v6 personal media reasoning

`GET /api/assistant/research/reasoning` consumes the v4 evidence and produces a structured reasoning argument for each candidate. It preserves supporting evidence, counter-evidence, pattern evidence, current context, archive gaps, unknowns, evidence references, and separate watch/archive conclusions.

Reasoning can conclude `strong_watch_candidate`, `watch_candidate`, `strong_archive_candidate`, `archive_candidate`, `interesting_but_uncertain`, `research_further`, `not_recommended`, `already_satisfied`, or `archive_redundant`. The current deterministic implementation favors recent/repeated viewing and converging relationships, but does not create a universal score. Missing evidence remains unknown; archive uncertainty produces counter-evidence against a strong permanent-collection claim.

The reasoner enriches v5 but does not replace its deterministic priority model. It does not create acquisition jobs, approvals, downloads, or archive mutations. Evidence, reasoning, conclusion, priority, and acquisition remain separate layers.

## v7 personal media profile and archive graph

`GET /api/assistant/media-profile` exposes a bounded owner-scoped profile built from synchronized media experience. It distinguishes observed values, such as watched items and play counts, from derived values, such as genre cluster counts and recent windows. Watched hours remain explicitly estimated from provider duration and play-count evidence.

`GET /api/assistant/archive-context` exposes the derived archive graph context. Current clusters use provider-supported genre metadata and explicit counts. Redundancy context is surfaced only where archive density is high and observed engagement is low. Meaningful missing-title gaps remain unavailable until research identity evidence can support them; uncertain identities are not treated as missing. Acquisition-to-watch conversion is currently unknown because no reliable cross-domain linkage is available.

V7 provides person/archive context to v6 reasoning. It does not create a new recommendation engine, infer personality, use embeddings, modify v5 priorities, or create acquisition actions. The architectural separation remains:

```text
v7 context generation → v6 reasoning → v5 curation → separate acquisition control plane
```

The reasoning result also exposes explicit perspectives for personal taste, current context, long-term affinity, archive value, archive gap, relationships, external evidence, novelty, temporal relevance, practical availability, identity quality, counter-evidence, and unknowns. These are structured explanations, not a universal score. Perspectives that are unsupported by current data say so explicitly.

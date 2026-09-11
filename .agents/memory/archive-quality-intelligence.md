---
name: Archive quality intelligence
description: Technical quality findings are derived from a normalized model, judged by dominance, and reviewed through archive_review evidence.
---

Quality conclusions come from one normalized `TechnicalQuality` model (`services/media-quality.ts`) built from metadata the app already stores: the FFprobe probe output, `file_record` columns, and cached Plex media/part rows. Never add a second media-inspection path or a second place that interprets probe JSON.

Comparison is dominance-based, not score-based: an encode wins only when it is at least as good on every comparable measured axis and strictly better on at least one. Axes are tiered — `ranked` (resolution by pixel area with tolerance, dynamic range, codec generation, bit depth, per-generation bitrate, audio codec/channels/bitrate), `escalating` (duration, checksum, framerate, languages, provenance: real differences that are never ordered), `informational` (container, profile, size, location, bitstream noise). Unknown is never worse; missing bitrate is not comparable across codec generations; a resolution gain with far fewer bits per pixel yields no winner.

Findings (`services/archive-quality.ts`) are derived on read and are review-only: `exact_duplicate`, `probable_duplicate`, `lower_quality_duplicate`, `superior_encode`, `materially_different_encode`, `conflicting_quality_metadata`, `missing_technical_metadata`. Nothing may delete, move, or replace media on the strength of a finding.

**Why:** Byte-identity is the only deterministic duplicate evidence, so `file_record.checksum` must actually be populated by the scanner (it was hard-coded to `null`, which silently made `exact_duplicate` unreportable). Review state must follow evidence: a finding keeps its decision while its measured inputs are unchanged and reopens when they change.

**How to apply:** Finding evidence keys hash the measured metadata (never the path or volume, so renames do not reopen), so any new field folded into a comparison must also be folded into the evidence digest deliberately. SQLite UPSERT statements do not update `last_insert_rowid` on the `DO UPDATE` path — resolve identity rows by `(owner_id, identity_key)`, not by the returned rowid, or records get cross-linked onto unrelated identities. Keep `coarseQualityScore`/`legacyQualityDifferences` compatible shims so existing `qualityStatus` strings and stored review evidence keys do not shift under a refactor.

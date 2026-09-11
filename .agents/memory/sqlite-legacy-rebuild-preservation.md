---
name: SQLite legacy rebuild preservation
description: Rule for rebuilding populated SQLite tables during ownership migrations without silently dropping historical metadata.
---

When SQLite forces a table rebuild for ownership or uniqueness changes, preserve every compatible legacy column dynamically and add only genuinely new columns with safe defaults.

**Why:** A narrow replacement projection can make the migration pass while silently discarding archive links, scan evidence, media metadata, identity references, and raw failure details from existing rows.

**How to apply:** Maintain an explicit compatible-column allowlist, intersect it with the legacy schema, and test a populated pre-migration fixture with representative data from each preserved field group.
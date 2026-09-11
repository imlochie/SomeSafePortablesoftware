---
name: Generated contract builds
description: Shared generated API packages can expose stale declaration output during workspace type checks.
---

When generated API source contains a contract that consumers cannot see, rebuild the referenced generated packages before changing application code.

**Why:** Workspace package references may resolve declaration output instead of the current generated source, making valid endpoints appear missing until the declarations are refreshed.

**How to apply:** Run the repository’s TypeScript build for the affected generated packages, then rerun the consumer type checks.

For response counters, use an OpenAPI number with `multipleOf: 1` instead of integer when targeting the current generator/Zod combination.

**Why:** Orval emits `zod.int()` for response integer fields, but the installed Zod version does not expose that API; generated builds fail even though path parameter integers work.

**How to apply:** Keep the server-side values integer-valued and express that constraint as `number` plus `multipleOf: 1` in response schemas.

Isolated Orval regeneration must preserve the workspace root TypeScript and package metadata, not only the API packages and specification.

**Why:** Without the root workspace metadata, Orval can resolve the same custom fetch source but infer a different mutator signature, producing false stale-output differences.

**How to apply:** When generating into a temporary workspace for drift checks, copy the root TypeScript, package, and pnpm workspace files and make installed modules resolvable there.
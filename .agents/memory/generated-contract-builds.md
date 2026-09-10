---
name: Generated contract builds
description: Shared generated API packages can expose stale declaration output during workspace type checks.
---

When generated API source contains a contract that consumers cannot see, rebuild the referenced generated packages before changing application code.

**Why:** Workspace package references may resolve declaration output instead of the current generated source, making valid endpoints appear missing until the declarations are refreshed.

**How to apply:** Run the repository’s TypeScript build for the affected generated packages, then rerun the consumer type checks.
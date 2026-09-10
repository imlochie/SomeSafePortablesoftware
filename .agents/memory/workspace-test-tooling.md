---
name: Workspace test tooling
description: Where shared frontend test dependencies are kept in this pnpm workspace.
---

Shared frontend test dependencies are installed at the pnpm workspace root when the package installer cannot target an individual artifact.

**Why:** The workspace package manager rejects unscoped package additions from an artifact and the installer does not accept workspace filter flags as package arguments.

**How to apply:** Keep artifact-specific test scripts and configs inside the artifact, while resolving shared Vitest and Testing Library dependencies from the workspace root.
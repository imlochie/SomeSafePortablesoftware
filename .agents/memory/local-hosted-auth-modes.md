---
name: Local and hosted auth modes
description: The durable authentication boundary for desktop-local and future hosted operation.
---

ARCHIVE ASSISTANT supports explicit `local` and `clerk` authentication modes. Local mode uses a dedicated stable `__local__` owner resolved by the server; it never reuses `__legacy__` or accepts an owner ID from the browser. Clerk mode continues resolving ownership from Clerk.

**Why:** The primary product is a personal Windows desktop application that should not require interactive cloud login, while the ownership boundary and future hosted multi-user option must remain intact.

**How to apply:** Keep ownership filters active in both modes, never silently reassign Clerk-owned rows, and let a future Tauri shell provide loopback binding, paths, and API base URL through centralized runtime configuration.
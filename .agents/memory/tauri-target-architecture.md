---
name: Tauri target architecture
description: How desktop build hooks identify the architecture being packaged
---

Tauri v2 supplies the target architecture to `beforeBuildCommand` through `TAURI_ENV_ARCH` (`x86_64` or `aarch64`), while Node’s `process.arch` describes the process running the hook. Packaging decisions must prefer the Tauri variable and only use `process.arch` for direct Windows staging commands.

**Why:** A Windows build can target a different architecture from the host process, and selecting tools from the host alone can produce an installer with incompatible executables.

**How to apply:** Normalize Tauri’s architecture values to the project’s supported bundle keys, reject unsupported targets before downloading or bundling resources, and preserve the target triple in the selected bundle manifest.
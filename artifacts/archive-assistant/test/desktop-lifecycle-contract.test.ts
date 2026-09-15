import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

async function read(relativePath: string) {
  return readFile(resolve(root, relativePath), 'utf8');
}

describe('desktop lifecycle foundation', () => {
  it('uses the deterministic assistant overview as a Home briefing', async () => {
    const app = await read('src/App.tsx');
    expect(app).toContain('useGetAssistantOverview');
    expect(app).toContain('panel-assistant-overview');
    expect(app).toContain('Evidence-backed recommendations');
  });

  it('does not present blocked acquisition rows as ordinary approval work', async () => {
    const app = await read('src/App.tsx');
    expect(app).toContain('blockedRecommendationIds');
    expect(app).toContain('actionableReviews');
    expect(app).toContain('panel-blocked-review-items');
    expect(app).toContain('approval is not meaningful until their provider or source blocker is resolved');
  });
  it('keeps the tray as a thin router over existing control-plane actions', async () => {
    const source = await read('src-tauri/src/main.rs');
    expect(source).toContain('Start/resume archive scan');
    expect(source).toContain('Sync Plex');
    expect(source).toContain('View Activity');
    expect(source).toContain('Settings');
    expect(source).toContain('app.emit("tray://action"');
    const app = await read('src/App.tsx');
    expect(app).toContain("fetch(apiUrl('/api/archive/scan')");
    expect(app).toContain("fetch(apiUrl('/api/plex/sync')");
  });

  it('configures signed release updates rather than development commits', async () => {
    const config = await read('src-tauri/tauri.conf.json');
    expect(config).toContain('github.com/imlochie/SomeSafePortablesoftware/releases/latest/download/latest.json');
    expect(config).toContain('dW50cnVzdGVkIGNvbW1lbnQ6');
    expect(config).not.toContain('localhost');
    const app = await read('src/App.tsx');
    expect(app).toContain("invoke<UpdateStatus>('check_for_update')");
    expect(app).toContain('Nothing installs without operator approval.');
  });

  it('keeps the per-user database path outside the update bundle', async () => {
    const source = await read('src-tauri/src/main.rs');
    expect(source).toContain('ARCHIVE_DB_PATH');
    expect(source).toContain('app_local_data_dir()');
    expect(source).toContain('download_and_install');
  });

  it('prevents native window close from exiting the resident process', async () => {
    const shell = await read('src-tauri/src/main.rs');
    expect(shell).toContain('window.on_window_event');
    expect(shell).toContain('WindowEvent::CloseRequested');
    expect(shell).toContain('api.prevent_close()');
    expect(shell).toContain('close_window.hide()');
    expect(shell).toContain('app.manage(state)');
    expect(shell).toContain('state.shutdown()');
    expect(shell).toContain('api.prevent_exit()');
    expect(shell).toContain('allow_exit');
    expect(shell).toContain('lifecycle.log');
    expect(shell).toContain('WINDOW_CLOSE_REQUESTED');
    expect(shell).toContain('APP_EXIT_REQUESTED');
    expect(shell).toContain('TRAY_');
    expect(shell).toContain('show_main_window(app)');
    // Shutdown is reserved for an actual application exit, not the window X.
    expect(shell).not.toMatch(/CloseRequested[\s\S]{0,500}state\.shutdown\(\)/);
  });

  it('keeps the same sidecar-backed API available to reopen and tray actions', async () => {
    const shell = await read('src-tauri/src/main.rs');
    const app = await read('src/App.tsx');
    expect(shell).toContain('fn open_archive_assistant');
    expect(shell).toContain('window.show()');
    expect(shell).toContain('window.set_focus()');
    expect(app).toContain("listen<string>('tray://action'");
    expect(app).toContain("fetch(apiUrl('/api/archive/scan'), { method: 'POST' })");
    expect(app).toContain("fetch(apiUrl('/api/plex/sync'), { method: 'POST' })");
    expect(shell).toContain('app.exit(0)');
    expect(shell).toContain('if let RunEvent::ExitRequested { api, .. } = &event');
    expect(shell).toContain('if matches!(event, RunEvent::Exit)');
  });

  it('keeps startup opt-in and boot launches minimized', async () => {
    const db = await read('../api-server/src/lib/archive-db.ts');
    const shell = await read('src-tauri/src/main.rs');
    expect(db).toContain('startWithWindows: false');
    expect(shell).toContain('args(["--minimized"])');
    expect(shell).toContain('set_start_with_windows');
  });
});

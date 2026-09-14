import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

async function read(relativePath: string) {
  return readFile(resolve(root, relativePath), 'utf8');
}

describe('desktop lifecycle foundation', () => {
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

  it('keeps startup opt-in and boot launches minimized', async () => {
    const db = await read('../api-server/src/lib/archive-db.ts');
    const shell = await read('src-tauri/src/main.rs');
    expect(db).toContain('startWithWindows: false');
    expect(shell).toContain('args(["--minimized"])');
    expect(shell).toContain('set_start_with_windows');
  });
});

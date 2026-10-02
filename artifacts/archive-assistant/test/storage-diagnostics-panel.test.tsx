import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Storage diagnostics panel.
 *
 * This panel exists to settle one question on a packaged Windows build:
 * did the process open the persistent application database, or did it
 * silently create a fresh one under its working directory? These tests hold
 * it to stating that unambiguously, and to never leaking credentials.
 */

const mockQuery = vi.fn();

vi.mock('@workspace/api-client-react', () => ({
  useGetStorageDiagnostics: () => mockQuery(),
}));

const { StorageDiagnosticsPanel } = await import('../src/components/storage-diagnostics-panel');

const HEALTHY = {
  databasePath: 'C:\\Users\\lochi\\AppData\\Local\\com.imlochie.archiveassistant\\archive-assistant.sqlite',
  databasePathSource: 'ARCHIVE_DB_PATH' as const,
  databasePathIsAbsolute: true,
  workingDirectory: 'C:\\Program Files\\ARCHIVE ASSISTANT',
  databaseSizeBytes: 5_242_880,
  counts: {
    fileRecords: 37_572,
    activeFileRecords: 37_572,
    plexItems: 1_204,
    jellyfinItems: 0,
    reviewItems: 439,
    archiveOperations: 12,
    settings: 20,
  },
  plexConfigured: true,
  journalMode: 'wal',
  walSidecars: ['wal', 'shm'],
};

function withData(overrides: Partial<typeof HEALTHY> = {}) {
  mockQuery.mockReturnValue({
    data: { ...HEALTHY, ...overrides },
    isLoading: false,
    isError: false,
  });
}

beforeEach(() => {
  mockQuery.mockReset();
});

describe('StorageDiagnosticsPanel', () => {
  it('shows the active database path, source and record counts', () => {
    withData();
    render(<StorageDiagnosticsPanel />);

    // The path is the diagnosis, so it must be rendered in full.
    expect(screen.getByTestId('text-storage-database-path').textContent).toContain(
      'AppData\\Local\\com.imlochie.archiveassistant\\archive-assistant.sqlite',
    );
    expect(screen.getByTestId('text-storage-path-source').textContent).toBe('ARCHIVE_DB_PATH');
    expect(screen.getByTestId('text-storage-cwd').textContent).toContain('Program Files');

    // Counts let the operator compare the UI against the file directly.
    expect(screen.getByTestId('text-storage-count-local-records').textContent).toContain('37,572');
    expect(screen.getByTestId('text-storage-count-plex-records').textContent).toContain('1,204');

    expect(screen.getByTestId('status-storage-configured')).toBeTruthy();
    expect(screen.queryByTestId('status-storage-fallback')).toBeNull();
  });

  it('raises an explicit warning when the working-directory fallback was used', () => {
    withData({
      databasePathSource: 'working_directory_fallback',
      databasePath: 'C:\\Program Files\\ARCHIVE ASSISTANT\\data\\archive-assistant.sqlite',
      counts: { ...HEALTHY.counts, fileRecords: 4, activeFileRecords: 4, plexItems: 0 },
      plexConfigured: false,
    });
    render(<StorageDiagnosticsPanel />);

    // This is the smoking gun: it must be impossible to miss or misread.
    const warning = screen.getByTestId('status-storage-fallback');
    expect(warning.textContent).toContain('not the persistent application database');
    expect(warning.textContent).toContain('ARCHIVE_DB_PATH');

    expect(screen.getByTestId('text-storage-path-source').textContent).toBe(
      'WORKING_DIRECTORY_FALLBACK',
    );
    expect(screen.queryByTestId('status-storage-configured')).toBeNull();

    // The symptoms the operator actually saw must be visible together.
    expect(screen.getByTestId('text-storage-plex-configured').textContent).toBe('NO');
    expect(screen.getByTestId('text-storage-count-local-records').textContent).toContain('4');
  });

  it('reports a correct path that is nonetheless empty without blaming the path', () => {
    // If ARCHIVE_DB_PATH is right but the database is empty, the cause is
    // state being reset or replaced, not a misrouted path. The panel must not
    // show the fallback warning in that case.
    withData({
      counts: { ...HEALTHY.counts, fileRecords: 0, activeFileRecords: 0, plexItems: 0 },
      plexConfigured: false,
      databaseSizeBytes: 4096,
    });
    render(<StorageDiagnosticsPanel />);

    expect(screen.queryByTestId('status-storage-fallback')).toBeNull();
    expect(screen.getByTestId('status-storage-configured')).toBeTruthy();
    expect(screen.getByTestId('text-storage-count-local-records').textContent).toContain('0');
  });

  it('never renders credentials, only a configured state', () => {
    withData();
    const { container } = render(<StorageDiagnosticsPanel />);

    expect(screen.getByTestId('text-storage-plex-configured').textContent).toBe('YES');
    // No token-like field is exposed by the contract; assert the rendered
    // output cannot start leaking one if the shape changes.
    expect(container.textContent).not.toMatch(/token/i);
  });

  it('surfaces journal mode and WAL sidecars so that theory can be tested', () => {
    withData();
    render(<StorageDiagnosticsPanel />);
    const mode = screen.getByTestId('text-storage-journal-mode').textContent ?? '';
    expect(mode).toContain('WAL');
    expect(mode).toContain('shm');
  });

  it('degrades honestly when diagnostics cannot be read', () => {
    mockQuery.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    render(<StorageDiagnosticsPanel />);
    expect(screen.getByTestId('panel-storage-diagnostics-error')).toBeTruthy();
  });
});

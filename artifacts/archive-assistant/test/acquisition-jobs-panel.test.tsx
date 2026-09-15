import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AcquisitionJob, DownloadJob } from '@workspace/api-client-react';

import { AcquisitionJobsPanel, importableDownloads } from '../src/components/acquisition-jobs-panel';

/**
 * The acquisition back half. These tests assert the operator surface refuses
 * the states the server would refuse, so a person is never offered a button
 * that produces an error, and never offered a shortcut around the approval
 * boundary.
 */

function job(overrides: Partial<AcquisitionJob> = {}): AcquisitionJob {
  return {
    id: 1,
    ownerId: '__local__',
    mediaType: 'movie',
    title: 'Example Movie',
    year: 2024,
    externalId: null,
    sourceId: null,
    sourceUrl: null,
    providerId: 'sonarr',
    providerJobId: '700',
    providerReference: null,
    downloadJobId: null,
    state: 'downloading',
    progress: 40,
    retryCount: 0,
    maxRetries: 3,
    errorCode: null,
    errorMessage: null,
    request: {},
    metadata: {},
    plannedAt: '2026-09-14T00:00:00.000Z',
    searchingAt: null,
    sourceSelectedAt: null,
    downloadingAt: null,
    processingAt: null,
    verifyingAt: null,
    importingAt: null,
    completedAt: null,
    failedAt: null,
    cancelledAt: null,
    createdAt: '2026-09-14T00:00:00.000Z',
    updatedAt: '2026-09-14T00:00:00.000Z',
    events: [],
    ...overrides,
  } as AcquisitionJob;
}

function download(overrides: Partial<DownloadJob> = {}): DownloadJob {
  return {
    id: 10,
    title: 'Example Movie 2160p',
    status: 'complete',
    verification: 'passed',
    finalPath: 'D:/downloads/Example Movie 2160p.mkv',
    ...overrides,
  } as DownloadJob;
}

const noop = () => {};

describe('acquisition jobs panel', () => {
  it('offers only complete and verified downloads as link candidates', () => {
    const candidates = importableDownloads([
      download({ id: 1 }),
      download({ id: 2, status: 'downloading' }),
      download({ id: 3, verification: 'failed' }),
      download({ id: 4, finalPath: null }),
    ]);
    expect(candidates.map((candidate) => candidate.id)).toEqual([1]);
  });

  it('links a verified download to an acquisition job', async () => {
    const onLinkDownload = vi.fn();
    render(
      <AcquisitionJobsPanel
        jobs={[job()]}
        downloads={[download({ id: 10 })]}
        onLinkDownload={onLinkDownload}
        onPlanImport={noop}
      />,
    );
    await userEvent.selectOptions(screen.getByTestId('select-download-1'), '10');
    await userEvent.click(screen.getByTestId('button-link-download-1'));
    expect(onLinkDownload).toHaveBeenCalledWith(1, 10);
  });

  it('cannot link before a download is selected', () => {
    render(
      <AcquisitionJobsPanel
        jobs={[job()]}
        downloads={[download()]}
        onLinkDownload={noop}
        onPlanImport={noop}
      />,
    );
    expect(screen.getByTestId('button-link-download-1')).toBeDisabled();
  });

  it('plans an import once a verified download is linked', async () => {
    const onPlanImport = vi.fn();
    render(
      <AcquisitionJobsPanel
        jobs={[job({ downloadJobId: 10 })]}
        downloads={[download({ id: 10 })]}
        onLinkDownload={noop}
        onPlanImport={onPlanImport}
      />,
    );
    await userEvent.type(
      screen.getByTestId('input-import-destination-1'),
      'D:/archive/Example Movie (2024).mkv',
    );
    await userEvent.click(screen.getByTestId('button-plan-import-1'));
    expect(onPlanImport).toHaveBeenCalledWith(1, 'D:/archive/Example Movie (2024).mkv');
  });

  it('refuses to plan an import when the linked download is not verified', () => {
    render(
      <AcquisitionJobsPanel
        jobs={[job({ downloadJobId: 10 })]}
        downloads={[download({ id: 10, verification: 'failed' })]}
        onLinkDownload={noop}
        onPlanImport={noop}
      />,
    );
    expect(screen.getByTestId('button-plan-import-1')).toBeDisabled();
    expect(screen.getByTestId('text-import-blocked-1')).toBeInTheDocument();
  });

  it('refuses to plan an import when the linked download is still running', () => {
    render(
      <AcquisitionJobsPanel
        jobs={[job({ downloadJobId: 10 })]}
        downloads={[download({ id: 10, status: 'downloading' })]}
        onLinkDownload={noop}
        onPlanImport={noop}
      />,
    );
    expect(screen.getByTestId('button-plan-import-1')).toBeDisabled();
  });

  it('refuses to plan an import without a destination path', () => {
    render(
      <AcquisitionJobsPanel
        jobs={[job({ downloadJobId: 10 })]}
        downloads={[download({ id: 10 })]}
        onLinkDownload={noop}
        onPlanImport={noop}
      />,
    );
    expect(screen.getByTestId('button-plan-import-1')).toBeDisabled();
  });

  it('states that planning still requires preflight and confirmation', () => {
    render(
      <AcquisitionJobsPanel
        jobs={[job({ downloadJobId: 10 })]}
        downloads={[download({ id: 10 })]}
        onLinkDownload={noop}
        onPlanImport={noop}
      />,
    );
    // Planning must never read as "the file has been imported".
    expect(screen.getByText(/requires preflight and explicit execution/i)).toBeInTheDocument();
  });

  it('does not offer a link control once a download is linked', () => {
    render(
      <AcquisitionJobsPanel
        jobs={[job({ downloadJobId: 10 })]}
        downloads={[download({ id: 10 })]}
        onLinkDownload={noop}
        onPlanImport={noop}
      />,
    );
    expect(screen.queryByTestId('select-download-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('text-linked-download-1')).toHaveTextContent('Linked to download #10');
  });

  it('disables every control while a mutation is in flight', () => {
    render(
      <AcquisitionJobsPanel
        jobs={[job({ downloadJobId: 10 })]}
        downloads={[download({ id: 10 })]}
        busy
        onLinkDownload={noop}
        onPlanImport={noop}
      />,
    );
    expect(screen.getByTestId('input-import-destination-1')).toBeDisabled();
    expect(screen.getByTestId('button-plan-import-1')).toBeDisabled();
  });

  it('reports provider failures and an empty state honestly', () => {
    const { rerender } = render(
      <AcquisitionJobsPanel
        jobs={[job({ state: 'failed', errorMessage: 'The provider rejected the request.' })]}
        downloads={[]}
        onLinkDownload={noop}
        onPlanImport={noop}
      />,
    );
    expect(screen.getByTestId('text-acquisition-state-1')).toHaveTextContent('failed');
    expect(screen.getByText('The provider rejected the request.')).toBeInTheDocument();
    expect(screen.getByTestId('select-download-1')).toBeDisabled();

    rerender(
      <AcquisitionJobsPanel jobs={[]} downloads={[]} onLinkDownload={noop} onPlanImport={noop} />,
    );
    expect(screen.getByTestId('text-no-acquisition-jobs')).toBeInTheDocument();
  });
});

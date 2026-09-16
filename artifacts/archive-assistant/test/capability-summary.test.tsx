/**
 * Capability honesty. The engine declares families it has not implemented so
 * the product can say "not yet" rather than silently omitting them; this
 * surface exists to actually say it.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionCapability } from '@workspace/api-client-react';

const mocks = vi.hoisted(() => ({
  capabilities: { current: [] as ActionCapability[] },
  isError: { current: false },
}));

vi.mock('@workspace/api-client-react', () => ({
  useListActionCapabilities: () => ({
    data: mocks.capabilities.current,
    isLoading: false,
    isError: mocks.isError.current,
    refetch: vi.fn(),
  }),
}));

const { CapabilitySummary } = await import('../src/components/capability-summary');

function capability(overrides: Partial<ActionCapability> = {}): ActionCapability {
  return {
    type: 'rename',
    supported: true,
    mutatesFiles: true,
    reversibility: {
      kind: 'conditional',
      strategy: 'Rename the file back.',
      explanation: 'The original name can be restored as long as nothing else has taken it.',
      conditions: ['The original path is still free'],
    },
    risk: 'low',
    description: 'Rename a file in place.',
    ...overrides,
  } as ActionCapability;
}

function renderSummary() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <CapabilitySummary />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.capabilities.current = [];
  mocks.isError.current = false;
  vi.clearAllMocks();
});

describe('capability summary', () => {
  it('names unimplemented families as not available rather than hiding them', () => {
    mocks.capabilities.current = [
      capability(),
      capability({
        type: 'delete',
        supported: false,
        reversibility: { kind: 'irreversible', strategy: null, explanation: 'Deleted bytes cannot be brought back.', conditions: [] },
        risk: 'high',
      }),
    ];
    renderSummary();
    expect(screen.getByTestId('text-capabilities-headline')).toHaveTextContent('1 of 2 actions are available');
    expect(screen.getByTestId('badge-capability-unavailable-delete')).toHaveTextContent('NOT AVAILABLE YET');
    expect(screen.getByTestId('list-capabilities-planned')).toHaveTextContent('DECLARED BUT NOT WIRED / 1');
  });

  it('distinguishes actions that touch files from those that only change records', () => {
    mocks.capabilities.current = [
      capability(),
      capability({
        type: 'reconcile',
        mutatesFiles: false,
        reversibility: { kind: 'reversible', strategy: 'Remove the link.', explanation: 'The link is a record this engine owns.', conditions: [] },
      }),
    ];
    renderSummary();
    expect(screen.getByTestId('badge-capability-files-rename')).toHaveTextContent('TOUCHES FILES');
    expect(screen.getByTestId('badge-capability-files-reconcile')).toHaveTextContent('RECORDS ONLY');
  });

  it('carries the three reversibility kinds through to the operator', () => {
    mocks.capabilities.current = [
      capability(),
      capability({
        type: 'reconcile',
        mutatesFiles: false,
        reversibility: { kind: 'reversible', strategy: 'Remove the link.', explanation: 'Restores the exact prior state.', conditions: [] },
      }),
      capability({
        type: 'plex_sync',
        mutatesFiles: false,
        reversibility: { kind: 'irreversible', strategy: null, explanation: 'Plex owns the result of a sync.', conditions: [] },
      }),
    ];
    renderSummary();
    expect(screen.getByTestId('badge-capability-reversibility-rename')).toHaveTextContent('UNDOABLE IF');
    expect(screen.getByTestId('badge-capability-reversibility-reconcile')).toHaveTextContent('UNDOABLE');
    expect(screen.getByTestId('badge-capability-reversibility-plex_sync')).toHaveTextContent('ONE-WAY');
  });

  it('restates the approval boundary rather than implying autonomy', () => {
    mocks.capabilities.current = [capability()];
    renderSummary();
    expect(screen.getByTestId('panel-capabilities')).toHaveTextContent('The AI can propose, never approve');
  });

  it('does not describe consequences for a family that cannot run', () => {
    mocks.capabilities.current = [
      capability({
        type: 'delete',
        supported: false,
        reversibility: { kind: 'irreversible', strategy: null, explanation: 'Deleted bytes cannot be brought back.', conditions: [] },
      }),
    ];
    renderSummary();
    const row = screen.getByTestId('row-capability-delete');
    // It must not advertise reversibility semantics for something unwired.
    expect(row).not.toHaveTextContent('Deleted bytes cannot be brought back');
    expect(row).toHaveTextContent('refuses to plan or execute until it is wired');
  });

  it('assumes nothing about capabilities when the read fails', () => {
    mocks.isError.current = true;
    renderSummary();
    expect(screen.getByTestId('panel-capabilities-error'))
      .toHaveTextContent('Nothing is being assumed about what this installation can do');
  });
});

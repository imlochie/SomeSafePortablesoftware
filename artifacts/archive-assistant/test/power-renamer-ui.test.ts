import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const appSource = await readFile(join(import.meta.dirname, '..', 'src', 'App.tsx'), 'utf8');

describe('supervised Power Renamer UI contract', () => {
  it('exposes only corroborated proposals for selection', () => {
    expect(appSource).toContain("proposal.researchGrade === 'corroborated'");
    expect(appSource).toContain('INCLUDE IN POWER RENAMER PLAN');
    expect(appSource).toContain('RESEARCH SOURCES /');
    expect(appSource).toContain('BLOCKERS /');
    expect(appSource).toContain('/api/archive/power-renamer/plan');
  });

  it('keeps approval and operation creation as separate user actions', () => {
    expect(appSource).toContain('/api/review-items/${powerRenamerPlan.reviewItemId}/approve');
    expect(appSource).toContain('/api/archive/power-renamer/operations');
    expect(appSource).toContain('APPROVE PLAN');
    expect(appSource).toContain('CREATE OPERATION');
  });

  it('keeps preflight, execution, and provider refresh visibly gated', () => {
    expect(appSource).toContain("advancePowerRenamer('preflight')");
    expect(appSource).toContain("advancePowerRenamer('execute')");
    expect(appSource).toContain("advancePowerRenamer('refresh')");
    expect(appSource).toContain('confirmed: true');
    expect(appSource).toContain('REFRESH PROVIDERS');
    expect(appSource).toContain('/provider-status');
    expect(appSource).toContain('provider-status');
    expect(appSource).toContain('Latest status:');
    expect(appSource).toContain('Reconciliation remains explicit');
    expect(appSource).toContain("attempt < 6");
  });
});

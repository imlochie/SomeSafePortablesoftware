import { describe, expect, it } from 'vitest';
import type { ReviewSyncResult } from '@workspace/api-client-react';

import { summariseReviewSync } from '../src/App';

/**
 * The old message reported one total, which conflated observations with
 * decisions and read as "42,605 review items" on a real archive. These tests
 * pin the corrected reporting so it cannot regress to a single number.
 */

function result(overrides: Partial<ReviewSyncResult> = {}): ReviewSyncResult {
  return {
    namingItems: 0,
    archiveFindingItems: 0,
    informationalFindings: 0,
    total: 0,
    severity: {
      total: 0,
      reviewRequired: 0,
      informational: 0,
      bySeverity: { info: 0, low: 0, medium: 0, high: 0, critical: 0 },
    },
    ...overrides,
  } as ReviewSyncResult;
}

describe('review sync summary', () => {
  it('separates decisions from observations', () => {
    const message = summariseReviewSync(result({
      archiveFindingItems: 439,
      informationalFindings: 38_204,
      namingItems: 12,
      severity: {
        total: 38_643,
        reviewRequired: 439,
        informational: 38_204,
        bySeverity: { info: 38_204, low: 0, medium: 400, high: 37, critical: 2 },
      },
    }));
    expect(message).toContain('439 findings need review');
    expect(message).toContain('38,204 informational');
    expect(message).toContain('12 naming proposals');
  });

  it('names the escalated severities so urgency is visible', () => {
    const message = summariseReviewSync(result({
      archiveFindingItems: 439,
      severity: {
        total: 439,
        reviewRequired: 439,
        informational: 0,
        bySeverity: { info: 0, low: 0, medium: 400, high: 37, critical: 2 },
      },
    }));
    // Most urgent first: a critical finding must not be buried behind a
    // four-hundred-item medium count.
    expect(message).toMatch(/2 critical, 37 high, 400 medium/);
  });

  it('omits severities with no findings', () => {
    const message = summariseReviewSync(result({
      archiveFindingItems: 3,
      severity: {
        total: 3,
        reviewRequired: 3,
        informational: 0,
        bySeverity: { info: 0, low: 0, medium: 3, high: 0, critical: 0 },
      },
    }));
    expect(message).toContain('3 medium');
    expect(message).not.toContain('critical');
    expect(message).not.toContain('high');
  });

  it('reads correctly when nothing needs review', () => {
    const message = summariseReviewSync(result({
      archiveFindingItems: 0,
      informationalFindings: 1_204,
      severity: {
        total: 1_204,
        reviewRequired: 0,
        informational: 1_204,
        bySeverity: { info: 1_204, low: 0, medium: 0, high: 0, critical: 0 },
      },
    }));
    expect(message).toContain('0 findings need review');
    expect(message).toContain('1,204 informational');
  });

  it('uses singular wording for a single finding', () => {
    const message = summariseReviewSync(result({
      archiveFindingItems: 1,
      namingItems: 1,
      severity: {
        total: 1,
        reviewRequired: 1,
        informational: 0,
        bySeverity: { info: 0, low: 0, medium: 0, high: 1, critical: 0 },
      },
    }));
    expect(message).toContain('1 finding need');
    expect(message).toContain('1 naming proposal.');
  });

  it('never reports a single undifferentiated total', () => {
    const message = summariseReviewSync(result({
      archiveFindingItems: 439,
      informationalFindings: 38_204,
      total: 42_605,
      severity: {
        total: 38_643,
        reviewRequired: 439,
        informational: 38_204,
        bySeverity: { info: 38_204, low: 0, medium: 400, high: 37, critical: 2 },
      },
    }));
    // The number that made the old UI unusable must not appear.
    expect(message).not.toContain('42,605');
    expect(message).not.toContain('42605');
  });
});

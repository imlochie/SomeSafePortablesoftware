export type OrderingObservation = {
  id: string;
  filename: string;
  currentEpisode: number | null;
  publishedAt: string | null;
  sourceOrder: number | null;
};

export type OrderingHypothesis = 'chronological_ascending' | 'chronological_descending' | 'explicit_episode_number' | 'current_order' | 'unknown';

export type OrderingAnalysis = {
  collection: string;
  itemCount: number;
  hypothesis: OrderingHypothesis;
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  proposal: 'reverse_episode_numbers' | 'no_change' | 'no_action';
  reason: string;
  evidence: string[];
  changes: Array<{ id: string; filename: string; currentEpisode: number | null; proposedEpisode: number | null }>;
};

/**
 * Pure ordering inference. It requires explicit publication metadata; filesystem
 * mtime and title similarity are deliberately not accepted as chronology.
 */
export function analyzeOrdering(collection: string, observations: OrderingObservation[]): OrderingAnalysis {
  const ordered = observations.filter((item) => item.currentEpisode !== null);
  const dated = ordered.filter((item) => item.publishedAt && Number.isFinite(Date.parse(item.publishedAt)));
  if (ordered.length < 2 || dated.length !== ordered.length) {
    return { collection, itemCount: observations.length, hypothesis: 'unknown', confidence: 'unknown', proposal: 'no_action', reason: 'There is not enough explicit episode and publication metadata to infer the intended order.', evidence: ['episode number or publication date is missing'], changes: [] };
  }
  const byEpisode = [...dated].sort((left, right) => left.currentEpisode! - right.currentEpisode!);
  const dates = byEpisode.map((item) => Date.parse(item.publishedAt!));
  const ascending = dates.every((date, index) => index === 0 || date >= dates[index - 1]);
  const descending = dates.every((date, index) => index === 0 || date <= dates[index - 1]);
  if (ascending) {
    return { collection, itemCount: observations.length, hypothesis: 'explicit_episode_number', confidence: 'high', proposal: 'no_change', reason: 'Explicit episode numbers already increase with publication chronology.', evidence: ['all items have episode numbers', 'publication dates are monotonic oldest to newest'], changes: [] };
  }
  if (descending) {
    const max = Math.max(...ordered.map((item) => item.currentEpisode!));
    return { collection, itemCount: observations.length, hypothesis: 'chronological_descending', confidence: 'high', proposal: 'reverse_episode_numbers', reason: 'Publication dates consistently decrease as episode numbers increase.', evidence: ['all items have episode numbers', 'publication dates are monotonic newest to oldest'], changes: byEpisode.map((item) => ({ id: item.id, filename: item.filename, currentEpisode: item.currentEpisode, proposedEpisode: max - item.currentEpisode! + 1 })) };
  }
  return { collection, itemCount: observations.length, hypothesis: 'unknown', confidence: 'low', proposal: 'no_action', reason: 'Ordering signals conflict, so no safe renumbering proposal was produced.', evidence: ['publication dates are not monotonic'], changes: [] };
}

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const hierarchy = {
  page: 1,
  pageSize: 24,
  total: 1,
  series: [{
    identity: 'series-1', title: 'The Bear', year: 2022, artworkRatingKey: '100',
    seasonCount: 1, episodeCount: 1, localMatchedCount: 1, verifiedCount: 1,
    seasons: [{
      identity: 'season-1', seasonNumber: 2, title: 'Season Two', episodeCount: 1,
      localMatchedCount: 1, verifiedCount: 1,
      episodes: [{ identity: 'episode-1', episodeNumber: 7, title: 'Forks', artworkRatingKey: '107', localMatch: 'matched', verifiedCount: 1, localRecordIds: [42] }],
    }],
  }],
};

vi.mock('@workspace/api-client-react', () => ({
  useGetPlexHierarchy: () => ({ data: hierarchy, isLoading: false, isError: false }),
  useGetPlexInventory: () => ({ data: { items: [{ id: 1, ratingKey: '200', title: 'Movie Night', itemType: 'movie', year: 1999, thumbPathAvailable: true }] }, isLoading: false, isError: false }),
  useGetPlexConfig: () => ({ data: { configured: true }, isLoading: false, isError: false }),
}));

import { VisualMediaLibrary } from '../src/components/visual-media-library';

describe('visual media library', () => {
  it('shows movie and TV library objects from the provider surfaces', () => {
    render(<VisualMediaLibrary onLocalReview={vi.fn()} />);
    expect(screen.getByTestId('media-movie-200')).toHaveTextContent('Movie Night');
    expect(screen.getByTestId('media-series-series-1')).toHaveTextContent('The Bear');
    expect(screen.getByText('1 / 1 local')).toBeInTheDocument();
  });

  it('navigates series to season to episode without reconstructing relationships', () => {
    render(<VisualMediaLibrary onLocalReview={vi.fn()} />);
    fireEvent.click(screen.getByTestId('media-series-series-1'));
    expect(screen.getByTestId('media-series-view')).toHaveTextContent('The Bear');
    fireEvent.click(screen.getByTestId('media-season-season-1'));
    expect(screen.getByTestId('media-season-view')).toHaveTextContent('Season 2');
    expect(screen.getByTestId('media-episode-episode-1')).toHaveTextContent('EPISODE 07');
    expect(screen.getByTestId('media-episode-episode-1')).toHaveTextContent('Local match');
    expect(screen.getByTestId('media-episode-episode-1')).toHaveTextContent('Local record: 42');
  });

  it('keeps relationship titles and state visible when artwork fails', () => {
    render(<VisualMediaLibrary onLocalReview={vi.fn()} />);
    fireEvent.click(screen.getByTestId('media-series-series-1'));
    const artwork = screen.getByAltText('The Bear artwork');
    fireEvent.error(artwork);
    expect(screen.getByTestId('media-series-view')).toHaveTextContent('The Bear');
    expect(screen.getByTestId('media-series-view')).toHaveTextContent('1 / 1 local');
    expect(screen.getByLabelText('The Bear artwork unavailable')).toBeInTheDocument();
  });

  it('distinguishes unavailable Plex from an empty connected library', async () => {
    const onLocalReview = vi.fn();
    render(<VisualMediaLibrary onLocalReview={onLocalReview} />);
    fireEvent.click(screen.getByRole('button', { name: 'LOCAL REVIEW' }));
    expect(onLocalReview).toHaveBeenCalled();
  });
});

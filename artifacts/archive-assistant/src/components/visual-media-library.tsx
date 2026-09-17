import { useState } from 'react';
import { ArrowLeft, ChevronRight, FolderOpen, Library, PlaySquare, RefreshCw } from 'lucide-react';
import {
  useGetPlexConfig,
  useGetPlexHierarchy,
  useGetPlexInventory,
  type PlexHierarchyEpisode,
  type PlexHierarchySeason,
  type PlexHierarchySeries,
} from '@workspace/api-client-react';
import { apiUrl } from '@/lib/desktop-api-base-url';

type LibraryView = { kind: 'library' } | { kind: 'series'; series: PlexHierarchySeries } | { kind: 'season'; series: PlexHierarchySeries; season: PlexHierarchySeason };

function Artwork({ ratingKey, label, className = 'h-full w-full' }: { ratingKey: string | null | undefined; label: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (!ratingKey || failed) {
    return <div className={`${className} grid place-items-center bg-[#e6efec] text-[#72918d]`} aria-label={`${label} artwork unavailable`}><PlaySquare size={22} strokeWidth={1.5} /></div>;
  }
  return <img src={apiUrl(`/api/plex/artwork/${encodeURIComponent(ratingKey)}`)} alt={`${label} artwork`} loading="lazy" decoding="async" className={`${className} bg-[#e6efec] object-cover`} onError={() => setFailed(true)} />;
}

function MatchState({ state, verifiedCount }: { state: PlexHierarchyEpisode['localMatch']; verifiedCount: number }) {
  const copy = state === 'matched' ? 'Local match' : state === 'uncertain' ? 'Local match uncertain' : state === 'conflicting' ? 'Conflicting local match' : 'No matching local file';
  const tone = state === 'matched' ? 'text-[#39736e]' : state === 'unmatched' ? 'text-[#a77517]' : 'text-[#994b43]';
  return <span className={`inline-flex items-center gap-1.5 text-[10px] font-semibold ${tone}`}><span aria-hidden="true">{state === 'matched' ? '✓' : state === 'unmatched' ? '⚠' : '✕'}</span>{copy}{state === 'matched' && verifiedCount > 0 ? ` · ${verifiedCount} verified` : ''}</span>;
}

function Summary({ series, season }: { series?: PlexHierarchySeries; season?: PlexHierarchySeason }) {
  const item = season ?? series;
  if (!item) return null;
  const total = season ? season.episodeCount : series?.episodeCount ?? 0;
  const local = season ? season.localMatchedCount : series?.localMatchedCount ?? 0;
  const verified = season ? season.verifiedCount : series?.verifiedCount ?? 0;
  return <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[#718087]"><span>{season ? `${total} episodes` : `${series?.seasonCount ?? 0} seasons · ${total} episodes`}</span><span className="text-[#39736e]">{local} / {total} local</span><span className={verified < total ? 'text-[#a77517]' : 'text-[#39736e]'}>{verified} verified{verified < total ? ` · ${Math.max(0, total - verified)} need attention` : ''}</span></div>;
}

function EpisodeCard({ episode }: { episode: PlexHierarchyEpisode }) {
  return <article className="flex gap-3 border border-[#e1e8e5] bg-white/75 p-3" data-testid={`media-episode-${episode.identity}`}>
    <Artwork ratingKey={episode.artworkRatingKey} label={episode.title} className="h-16 w-24 shrink-0" />
    <div className="min-w-0"><div className="archive-mono text-[9px] tracking-[.12em] text-[#7f9194]">{episode.episodeNumber === null ? 'EPISODE' : `EPISODE ${String(episode.episodeNumber).padStart(2, '0')}`}</div><h3 className="mt-1 truncate text-[13px] font-bold text-[#344851]">{episode.title}</h3><div className="mt-2"><MatchState state={episode.localMatch} verifiedCount={episode.verifiedCount} /></div><div className="mt-1 text-[10px] text-[#9aa6a6]">{episode.localRecordIds.length ? `Local record${episode.localRecordIds.length > 1 ? 's' : ''}: ${episode.localRecordIds.join(', ')}` : 'No local record linked'}</div></div>
  </article>;
}

export function VisualMediaLibrary({ onLocalReview }: { onLocalReview: () => void }) {
  const [view, setView] = useState<LibraryView>({ kind: 'library' });
  const [page, setPage] = useState(1);
  const hierarchy = useGetPlexHierarchy({ page, pageSize: 24 });
  const inventory = useGetPlexInventory();
  const config = useGetPlexConfig();
  const tv = hierarchy.data?.series ?? [];
  const movies = (inventory.data?.items ?? []).filter(item => item.itemType === 'movie');

  if (hierarchy.isLoading || inventory.isLoading || config.isLoading) return <div className="archive-panel flex min-h-[360px] items-center justify-center gap-3 p-8 text-[10px] tracking-[.12em] text-[#7f9194]"><RefreshCw size={15} className="animate-spin" /> READING YOUR MEDIA LIBRARY</div>;
  if (hierarchy.isError || inventory.isError || config.isError) return <section className="archive-panel border-l-2 border-[#d9bd77] p-6" data-testid="media-library-unavailable"><div className="archive-mono text-[10px] tracking-[.14em] text-[#a77517]">PLEX / UNAVAILABLE</div><h2 className="archive-display mt-2 text-xl font-extrabold text-[#263844]">Your media library could not be read.</h2><p className="mt-2 text-[12px] leading-5 text-[#718087]">Nothing has been assumed or filled in. Check Plex configuration, then try again.</p></section>;
  if (!config.data?.configured) return <section className="archive-panel border-l-2 border-[#d9bd77] p-6" data-testid="media-library-not-configured"><div className="archive-mono text-[10px] tracking-[.14em] text-[#a77517]">PLEX / NOT CONFIGURED</div><h2 className="archive-display mt-2 text-xl font-extrabold text-[#263844]">Connect Plex to browse your library.</h2><p className="mt-2 text-[12px] leading-5 text-[#718087]">Your local archive remains available below; Plex-backed artwork and hierarchy will appear after configuration.</p></section>;
  if (hierarchy.isError || inventory.isError || config.isError) return <section className="archive-panel border-l-2 border-[#d9bd77] p-6" data-testid="media-library-unavailable"><div className="archive-mono text-[10px] tracking-[.14em] text-[#a77517]">PLEX / UNAVAILABLE</div><h2 className="archive-display mt-2 text-xl font-extrabold text-[#263844]">Your media library could not be read.</h2><p className="mt-2 text-[12px] leading-5 text-[#718087]">Nothing has been assumed or filled in. Check Plex configuration, then try again.</p></section>;

  if (view.kind === 'season') return <section className="archive-panel p-5 md:p-7" data-testid="media-season-view"><button type="button" onClick={() => setView({ kind: 'series', series: view.series })} className="mb-5 inline-flex items-center gap-1 text-[10px] font-bold tracking-[.1em] text-[#39736e]"><ArrowLeft size={13} /> BACK TO SERIES</button><div className="flex flex-col gap-4 border-b border-[#e3e8e7] pb-5 sm:flex-row sm:items-end sm:justify-between"><div><div className="archive-mono text-[10px] tracking-[.14em] text-[#7f9194]">{view.series.title.toUpperCase()}</div><h2 className="archive-display mt-1 text-3xl font-extrabold text-[#263844]">Season {view.season.seasonNumber}</h2><p className="mt-1 text-[12px] text-[#718087]">{view.season.title ?? 'Season details'}</p></div><Summary season={view.season} /></div><div className="mt-5 grid gap-3 lg:grid-cols-2">{view.season.episodes.map(episode => <EpisodeCard key={episode.identity} episode={episode} />)}</div></section>;

  if (view.kind === 'series') return <section className="archive-panel p-5 md:p-7" data-testid="media-series-view"><button type="button" onClick={() => setView({ kind: 'library' })} className="mb-5 inline-flex items-center gap-1 text-[10px] font-bold tracking-[.1em] text-[#39736e]"><ArrowLeft size={13} /> BACK TO LIBRARY</button><div className="flex flex-col gap-4 border-b border-[#e3e8e7] pb-5 sm:flex-row sm:items-end sm:justify-between"><div><div className="archive-mono text-[10px] tracking-[.14em] text-[#7f9194]">TV SERIES</div><h2 className="archive-display mt-1 text-3xl font-extrabold text-[#263844]">{view.series.title}</h2><Summary series={view.series} /></div><Artwork ratingKey={view.series.artworkRatingKey} label={view.series.title} className="h-24 w-16 shrink-0" /></div><div className="mt-5 grid gap-3 sm:grid-cols-3">{view.series.seasons.map(season => <button type="button" key={season.identity} onClick={() => setView({ kind: 'season', series: view.series, season })} className="group text-left" data-testid={`media-season-${season.identity}`}><div className="border border-[#e1e8e5] bg-white/75 p-3 transition-colors group-hover:border-[#4e9690]"><div className="flex items-center justify-between"><h3 className="text-[13px] font-bold text-[#344851]">Season {season.seasonNumber}</h3><ChevronRight size={15} className="text-[#72918d]" /></div><div className="mt-2 text-[10px] text-[#718087]">{season.episodeCount} episodes · {season.localMatchedCount} local · {season.verifiedCount} verified</div></div></button>)}</div></section>;

  return <section className="space-y-7" data-testid="media-library-view"><div className="archive-panel border-l-2 border-[#4e9690] p-5 md:p-7"><div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div><div className="archive-mono text-[10px] tracking-[.16em] text-[#39736e]">ARCHIVE / BROWSE ARCHIVE</div><h2 className="archive-display mt-1 text-3xl font-extrabold text-[#263844]">Your media library</h2><p className="mt-2 max-w-xl text-[12px] leading-5 text-[#718087]">Plex relationships first. Local files and verification stay visible where the API has authoritative evidence.</p></div><div className="flex items-center gap-3"><div className="archive-mono text-[10px] text-[#7f9194]">{hierarchy.data?.total ?? 0} SERIES</div><button type="button" onClick={onLocalReview} className="border border-[#d6dfdc] bg-white px-3 py-2 text-[10px] font-bold tracking-[.08em] text-[#53656b] hover:border-[#4e9690]">LOCAL REVIEW</button></div></div></div>
    {movies.length > 0 && <section><div className="mb-3 flex items-center gap-2"><PlaySquare size={16} className="text-[#39736e]" /><h2 className="archive-display text-xl font-extrabold text-[#263844]">Movies</h2><span className="archive-mono text-[9px] text-[#7f9194]">{movies.length}</span></div><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{movies.map(movie => <article key={movie.id} className="overflow-hidden border border-[#e1e8e5] bg-white/80" data-testid={`media-movie-${movie.ratingKey}`}><div className="aspect-[2/3] max-h-[260px]"><Artwork ratingKey={movie.thumbPathAvailable ? movie.ratingKey : null} label={movie.title} /></div><div className="p-3"><h3 className="truncate text-[13px] font-bold text-[#344851]">{movie.title}</h3><div className="mt-1 text-[10px] text-[#718087]">{movie.year ?? 'Year unknown'} · Movie</div><div className="mt-2 text-[10px] text-[#7f9194]">Plex library item · local relationship shown in Archive review</div></div></article>)}</div></section>}
    {tv.length > 0 && <section><div className="mb-3 flex items-center gap-2"><Library size={16} className="text-[#39736e]" /><h2 className="archive-display text-xl font-extrabold text-[#263844]">TV series</h2><span className="archive-mono text-[9px] text-[#7f9194]">{hierarchy.data?.total ?? tv.length}</span></div><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{tv.map(series => <button type="button" key={series.identity} onClick={() => setView({ kind: 'series', series })} className="group text-left" data-testid={`media-series-${series.identity}`}><article className="overflow-hidden border border-[#e1e8e5] bg-white/80 transition-colors group-hover:border-[#4e9690]"><div className="aspect-[2/3] max-h-[260px]"><Artwork ratingKey={series.artworkRatingKey} label={series.title} /></div><div className="p-3"><h3 className="truncate text-[13px] font-bold text-[#344851]">{series.title}</h3><div className="mt-1"><Summary series={series} /></div></div></article></button>)}</div></section>}
    {tv.length === 0 && movies.length === 0 && <div className="archive-panel p-8 text-center" data-testid="media-library-empty"><FolderOpen size={22} className="mx-auto text-[#72918d]" /><h2 className="archive-display mt-3 text-xl font-extrabold text-[#263844]">No media found</h2><p className="mt-2 text-[12px] text-[#718087]">Plex is connected, but the current library has no media to display.</p></div>}
    <div className="flex items-center justify-between border-t border-[#e3e8e5] pt-4"><button type="button" disabled={page <= 1} onClick={() => setPage(value => value - 1)} className="border border-[#d6dfdc] px-3 py-2 text-[10px] font-bold tracking-[.08em] text-[#53656b] disabled:opacity-40">PREVIOUS</button><span className="archive-mono text-[9px] text-[#7f9194]">PAGE {page}</span><button type="button" disabled={!hierarchy.data || hierarchy.data.series.length < hierarchy.data.pageSize} onClick={() => setPage(value => value + 1)} className="border border-[#d6dfdc] px-3 py-2 text-[10px] font-bold tracking-[.08em] text-[#53656b] disabled:opacity-40">NEXT</button></div>
  </section>;
}

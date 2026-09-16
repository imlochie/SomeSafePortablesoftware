import { Link } from "wouter";
import { Compass, Search, Sparkles, CalendarDays, TrendingUp } from "lucide-react";

export default function DiscoverPage() {
  return <div className="mx-auto w-full max-w-6xl">
    <div className="mb-7"><div className="archive-mono mb-2 text-[10px] tracking-[.2em] text-[#7a9093]">DISCOVER / EXPLORE</div><h1 className="archive-display text-3xl font-extrabold text-[#21303d]">Find what matters next</h1><p className="mt-2 max-w-xl text-[13px] leading-6 text-[#718087]">Explore personal recommendations, current releases, and research without turning discovery into an acquisition queue.</p></div>
    <div className="grid gap-4 md:grid-cols-2">
      <section className="archive-panel p-5" data-testid="discover-section-for-you"><Sparkles size={18} className="text-[#4e9690]" /><h2 className="archive-display mt-4 text-lg font-extrabold">For you</h2><p className="mt-2 text-[11px] leading-5 text-[#718187]">Evidence-backed candidates from your viewing history and archive context.</p><Link href="/assistant" className="mt-5 inline-flex items-center gap-2 text-[10px] font-bold tracking-[.1em] text-[#39736e]">OPEN ASSISTANT <Search size={13} /></Link></section>
      <section className="archive-panel p-5" data-testid="discover-section-upcoming"><CalendarDays size={18} className="text-[#4e9690]" /><h2 className="archive-display mt-4 text-lg font-extrabold">Upcoming</h2><p className="mt-2 text-[11px] leading-5 text-[#718187]">Release information is shown only when supported by synchronized provider metadata.</p><Link href="/user-portal" className="mt-5 inline-flex items-center gap-2 text-[10px] font-bold tracking-[.1em] text-[#39736e]">VIEW HOME BRIEFING <Search size={13} /></Link></section>
      <section className="archive-panel p-5" data-testid="discover-section-recent"><Compass size={18} className="text-[#4e9690]" /><h2 className="archive-display mt-4 text-lg font-extrabold">Recently released</h2><p className="mt-2 text-[11px] leading-5 text-[#718187]">Recent release context appears when a reliable release date is available.</p><div className="mt-5 text-[10px] text-[#829095]">No additional external release source is configured.</div></section>
      <section className="archive-panel p-5" data-testid="discover-section-trending"><TrendingUp size={18} className="text-[#a77517]" /><h2 className="archive-display mt-4 text-lg font-extrabold">Trending</h2><p className="mt-2 text-[11px] leading-5 text-[#718187]">Trending data is external popularity evidence, not personal taste.</p><div className="mt-5 text-[10px] text-[#9b514a]">Unavailable: no supported trending source.</div></section>
    </div>
  </div>;
}

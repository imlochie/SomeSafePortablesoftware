import type { ReactNode } from 'react';

export function EvidenceDisclosure({ label = 'WHY?', children, testId }: { label?: string; children: ReactNode; testId?: string }) {
  return <details className="border-t border-[#e3e8e7] pt-3" data-testid={testId}><summary className="cursor-pointer list-none text-[10px] font-bold tracking-[.1em] text-[#39736e]">{label}</summary><div className="mt-3 text-[11px] leading-5 text-[#718187]">{children}</div></details>;
}

export function UnknownState({ children = 'Information unavailable.' }: { children?: ReactNode }) {
  return <div className="border-l-2 border-[#d9bd77] bg-[#fffaf0] px-3 py-2 text-[10px] text-[#82765d]">{children}</div>;
}

export function BlockedState({ children }: { children: ReactNode }) {
  return <div className="border-l-2 border-[#cf695f] bg-[#fff1ef] px-3 py-2 text-[10px] text-[#8d4a45]">{children}</div>;
}

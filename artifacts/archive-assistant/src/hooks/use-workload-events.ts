import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiUrl } from '@/lib/desktop-api-base-url';

/** Events are invalidation hints only; persisted workload truth is always re-read. */
export function useWorkloadEvents() {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const source = new EventSource(apiUrl('/api/downloads/events'));
    const invalidate = () => { void queryClient.invalidateQueries({ queryKey: ['assistant-workload'] }); };
    ['message', 'download', 'job.created', 'job.updated', 'job.completed', 'job.finished'].forEach((name) => source.addEventListener(name, invalidate));
    return () => source.close();
  }, [queryClient]);
}

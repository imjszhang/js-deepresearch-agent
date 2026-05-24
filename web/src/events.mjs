export function subscribeToResearch(researchId, handlers) {
  const source = new EventSource(`/api/research/${researchId}/events`);
  source.addEventListener('status', (event) => handlers.status?.(JSON.parse(event.data)));
  source.addEventListener('log', (event) => handlers.log?.(JSON.parse(event.data)));
  source.onerror = () => handlers.error?.();
  return () => source.close();
}

/** All personal readers in this iframe share one bounded request. */
let inFlight: Promise<any> | null = null;
export function readPersonalState(): Promise<any> {
  if (inFlight) return inFlight;
  const endpoint = urls['musiq']?.['own-song-state'];
  if (!endpoint) return Promise.reject(new Error('Personal state unavailable'));
  const abort = new AbortController();
  const timeout = window.setTimeout(() => abort.abort(), 9000);
  inFlight = fetch(endpoint, {credentials: 'same-origin', cache: 'no-store', signal: abort.signal})
      .then(response => { if (!response.ok) throw new Error('Personal state unavailable'); return response.json(); })
      .finally(() => { window.clearTimeout(timeout); inFlight = null; });
  return inFlight;
}
(window as any).furaticReadPersonalState = readPersonalState;

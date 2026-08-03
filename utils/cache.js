/* Tiny in-memory TTL cache for hot Firestore reads that get hit by
   frequent polling (e.g. GET /settings, called every ~20s from every
   open tab). A short TTL means bursts of near-simultaneous requests
   share one Firestore read instead of one each, without the data ever
   going stale for more than a few seconds — well within what clients
   already tolerate given their own poll interval. */

const store = new Map(); // key -> { value, expiresAt }

async function getOrFetch(key, ttlMs, fetchFn) {
  const hit = store.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = await fetchFn();
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

function invalidate(key) {
  store.delete(key);
}

module.exports = { getOrFetch, invalidate };

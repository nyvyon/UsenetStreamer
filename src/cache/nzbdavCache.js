// NZBDav stream mount cache module
const nzbdavStreamCache = new Map();

// Parse cache configuration from environment
let NZBDAV_CACHE_TTL_MS = 72 * 60 * 60 * 1000;

function reloadNzbdavCacheConfig() {
  const raw = Number(process.env.NZBDAV_CACHE_TTL_MINUTES);
  if (Number.isFinite(raw) && raw >= 0) {
    NZBDAV_CACHE_TTL_MS = raw * 60 * 1000;
  } else {
    NZBDAV_CACHE_TTL_MS = 72 * 60 * 60 * 1000;
  }
}

reloadNzbdavCacheConfig();

function cleanupNzbdavCache() {
  if (NZBDAV_CACHE_TTL_MS <= 0) return;

  const now = Date.now();
  for (const [key, entry] of nzbdavStreamCache.entries()) {
    if (entry.expiresAt && entry.expiresAt <= now) {
      nzbdavStreamCache.delete(key);
    }
  }
}

function clearNzbdavStreamCache(reason = 'manual') {
  if (nzbdavStreamCache.size > 0) {
    console.log('[CACHE] Cleared NZBDav stream cache', { reason, entries: nzbdavStreamCache.size });
  }
  nzbdavStreamCache.clear();
}

/**
 * Return a cached 'ready' NZBDav stream entry without triggering a build.
 * Returns null if not cached or not ready.
 */
function getCachedNzbdavStream(cacheKey) {
  cleanupNzbdavCache();
  const existing = nzbdavStreamCache.get(cacheKey);
  if (existing && existing.status === 'ready') {
    return existing.data;
  }
  return null;
}

async function getOrCreateNzbdavStream(cacheKey, builder) {
  cleanupNzbdavCache();
  const existing = nzbdavStreamCache.get(cacheKey);

  if (existing) {
    if (existing.status === 'ready') {
      return existing.data;
    }
    if (existing.status === 'pending') {
      return existing.promise;
    }
    if (existing.status === 'failed') {
      throw existing.error;
    }
  }

  const promise = (async () => {
    const data = await builder();
    nzbdavStreamCache.set(cacheKey, {
      status: 'ready',
      data,
      expiresAt: NZBDAV_CACHE_TTL_MS > 0 ? Date.now() + NZBDAV_CACHE_TTL_MS : null
    });
    return data;
  })();

  nzbdavStreamCache.set(cacheKey, { status: 'pending', promise });

  try {
    return await promise;
  } catch (error) {
    if (error?.isNzbdavFailure) {
      nzbdavStreamCache.set(cacheKey, {
        status: 'failed',
        error,
        expiresAt: NZBDAV_CACHE_TTL_MS > 0 ? Date.now() + NZBDAV_CACHE_TTL_MS : null
      });
    } else {
      nzbdavStreamCache.delete(cacheKey);
    }
    throw error;
  }
}

function buildNzbdavCacheKey(downloadUrl, category, requestedEpisode = null) {
  const parts = [downloadUrl, category];
  if (requestedEpisode) {
    parts.push(`S${requestedEpisode.season}E${requestedEpisode.episode}`);
  }
  return parts.join('::');
}

function getNzbdavCacheStats() {
  const stats = {
    entries: nzbdavStreamCache.size,
    ttlMs: NZBDAV_CACHE_TTL_MS,
    byStatus: { ready: 0, pending: 0, failed: 0 },
  };
  
  for (const entry of nzbdavStreamCache.values()) {
    if (entry.status) {
      stats.byStatus[entry.status] = (stats.byStatus[entry.status] || 0) + 1;
    }
  }
  
  return stats;
}

/**
 * Directly cache a stream result (e.g. from a successful auto-advance).
 * Overwrites any existing entry (including failed ones) for this key.
 */
function cacheNzbdavStreamResult(cacheKey, data) {
  nzbdavStreamCache.set(cacheKey, {
    status: 'ready',
    data,
    expiresAt: NZBDAV_CACHE_TTL_MS > 0 ? Date.now() + NZBDAV_CACHE_TTL_MS : null,
  });
}

module.exports = {
  cleanupNzbdavCache,
  clearNzbdavStreamCache,
  getCachedNzbdavStream,
  getOrCreateNzbdavStream,
  cacheNzbdavStreamResult,
  buildNzbdavCacheKey,
  getNzbdavCacheStats,
  reloadNzbdavCacheConfig,
};

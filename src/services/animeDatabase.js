// Anime database service — downloads and indexes Fribb, Kitsu-IMDB, and Manami mappings
// to resolve anime IDs (kitsu/mal/anilist) → IMDB/TVDB + titles/synonyms for text search.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const axios = require('axios');
const https = require('https');

const DATA_DIR = path.join(__dirname, '..', '..', 'cache', 'anime_db');

const httpsAgent = new https.Agent({ keepAlive: false });

const DATA_SOURCES = {
  fribb: {
    url: 'https://raw.githubusercontent.com/Fribb/anime-lists/refs/heads/master/anime-list-full.json',
    file: path.join(DATA_DIR, 'fribb-mappings.json'),
    refreshMs: 24 * 60 * 60 * 1000, // 1 day
  },
  kitsuImdb: {
    url: 'https://raw.githubusercontent.com/TheBeastLT/stremio-kitsu-anime/master/static/data/imdb_mapping.json',
    file: path.join(DATA_DIR, 'kitsu-imdb-mapping.json'),
    refreshMs: 24 * 60 * 60 * 1000,
  },
  manami: {
    url: 'https://github.com/manami-project/anime-offline-database/releases/download/latest/anime-offline-database-minified.json',
    file: path.join(DATA_DIR, 'manami-db.json'),
    refreshMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
};

// Supported anime ID types and their regex patterns for Stremio request IDs
const ANIME_ID_PARSERS = {
  kitsu: {
    // kitsu:12345 or kitsu:12345:5 (episode-only, no season in kitsu IDs)
    regex: /^kitsu[:-](\d+)(?::(\d+))?$/i,
    parse: (match) => ({ idType: 'kitsu', id: Number(match[1]), episode: match[2] ? Number(match[2]) : null }),
  },
  mal: {
    regex: /^mal[:-](\d+)(?::(\d+))?$/i,
    parse: (match) => ({ idType: 'mal', id: Number(match[1]), episode: match[2] ? Number(match[2]) : null }),
  },
  anilist: {
    regex: /^anilist[:-](\d+)(?::(\d+))?$/i,
    parse: (match) => ({ idType: 'anilist', id: Number(match[1]), episode: match[2] ? Number(match[2]) : null }),
  },
};

// Maps our idType names to Fribb JSON field names
const ID_TYPE_TO_FRIBB_KEY = {
  kitsu: 'kitsu_id',
  mal: 'mal_id',
  anilist: 'anilist_id',
};

// --- In-memory indexed data ---
// fribbByXxx: Map<number, MappingEntry[]>
let fribbByKitsu = new Map();
let fribbByMal = new Map();
let fribbByAnilist = new Map();
// kitsuById: Map<number, KitsuEntry>
let kitsuById = new Map();
// manamiByXxx: Map<string, ManamiEntry>  (keyed by extracted ID from source URLs)
let manamiByKitsu = new Map();
let manamiByMal = new Map();
let manamiByAnilist = new Map();

let initialized = false;
let initPromise = null;
let lastLoadTimestamps = {};

// --- Public API ---

/**
 * Parse a Stremio request ID and return anime info if it's an anime ID.
 * Returns null if the ID is not a recognized anime prefix.
 */
function parseAnimeId(fullId) {
  if (!fullId || typeof fullId !== 'string') return null;
  for (const parser of Object.values(ANIME_ID_PARSERS)) {
    const match = fullId.match(parser.regex);
    if (match) return parser.parse(match);
  }
  return null;
}

/**
 * Check if a base identifier (before season/episode stripping) is an anime ID.
 */
function isAnimeId(baseIdentifier) {
  if (!baseIdentifier || typeof baseIdentifier !== 'string') return false;
  const lower = baseIdentifier.toLowerCase();
  return lower.startsWith('kitsu:') || lower.startsWith('kitsu-')
    || lower.startsWith('mal:') || lower.startsWith('mal-')
    || lower.startsWith('anilist:') || lower.startsWith('anilist-');
}

/**
 * Resolve an anime ID to Western IDs (imdb, tvdb, tmdb) + titles.
 * Returns { imdbId, tvdbId, tmdbId, season, episode, titles[], originalTitle, year } or null.
 */
async function resolveAnimeId(animeIdInfo) {
  await ensureInitialized();
  if (!animeIdInfo) return null;

  const { idType, id, episode } = animeIdInfo;

  // Step 1: Get Fribb mapping entry
  const mappings = getFribbMappings(idType, id);
  if (!mappings || mappings.length === 0) {
    console.log(`[ANIME-DB] No Fribb mapping found for ${idType}:${id}`);
    return null;
  }

  // Use first mapping (most common case; multiple entries = split-cour)
  const mapping = mappings[0];

  const imdbId = mapping.imdb_id || null;
  const tvdbId = mapping.thetvdb_id || mapping.tvdb_id || null;
  const tmdbId = mapping.themoviedb_id || null;
  const kitsuId = mapping.kitsu_id || null;

  // Step 2: Get episode offset from Kitsu-IMDB data
  let season = null;
  let resolvedEpisode = episode;
  const kitsuEntry = kitsuId ? kitsuById.get(Number(kitsuId)) : null;

  if (kitsuEntry) {
    if (kitsuEntry.fromSeason) {
      season = kitsuEntry.fromSeason;
    }
    if (episode != null && kitsuEntry.fromEpisode && kitsuEntry.fromEpisode !== 1) {
      resolvedEpisode = kitsuEntry.fromEpisode + episode - 1;
    }
  }

  // Fallback: use Fribb season data
  if (season == null && mapping.season) {
    season = mapping.season.tvdb || mapping.season.tmdb || null;
  }
  // Default season to 1 if we have a TVDB ID but no season info
  if (season == null && tvdbId) {
    season = 1;
  }

  // Step 3: Gather all known titles (main title + synonyms from Manami)
  const titles = collectTitles(idType, id, mapping, kitsuEntry);

  console.log(`[ANIME-DB] Resolved ${idType}:${id}`, {
    imdbId,
    tvdbId,
    tmdbId,
    season,
    episode: resolvedEpisode,
    titleCount: titles.length,
    titles: titles.slice(0, 5),
  });

  return {
    imdbId: imdbId ? (String(imdbId).startsWith('tt') ? imdbId : `tt${imdbId}`) : null,
    tvdbId: tvdbId ? String(tvdbId) : null,
    tmdbId: tmdbId ? String(tmdbId) : null,
    season,
    episode: resolvedEpisode,
    titles,
    originalTitle: titles[0] || null,
    year: getManamiYear(idType, id),
  };
}

// --- Internal helpers ---

function getFribbMappings(idType, id) {
  const map = idType === 'kitsu' ? fribbByKitsu
    : idType === 'mal' ? fribbByMal
    : idType === 'anilist' ? fribbByAnilist
    : null;
  return map ? (map.get(Number(id)) || null) : null;
}

function getManamiEntry(idType, id) {
  const map = idType === 'kitsu' ? manamiByKitsu
    : idType === 'mal' ? manamiByMal
    : idType === 'anilist' ? manamiByAnilist
    : null;
  return map ? (map.get(String(id)) || null) : null;
}

function getManamiYear(idType, id) {
  const entry = getManamiEntry(idType, id);
  if (!entry) return null;
  return entry.animeSeason?.year || null;
}

/**
 * Collect all unique ASCII-searchable titles for an anime.
 * Includes: Manami main title, Manami synonyms, Kitsu title, Fribb cross-referenced titles.
 * CJK-only titles are kept (indexers may have them), but ASCII variants are also added.
 */
function collectTitles(idType, id, fribbMapping, kitsuEntry) {
  const titleSet = new Set();
  const titles = [];

  const addTitle = (t) => {
    if (!t || typeof t !== 'string') return;
    const cleaned = t.trim();
    if (!cleaned) return;
    const key = cleaned.toLowerCase();
    if (titleSet.has(key)) return;
    titleSet.add(key);
    titles.push(cleaned);
  };

  // 1. Manami: main title + synonyms (best source of alternate titles)
  const manamiEntry = getManamiEntry(idType, id);
  if (manamiEntry) {
    addTitle(manamiEntry.title);
    if (Array.isArray(manamiEntry.synonyms)) {
      for (const syn of manamiEntry.synonyms) {
        addTitle(syn);
      }
    }
  }

  // 2. Kitsu-IMDB title
  if (kitsuEntry?.title) {
    addTitle(kitsuEntry.title);
  }

  // 3. Cross-reference: look up via other IDs in Fribb to get Manami entries
  // e.g., if we came in via kitsu, also look up the MAL and AniList Manami entries
  const crossIds = [
    { type: 'kitsu', val: fribbMapping.kitsu_id },
    { type: 'mal', val: fribbMapping.mal_id },
    { type: 'anilist', val: fribbMapping.anilist_id },
  ];

  for (const cross of crossIds) {
    if (!cross.val || (cross.type === idType && String(cross.val) === String(id))) continue;
    const crossManami = getManamiEntry(cross.type, cross.val);
    if (crossManami) {
      addTitle(crossManami.title);
      if (Array.isArray(crossManami.synonyms)) {
        for (const syn of crossManami.synonyms) {
          addTitle(syn);
        }
      }
    }
  }

  return titles;
}

/**
 * Normalize text to ASCII for search queries (same as tmdb.js normalizeToAscii).
 * Also strips apostrophes/quotes since Usenet/torrent release names never use them.
 */
function normalizeToAscii(text) {
  if (!text) return '';
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')  // strip combining diacritics
    .replace(/[^a-zA-Z0-9\s-]/g, '')  // keep only alphanumeric, spaces, hyphens
    .replace(/\s{2,}/g, ' ')           // collapse multiple spaces
    .trim();
}

/**
 * Filter and rank titles to only those useful for Usenet text search.
 * Returns at most `limit` { title, asciiTitle } objects, prioritized:
 *   1. Titles whose original text is Latin-script (English/romaji/European)
 *   2. Earlier titles in the source list (Manami puts the canonical title first)
 *   3. Skip pure-CJK, very short (≤3 chars), and number-only titles
 * Deduplicates by normalized ASCII key (lowercase alphanumeric only).
 */
// Regex to detect season/part qualifiers commonly appended to anime titles
// e.g. "Season 3", "2nd Season", "Part 2", "Cour 2", "Zenpen", "Kouhen"
const SEASON_QUALIFIER_REGEX = /\b(?:season\s*\d+|\d+(?:st|nd|rd|th)\s+season|part\s*\d+|cour\s*\d+|zenpen|kouhen)\b/i;

function getSearchableTitles(titles, limit = 3) {
  const candidates = [];
  const seenNormalized = new Set();

  for (let i = 0; i < titles.length; i++) {
    const title = titles[i];
    const ascii = normalizeToAscii(title);
    if (!ascii || ascii.length <= 3) continue;
    if (/^\d+$/.test(ascii)) continue;

    // Skip titles containing season/part qualifiers — too specific for Usenet
    if (SEASON_QUALIFIER_REGEX.test(ascii)) continue;

    // Dedup by lowercase alphanumeric
    const dedup = ascii.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!dedup || dedup.length <= 2) continue;
    if (seenNormalized.has(dedup)) continue;
    seenNormalized.add(dedup);

    // Reject titles that are mostly non-Latin (CJK, Cyrillic, Arabic, Thai, etc.)
    const nonBasicLatin = title.replace(/[\x00-\x7F\u00C0-\u024F\u2018-\u201F]/g, '');
    if (nonBasicLatin.length > title.length * 0.1) continue;

    // Score: position bonus (first titles are most canonical) + moderate word bonus
    // Position 0 gets +50, position 1 gets +49, etc.
    // Word bonus capped at 3 words to avoid long subtitle variants dominating
    const positionBonus = Math.max(0, 50 - i);
    const wordCount = Math.min(3, ascii.split(/\s+/).filter(w => w.length > 1).length);
    const score = positionBonus + wordCount * 5;

    candidates.push({ title, asciiTitle: ascii, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, limit).map(({ title, asciiTitle }) => ({ title, asciiTitle }));
}

// --- Data loading ---

async function ensureInitialized() {
  if (initialized) return;
  if (initPromise) return initPromise;
  initPromise = initialize();
  return initPromise;
}

async function initialize() {
  console.log('[ANIME-DB] Initializing anime database...');
  const startTs = Date.now();

  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  // Download/refresh data files in parallel
  await Promise.all([
    refreshDataFile(DATA_SOURCES.fribb),
    refreshDataFile(DATA_SOURCES.kitsuImdb),
    refreshDataFile(DATA_SOURCES.manami),
  ]);

  // Parse and index
  await loadFribbMappings();
  await loadKitsuImdbMapping();
  await loadManamiDb();

  initialized = true;
  initPromise = null;
  console.log(`[ANIME-DB] Initialized in ${Date.now() - startTs}ms`, {
    fribbKitsu: fribbByKitsu.size,
    fribbMal: fribbByMal.size,
    fribbAnilist: fribbByAnilist.size,
    kitsu: kitsuById.size,
    manamiKitsu: manamiByKitsu.size,
    manamiMal: manamiByMal.size,
    manamiAnilist: manamiByAnilist.size,
  });

  // Schedule background refreshes
  scheduleRefresh();
}

async function refreshDataFile(source) {
  const needsDownload = await shouldDownload(source);
  if (!needsDownload) {
    return;
  }
  console.log(`[ANIME-DB] Downloading ${path.basename(source.file)}...`);
  try {
    const response = await axios.get(source.url, {
      httpsAgent,
      responseType: 'arraybuffer',
      timeout: 60000,
      headers: { 'Accept-Encoding': 'gzip, deflate' },
    });
    await fsp.writeFile(source.file, response.data);
    lastLoadTimestamps[source.file] = Date.now();
    console.log(`[ANIME-DB] Downloaded ${path.basename(source.file)} (${(response.data.length / 1024 / 1024).toFixed(1)}MB)`);
  } catch (err) {
    // If file exists on disk already, use it even if download failed
    if (fs.existsSync(source.file)) {
      console.warn(`[ANIME-DB] Download failed for ${path.basename(source.file)}, using cached version: ${err.message}`);
    } else {
      throw new Error(`[ANIME-DB] Failed to download ${path.basename(source.file)}: ${err.message}`);
    }
  }
}

async function shouldDownload(source) {
  try {
    const stat = await fsp.stat(source.file);
    const age = Date.now() - stat.mtimeMs;
    return age > source.refreshMs;
  } catch {
    return true; // File doesn't exist
  }
}

function scheduleRefresh() {
  // Refresh every 24 hours (check all sources)
  const REFRESH_INTERVAL = 24 * 60 * 60 * 1000;
  setInterval(async () => {
    try {
      console.log('[ANIME-DB] Scheduled refresh starting...');
      await Promise.all([
        refreshDataFile(DATA_SOURCES.fribb),
        refreshDataFile(DATA_SOURCES.kitsuImdb),
        refreshDataFile(DATA_SOURCES.manami),
      ]);
      await loadFribbMappings();
      await loadKitsuImdbMapping();
      await loadManamiDb();
      console.log('[ANIME-DB] Scheduled refresh complete');
    } catch (err) {
      console.error('[ANIME-DB] Scheduled refresh failed:', err.message);
    }
  }, REFRESH_INTERVAL).unref();
}

async function loadFribbMappings() {
  const raw = await fsp.readFile(DATA_SOURCES.fribb.file, 'utf-8');
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) throw new Error('Fribb data must be an array');

  const newKitsu = new Map();
  const newMal = new Map();
  const newAnilist = new Map();

  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue;
    const kId = entry.kitsu_id;
    const mId = entry.mal_id;
    const aId = entry.anilist_id;

    if (kId != null) {
      const existing = newKitsu.get(Number(kId));
      if (existing) existing.push(entry);
      else newKitsu.set(Number(kId), [entry]);
    }
    if (mId != null) {
      const existing = newMal.get(Number(mId));
      if (existing) existing.push(entry);
      else newMal.set(Number(mId), [entry]);
    }
    if (aId != null) {
      const existing = newAnilist.get(Number(aId));
      if (existing) existing.push(entry);
      else newAnilist.set(Number(aId), [entry]);
    }
  }

  fribbByKitsu = newKitsu;
  fribbByMal = newMal;
  fribbByAnilist = newAnilist;
  console.log(`[ANIME-DB] Fribb indexed: ${data.length} entries (kitsu=${newKitsu.size}, mal=${newMal.size}, anilist=${newAnilist.size})`);
}

async function loadKitsuImdbMapping() {
  const raw = await fsp.readFile(DATA_SOURCES.kitsuImdb.file, 'utf-8');
  const data = JSON.parse(raw);

  const newMap = new Map();
  const entries = Array.isArray(data)
    ? data.map((e) => [e.kitsu_id, e])
    : Object.entries(data).map(([id, e]) => [Number(id), e]);

  for (const [kitsuId, entry] of entries) {
    if (!entry || typeof entry !== 'object') continue;
    newMap.set(Number(kitsuId), {
      tvdbId: entry.tvdb_id ?? entry.tvdbId ?? null,
      imdbId: entry.imdb_id ?? entry.imdbId ?? null,
      title: entry.title ?? null,
      fromSeason: entry.fromSeason ?? entry.from_season ?? null,
      fromEpisode: entry.fromEpisode ?? entry.from_episode ?? null,
    });
  }

  // Enrich Fribb entries that lack IMDB with Kitsu-IMDB data
  let enriched = 0;
  for (const [kitsuId, kitsuEntry] of newMap) {
    if (!kitsuEntry.imdbId) continue;
    const fribbEntries = fribbByKitsu.get(kitsuId);
    if (!fribbEntries) continue;
    for (const entry of fribbEntries) {
      if (!entry.imdb_id && kitsuEntry.imdbId) {
        entry.imdb_id = kitsuEntry.imdbId;
        enriched++;
      }
    }
  }

  kitsuById = newMap;
  console.log(`[ANIME-DB] Kitsu-IMDB indexed: ${newMap.size} entries, enriched ${enriched} Fribb mappings`);
}

async function loadManamiDb() {
  const raw = await fsp.readFile(DATA_SOURCES.manami.file, 'utf-8');
  const data = JSON.parse(raw);
  const entries = data.data;
  if (!Array.isArray(entries)) throw new Error('Manami data.data must be an array');

  const extractors = {
    kitsu: (url) => { const m = url.match(/kitsu\.(?:io|app)\/anime\/(\d+)/); return m ? m[1] : null; },
    mal: (url) => { const m = url.match(/myanimelist\.net\/anime\/(\d+)/); return m ? m[1] : null; },
    anilist: (url) => { const m = url.match(/anilist\.co\/anime\/(\d+)/); return m ? m[1] : null; },
  };

  const newKitsu = new Map();
  const newMal = new Map();
  const newAnilist = new Map();

  for (const entry of entries) {
    if (!entry || !Array.isArray(entry.sources)) continue;

    // Minimise: only keep title, synonyms, animeSeason
    const minimised = {
      title: entry.title || null,
      synonyms: Array.isArray(entry.synonyms) ? entry.synonyms : [],
      animeSeason: entry.animeSeason || null,
    };

    for (const sourceUrl of entry.sources) {
      if (typeof sourceUrl !== 'string') continue;
      for (const [idType, extractor] of Object.entries(extractors)) {
        const extractedId = extractor(sourceUrl);
        if (extractedId) {
          const targetMap = idType === 'kitsu' ? newKitsu : idType === 'mal' ? newMal : newAnilist;
          if (!targetMap.has(extractedId)) {
            targetMap.set(extractedId, minimised);
          }
        }
      }
    }
  }

  manamiByKitsu = newKitsu;
  manamiByMal = newMal;
  manamiByAnilist = newAnilist;
  console.log(`[ANIME-DB] Manami indexed: ${entries.length} entries (kitsu=${newKitsu.size}, mal=${newMal.size}, anilist=${newAnilist.size})`);
}

/**
 * Returns true if the database has been initialized and has data loaded.
 */
function isReady() {
  return initialized && fribbByKitsu.size > 0;
}

module.exports = {
  parseAnimeId,
  isAnimeId,
  resolveAnimeId,
  normalizeToAscii,
  getSearchableTitles,
  ensureInitialized,
  isReady,
};

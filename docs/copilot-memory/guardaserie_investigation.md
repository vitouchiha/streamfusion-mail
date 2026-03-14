# GuardaSerie Provider Investigation

## Problem Statement
For Frieren S2E7 (tt22248376:2:7), GuardaSerie returns "Frieren - Oltre la Fine del Viaggio 1x7" instead of S2E7.

## Key Files Analyzed
1. **src/guardaserie/index.js** - Main scraper (850+ lines)
2. **src/providers/guardaserie.js** - Legacy provider config (deprecated, not used)
3. **src/index.js** - Main integration point
4. **src/mapping/index.js** - ID resolution system
5. **src/stream_engine/engine.js** - Stream discovery engine

## GuardaSerie Flow (from src/guardaserie/index.js)

### Step 1: ID Resolution
- Input: `id` can be IMDB (tt...), TMDB (tmdb:...), or Kitsu (kitsu:...)
- For IMDB: Uses TMDB API to convert tt-number to TMDB ID
- Falls back to title-based search if TMDB conversion fails

### Step 2: Show Search (Priority Order)
1. **IMDb ID Search** (preferred): `?do=search&subaction=search&story=<IMDB_ID>`
   - Fetches all results, checks each result page for exact IMDb ID match
   - Validates via `show_imdb` variable, IMDb links, or TMDB link verification
2. **Title Search** (fallback): `?do=search&subaction=search&story=<TITLE>`
   - Searches by title candidates (original/English/transliterated)
   - Validates via year, IMDb/TMDB links

### Step 3: Episode Finding
Function: `collectEpisodeLinks(showHtml, season, episode)`
Pattern 1: `<a id="serie-S_E" ... data-link="...">` (preferred)
Pattern 2: `data-num="SxE"` → find nearby `<div class="mirrors"><a data-link="...">` blocks
Pattern 3: Raw regex fallback

**CRITICAL**: Uses EXACT season/episode numbers (e.g., `serie-2_7` for S2E7)

### Step 4: Stream Extraction
- Separates SuperVideo mirrors (handled sequentially due to CF blocking)
- Other hosters extracted in parallel
- Quality detection from manifest or URL patterns

## Key Variables in Code
```javascript
effectiveSeason = requestedSeason || 1
effectiveEpisode = requestedEpisode || 1

// Uses these in collectEpisodeLinks:
const episodeIds = [
    `serie-${season}_${episode}`,
    `serie-${season}_${String(episode).padStart(2, '0')}`,
];
```

## The Bug Root Cause - Hypothesis

GuardaSerie likely lists multi-season shows in ONE of these ways:

### Scenario A (Most Likely): Single Show URL, Season Tabs
- GuardaSerie has one page for "Frieren - Oltre la Fine del Viaggio" 
- HTML contains tabs/sections for Season 1 and Season 2
- Elements are like `serie-1_1`, `serie-1_2`... (S1)
- And `serie-2_1`, `serie-2_2` for Season 2... but they may not be showing up
- **The season number in the HTML identifier matters!**

### Scenario B: Separate URLs per Season
- GuardaSerie has "Frieren - Oltre la Fine del Viaggio" → S1
- GuardaSerie has "Frieren - Oltre la Fine del Viaggio 2" → S2 (different slug)
- Our search returns S1 when S2 is requested
- **Need to detect and prefer season-specific slugs**

### Scenario C: Episode Numbers Reset Per Season
- Each season has episodes 1-12 in GUI
- But they're stored with absolute episode numbers
- S1E1-E12 = episodes 1-12
- S2E1-E12 = episodes 13-24
- S2E7 = absolute episode 19
- **collectEpisodeLinks() is looking for serie-2_7 but the site stores it as serie-1_19**

## Verification Needed
1. Check actual GuardaSerie page source for Frieren
   - Does it have `serie-2_7` or `serie-1_19`?
   - Are there season tabs/selectors?
   - Is there a separate S2 show page?

2. Verify the effective season/episode values passed to collectEpisodeLinks
   - Are they correctly mapped from TMDB mappings?

3. Check if TMDB episode mapping is working (in src/mapping/index.js)
   - resolveTmdbEpisode() should map Kitsu episode numbers to TMDB season/episode

## Code Locations to Monitor

**Season/Episode Passed to Collection**: Line ~890 in guardaserie/index.js
```javascript
season = effectiveSeason;
episode = effectiveEpisode;
const episodeStr = `${season}x${episode}`;
const links = collectEpisodeLinks(showHtml, season, episode);
```

**Where effectiveSeason comes from**: 
- From parameter: `Number.parseInt(String(season || ""), 10)`
- Via Kitsu mapping: `mapped.mappedSeason` from `getIdsFromKitsu()`

**collectEpisodeLinks searches for**:
- `serie-${season}_${episode}` (exact)
- `serie-${season}_${padded_episode}` (zero-padded)
- As fallback: `data-num="${episodeStr}"` within mirrors div

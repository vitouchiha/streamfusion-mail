// TMDB Client Adapter with it-IT priority
const fetcher = require('../utils/fetcher');
const { TMDB_API_KEY } = require('../utils/config');
const BASE_URL = 'https://api.themoviedb.org/3';
const IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/w500'; // Using w500 as default from configuration endpoint

async function fetchTmdb(endpoint, params = {}) {
    const url = new URL(`${BASE_URL}${endpoint}`);
    url.searchParams.append('api_key', TMDB_API_KEY);
    for (const [key, value] of Object.entries(params)) {
        url.searchParams.append(key, value);
    }
    const response = await fetcher(url.toString()); // Assumes fetcher returns JSON
    return response;
}

async function get_movie(id, lang = 'it-IT') {
    let data = await fetchTmdb(`/movie/${id}`, { language: lang });
    if (!data || (!data.overview && lang === 'it-IT')) {
        // Fallback to en-US if no overview or data not found
        data = await fetchTmdb(`/movie/${id}`, { language: 'en-US' });
    }
    return data;
}

async function get_series(id, lang = 'it-IT') {
    let data = await fetchTmdb(`/tv/${id}`, { language: lang });
    if (!data || (!data.overview && lang === 'it-IT')) {
        data = await fetchTmdb(`/tv/${id}`, { language: 'en-US' });
    }
    return data;
}

async function get_season_episodes(tmdb_id, season, lang = 'it-IT') {
    let data = await fetchTmdb(`/tv/${tmdb_id}/season/${season}`, { language: lang });
    if (!data || (!data.overview && lang === 'it-IT')) {
        data = await fetchTmdb(`/tv/${tmdb_id}/season/${season}`, { language: 'en-US' });
    }
    return data;
}

async function get_external_ids(tmdb_id, type = 'movie') {
    // type can be 'movie' or 'tv'
    return await fetchTmdb(`/${type}/${tmdb_id}/external_ids`);
}

module.exports = {
    get_movie,
    get_series,
    get_season_episodes,
    get_external_ids,
    IMAGE_BASE_URL
};

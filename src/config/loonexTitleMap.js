const LOONEX_TITLE_MAP = {
    "tt4788708": "over the garden wall",
    "tt3718778": "over the garden wall",
    "61617": "over the garden wall"
};

function getLoonexTitle(imdbId, tmdbId) {
    if (imdbId && LOONEX_TITLE_MAP[imdbId]) return LOONEX_TITLE_MAP[imdbId];
    if (tmdbId && LOONEX_TITLE_MAP[tmdbId]) return LOONEX_TITLE_MAP[tmdbId];
    return undefined;
}

module.exports = { getLoonexTitle, LOONEX_TITLE_MAP };

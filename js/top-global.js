import { TOP_GLOBAL_COPY } from './i18n/locales.js';
import { spotifyTrackUrl } from './spotify-presentation.js';

export function rankingMovement(track) {
    if (track.movement === 'NEW' || track.movement === 'RE') return [track.movement, ''];
    if (track.movement !== 'change') return ['', ''];
    if (track.delta > 0) return [`↑ ${track.delta}`, 'up'];
    if (track.delta < 0) return [`↓ ${-track.delta}`, 'down'];
    return ['—', ''];
}

export function letterboxdUrl(id) {
    return Number.isSafeInteger(id) && id > 0 ? `https://letterboxd.com/tmdb/${id}` : null;
}

const node = (tag, css, text) => {
    const el = document.createElement(tag);
    if (css) el.className = css;
    if (text != null) el.textContent = text;
    return el;
};

function mediaBlock({url, image, title, subtitle, className, lazy}) {
    const item = node(url ? 'a' : 'div', `ranking-media ${className}`);
    if (url) {
        item.href = url;
        item.target = '_blank';
        item.rel = 'noopener noreferrer';
    }
    const media = node('span', 'ranking-image');
    if (image && /^https:\/\/(?:image\.tmdb\.org\/t\/p\/|i\.scdn\.co\/image\/)/.test(image)) {
        const img = node('img');
        img.src = image;
        img.alt = '';
        if (lazy) img.loading = 'lazy';
        img.decoding = 'async';
        media.append(img);
    }
    item.append(media);
    const text = node('span', 'ranking-label');
    text.append(node('strong', '', title), node('small', '', subtitle));
    item.append(text);
    return item;
}

export function createTopGlobalView(getLanguage) {
    const description = document.getElementById('ranking-description');
    const source = document.getElementById('ranking-source');
    const updated = document.getElementById('ranking-updated');
    const status = document.getElementById('ranking-status');
    const list = document.getElementById('ranking-list');
    let snapshot, inFlight, lastSuccess = 0;

    function localize() {
        const language = getLanguage();
        const [intro, dateLabel, loading, unavailable, pending] = TOP_GLOBAL_COPY[language] || TOP_GLOBAL_COPY.en;
        description.textContent = intro;
        status.textContent = snapshot ? '' : inFlight ? loading : unavailable;
        status.classList.toggle('ranking-unavailable', !snapshot && !inFlight);
        if (!snapshot) return;
        if (snapshot.source === 'charts') {
            source.href = 'https://charts.spotify.com/charts/view/regional-global-daily/latest';
            source.textContent = 'Spotify Charts';
        } else {
            source.href = 'https://open.spotify.com/playlist/37i9dQZEVXbMDoHDwVN2tF';
            source.textContent = 'Spotify';
        }
        const date = new Date(snapshot.updated_at);
        updated.dateTime = Number.isNaN(+date) ? '' : date.toISOString();
        updated.textContent = updated.dateTime ? `${dateLabel} ${new Intl.DateTimeFormat(language, {dateStyle:'medium'}).format(date)}` : '';
        list.replaceChildren(...snapshot.tracks.map(track => {
            const row = node('li', `ranking-row${track.position === 1 ? ' ranking-leader' : ''}`);
            const [movement, direction] = rankingMovement(track);
            const rank = node('span', 'ranking-position', String(track.position).padStart(2,'0'));
            if (movement) rank.append(node('small', `ranking-movement ${direction}`, movement));
            row.append(rank,mediaBlock({
                url:spotifyTrackUrl('spotify', track.spotify_id), image:track.cover, title:track.title,
                subtitle:track.artist, className:'ranking-song', lazy:track.position > 1,
            }));
            const arrow = node('span', 'ranking-arrow', '→');
            arrow.setAttribute('aria-hidden','true');
            row.append(arrow);
            const movie = track.movie;
            row.append(movie ? mediaBlock({
                url:letterboxdUrl(movie.tmdb_id), image:movie.poster, title:movie.title || movie.original_title,
                subtitle:movie.year, className:'ranking-film', lazy:track.position > 1,
            }) : node('span', 'ranking-pending', pending));
            return row;
        }));
    }

    async function load() {
        if (inFlight || Date.now()-lastSuccess < 300000) return;
        inFlight = true;
        localize();
        try {
            const response = await fetch('/top-global', {signal:AbortSignal.timeout(8000)});
            if (!response.ok) return;
            const data = await response.json();
            if (!Array.isArray(data?.tracks) || data.tracks.length !== 50) return;
            snapshot = data;
            lastSuccess = Date.now();
        } catch {
            // Retain the last valid response in this browser session.
        } finally {
            inFlight = false;
            localize();
        }
    }
    return {load,localize};
}

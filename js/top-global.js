import { PRESENTATION_COPY, TOP_GLOBAL_COPY, TOP_GLOBAL_TITLES } from './i18n/locales.js';
import { spotifyTrackUrl } from './spotify-presentation.js';

export function rankingMovement(track, language) {
    const copy = PRESENTATION_COPY[language];
    const numbers = new Intl.NumberFormat(language);
    if (track.movement === 'NEW' || track.movement === 'RE') return [copy?.[track.movement === 'NEW' ? 0 : 1] || track.movement, ''];
    if (track.movement !== 'change') return ['', ''];
    if (track.delta > 0) return [`↑ ${numbers.format(track.delta)}`, 'up'];
    if (track.delta < 0) return [`↓ ${numbers.format(-track.delta)}`, 'down'];
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
    const heading = document.getElementById('top-global-title');
    const navigation = document.querySelector('[data-view="view-top-global"]');
    const description = document.getElementById('ranking-description');
    const source = document.getElementById('ranking-source');
    const updated = document.getElementById('ranking-updated');
    const status = document.getElementById('ranking-status');
    const list = document.getElementById('ranking-list');
    let snapshot, inFlight, lastSuccess = 0;

    function localize() {
        const language = getLanguage();
        const title = TOP_GLOBAL_TITLES[language] || TOP_GLOBAL_TITLES.en;
        heading.textContent = title;
        navigation.textContent = title;
        const movementCopy = PRESENTATION_COPY[language] || PRESENTATION_COPY.en;
        const [intro, dateLabel, loading, unavailable, pending] = TOP_GLOBAL_COPY[language] || TOP_GLOBAL_COPY.en;
        description.textContent = intro;
        status.textContent = snapshot ? '' : inFlight ? loading : unavailable;
        status.classList.toggle('ranking-unavailable', !snapshot && !inFlight);
        if (!snapshot) {
            source.setAttribute('aria-label', `${movementCopy[5]}: ${source.textContent}`);
            return;
        }
        if (snapshot.source === 'charts') {
            source.href = 'https://charts.spotify.com/charts/view/regional-global-daily/latest';
            source.textContent = 'Spotify Charts';
        } else {
            source.href = 'https://open.spotify.com/playlist/37i9dQZEVXbMDoHDwVN2tF';
            source.textContent = 'Spotify';
        }
        source.setAttribute('aria-label', `${movementCopy[5]}: ${source.textContent}`);
        const date = new Date(snapshot.updated_at);
        updated.dateTime = Number.isNaN(+date) ? '' : date.toISOString();
        updated.textContent = updated.dateTime ? `${dateLabel} ${new Intl.DateTimeFormat(language, {dateStyle:'medium'}).format(date)}` : '';
        list.replaceChildren(...snapshot.tracks.map(track => {
            const row = node('li', `ranking-row${track.position === 1 ? ' ranking-leader' : ''}`);
            const [movement, direction] = rankingMovement(track, language);
            const rank = node('span', 'ranking-position', new Intl.NumberFormat(language,{minimumIntegerDigits:2}).format(track.position));
            if (movement) {
                const indicator = node('small', `ranking-movement ${direction}`, movement);
                if (direction || movement === '—') indicator.setAttribute('aria-label', direction
                    ? `${movementCopy[direction === 'up' ? 2 : 3]} ${Math.abs(track.delta)}` : movementCopy[4]);
                rank.append(indicator);
            }
            row.append(rank,mediaBlock({
                url:spotifyTrackUrl('spotify', track.spotify_id), image:track.cover, title:track.title,
                subtitle:track.artist, className:'ranking-song', lazy:track.position > 1,
            }));
            const arrow = node('span', 'ranking-arrow', '→');
            arrow.setAttribute('aria-hidden','true');
            row.append(arrow);
            const movie = track.movie;
            row.append(movie ? mediaBlock({
                url:letterboxdUrl(movie.tmdb_id), image:movie.poster, title:movie.localized_titles?.[language] || movie.title || movie.original_title,
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

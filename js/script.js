/**
 * Moovibe - Frontend Logic
 * Handles SPA navigation, loading states, and dynamic content injection.
 */

document.addEventListener('DOMContentLoaded', () => {
    
    // --- DOM Elements ---
    const searchForm = document.getElementById('search-form');
    const songInput = document.getElementById('song-title');
    const artistInput = document.getElementById('artist-name');
    const btnSearchAgain = document.getElementById('btn-search-again');
    const tagButtons = document.querySelectorAll('.tag-btn');
    const logoEl = document.querySelector('.nav-logo h1');
    const navLinks = document.querySelectorAll('.nav-links a[data-view]');
    
    // Views
    const viewHome = document.getElementById('view-home');
    const viewLoading = document.getElementById('view-loading');
    const viewResults = document.getElementById('view-results');
    const viewError = document.getElementById('view-error');
    const viewHallOfFame = document.getElementById('view-hall-of-fame');
    const loadingText = document.getElementById('loading-text');
    const errorMessage = document.getElementById('error-message');
    const btnRetry = document.getElementById('btn-retry');

    // Loading strings for cinematic feel
    const loadingMessages = [
        "Listening to the atmosphere...",
        "Reading the lyrics...",
        "Searching beyond genres...",
        "Curating emotions...",
        "Finding a cinematic soul..."
    ];

    // --- Core Functions ---

    function getUrlParam(name) {
        const params = new URLSearchParams(window.location.search);
        return params.get(name) || null;
    }

    function switchView(targetView) {
        if (!targetView) return;
        document.querySelectorAll('.view-section').forEach(view => {
            view.classList.remove('active');
        });
        targetView.classList.add('active');
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function showError(message) {
        if (errorMessage) {
            errorMessage.textContent = message;
        }
        switchView(viewError);
    }

    function startLoadingSequence(fetchPromise) {
        switchView(viewLoading);
        
        let messageIndex = 0;
        loadingText.textContent = loadingMessages[0];
        
        const messageInterval = setInterval(() => {
            messageIndex++;
            if (messageIndex < loadingMessages.length) {
                loadingText.textContent = loadingMessages[messageIndex];
            }
        }, 800);

        fetchPromise
            .then(data => {
                clearInterval(messageInterval);
                if (data && data.error && data.error.message) {
                    showError(data.error.message);
                } else {
                    injectResults(data);
                    switchView(viewResults);
                    // Atualiza a URL com o slug para compartilhamento
                    if (data && data.share_slug) {
                        window.history.pushState(null, '', '/?r=' + data.share_slug);
                    }
                }
            })
            .catch(error => {
                clearInterval(messageInterval);
                console.error('Erro na requisição:', error);
                showError('Não foi possível encontrar a vibe dessa música. Tente novamente ou escolha outra faixa.');
            });
    }

    function resetSearch() {
        if (songInput) songInput.value = '';
        if (artistInput) artistInput.value = '';
    }

    function goHome() {
        resetSearch();
        switchView(viewHome);
    }

    async function loadHallOfFame() {
        const grid = document.getElementById('hall-grid');
        if (!grid) return;

        grid.innerHTML = '<p class="hall-subtitle">Loading matches...</p>';

        try {
            const response = await fetch('/recommend', { method: 'GET' });
            if (!response.ok) {
                throw new Error('Failed to load history');
            }
            const items = await response.json();

            if (!Array.isArray(items) || items.length === 0) {
                grid.innerHTML = '<p class="hall-subtitle">No matches yet. Be the first to discover one.</p>';
                return;
            }

            grid.innerHTML = '';
            items.slice(0, 25).forEach((item) => {
                const movie = item?.movie || {};
                const poster = movie.poster_url || '';
                const title = movie.title || 'Unknown';
                const year = movie.release_year || '';
                const song = item.song || '';
                const artist = item.artist || '';

                const card = document.createElement('div');
                card.className = 'hall-card';

                const img = document.createElement('img');
                img.src = poster;
                img.alt = title;
                img.loading = 'lazy';

                const meta = document.createElement('div');
                meta.className = 'hall-meta';
                meta.innerHTML = `<strong>${escapeHtml(title)}</strong><br>${escapeHtml(year)}<br>${escapeHtml(song)} — ${escapeHtml(artist)}`;

                if (poster) {
                    card.appendChild(img);
                }
                card.appendChild(meta);
                grid.appendChild(card);
            });
        } catch (err) {
            console.error('Error loading Hall of Fame:', err);
            const grid = document.getElementById('hall-grid');
            if (grid) grid.innerHTML = '<p class="hall-subtitle">Could not load saved matches.</p>';
        }
    }

    function escapeHtml(str) {
        if (typeof str !== 'string') return '';
        return str
            .replace(/&/g, '&')
            .replace(/</g, '<')
            .replace(/>/g, '>')
            .replace(/"/g, '"');
    }

    // --- SPA Navigation ---

    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const targetId = link.getAttribute('data-view');
            const target = document.getElementById(targetId);
            switchView(target);
            if (targetId === 'view-hall-of-fame') {
                loadHallOfFame();
            }
        });
    });

    if (logoEl) {
        logoEl.addEventListener('click', () => {
            goHome();
        });
        logoEl.style.cursor = 'pointer';
    }

    // --- TikTok ---
    function abrirTikTok(nomeFilme) {
        if (!nomeFilme) return;
        
        const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
        const query = encodeURIComponent(nomeFilme + " edit");
        
        if (isMobile) {
            window.location.href = "tiktok://search?keyword=" + query;
        } else {
            window.open("https://www.tiktok.com/search?q=" + query, "_blank");
        }
    }

    // --- Results Injection ---
    function injectResults(data) {
        const movie = data && data.movie ? data.movie : {};
        const safeStr = (val) => (val !== null && val !== undefined && typeof val === 'string') ? val : '';
        const safeArr = (val) => Array.isArray(val) ? val : [];

        // Meta
        const song = safeStr(data && data.song);
        const artist = safeStr(data && data.artist);
        const artistStr = artist ? ` - ${artist}` : '';
        const elMeta = document.getElementById('res-search-meta');
        if (elMeta) elMeta.textContent = `'${song}'${artistStr} → detected vibe:`;

        // Vibe Title
        const elVibe = document.getElementById('res-vibe-title');
        if (elVibe) elVibe.textContent = safeStr(movie.vibe_title);

        // Tags
        const tags = safeArr(movie.tags);
        const tagsContainer = document.getElementById('res-vibe-tags');
        if (tagsContainer) {
            tagsContainer.innerHTML = '';
            const colors = ['t-red', 't-gold', 't-blue', 't-green'];
            tags.forEach((tag, index) => {
                const span = document.createElement('span');
                span.className = `tag ${colors[index % colors.length]}`;
                span.textContent = safeStr(tag);
                tagsContainer.appendChild(span);
            });
        }

        // Vibe Report
        const elExplanation = document.getElementById('res-ai-explanation');
        if (elExplanation) elExplanation.innerHTML = safeStr(movie.ai_explanation) || '';

        const elDirector = document.getElementById('res-director');
        if (elDirector) elDirector.textContent = safeStr(movie.director);

        const elRelease = document.getElementById('res-release');
        if (elRelease) elRelease.textContent = safeStr(movie.release_year);

        const elOrigTitle = document.getElementById('res-original-title');
        if (elOrigTitle) elOrigTitle.textContent = safeStr(movie.original_title);
        
        // Poster & Text
        const elPoster = document.getElementById('res-poster');
        if (elPoster) elPoster.src = safeStr(movie.poster_url);

        const elTitle = document.getElementById('res-title');
        if (elTitle) elTitle.textContent = safeStr(movie.title);

        const elSynopsis = document.getElementById('res-synopsis');
        if (elSynopsis) elSynopsis.textContent = safeStr(movie.synopsis);

        // Links
        const elImdb = document.getElementById('res-imdb');
        if (elImdb) elImdb.href = safeStr(movie.imdb_url);

        const elLb = document.getElementById('res-letterboxd');
        if (elLb) elLb.href = safeStr(movie.letterboxd_url);

        // TikTok
        const tiktokLink = document.getElementById('res-tiktok');
        if (tiktokLink) {
            const novoTiktokLink = tiktokLink.cloneNode(true);
            tiktokLink.parentNode.replaceChild(novoTiktokLink, tiktokLink);

            const nomeFilmeTikTok = movie.original_title || movie.title || '';
            novoTiktokLink.addEventListener('click', (e) => {
                e.preventDefault();
                abrirTikTok(nomeFilmeTikTok);
            });
        }

        // Stills
        const stills = safeArr(movie.stills);
        const stillIds = ['res-still-1', 'res-still-2', 'res-still-3'];
        stillIds.forEach((id, index) => {
            const img = document.getElementById(id);
            const polaroid = img ? img.closest('.polaroid') : null;
            if (polaroid) {
                if (stills[index]) {
                    img.src = stills[index];
                    polaroid.style.display = '';
                } else {
                    polaroid.style.display = 'none';
                }
            }
        });

        // Quotes
        const quotes = safeArr(movie.quotes);
        const quoteIds = ['res-quote-1', 'res-quote-2', 'res-quote-3'];
        const movieTitle = safeStr(movie.title);
        quoteIds.forEach((id, index) => {
            const el = document.getElementById(id);
            if (el) {
                const quoteText = quotes[index] ? safeStr(quotes[index]) : '';
                el.textContent = quoteText || movieTitle;
                el.style.display = (quoteText || movieTitle) ? '' : 'none';
            }
        });
    }

    // --- Shared Link Detection (?r=) ---
    // Se a URL contiver ?r=slug, carrega diretamente o resultado compartilhado
    const sharedSlug = getUrlParam('r');
    if (sharedSlug) {
        // Pula a tela inicial e faz fetch GET para buscar o share
        switchView(viewLoading);
        loadingText.textContent = "Loading shared vibe...";

        fetch('/recommend?slug=' + encodeURIComponent(sharedSlug))
            .then(response => {
                if (!response.ok) {
                    throw new Error('Link não encontrado ou expirado.');
                }
                return response.json();
            })
            .then(data => {
                if (data && data.error && data.error.message) {
                    showError(data.error.message);
                } else {
                    injectResults(data);
                    switchView(viewResults);
                }
            })
            .catch(error => {
                console.error('Erro ao carregar link compartilhado:', error);
                showError('Este link não está mais disponível. Tente fazer uma nova busca.');
            });
    }

    // --- Event Listeners ---

    searchForm.addEventListener('submit', (e) => {
        e.preventDefault();
        
        const song = songInput.value.trim();
        const artist = artistInput.value.trim();

        if (!song) return;

        const fetchPromise = fetch('/recommend', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ nome_musica: song, artista: artist })
        })
        .then(response => {
            if (!response.ok) {
                return response.json().then(err => {
                    throw new Error(err.message || `HTTP ${response.status}`);
                });
            }
            return response.json();
        });

        startLoadingSequence(fetchPromise);
    });

    btnSearchAgain.addEventListener('click', goHome);

    if (btnRetry) {
        btnRetry.addEventListener('click', goHome);
    }

    tagButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            songInput.value = e.target.textContent;
            artistInput.value = '';
        });
    });

});
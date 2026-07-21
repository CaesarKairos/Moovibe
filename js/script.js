/**
 * Moovibe - Frontend Logic
 * Handles SPA navigation, loading states, and dynamic content injection.
 * Versão com blindagem defensiva total contra payloads parciais.
 */

document.addEventListener('DOMContentLoaded', () => {
    
    // --- DOM Elements ---
    const searchForm = document.getElementById('search-form');
    const songInput = document.getElementById('song-title');
    const artistInput = document.getElementById('artist-name');
    const btnSearchAgain = document.getElementById('btn-search-again');
    const tagButtons = document.querySelectorAll('.tag-btn');
    
    // Views
    const viewHome = document.getElementById('view-home');
    const viewLoading = document.getElementById('view-loading');
    const viewResults = document.getElementById('view-results');
    const loadingText = document.getElementById('loading-text');

    // Loading strings for cinematic feel
    const loadingMessages = [
        "Listening to the atmosphere...",
        "Reading the lyrics...",
        "Searching beyond genres...",
        "Curating emotions...",
        "Finding a cinematic soul..."
    ];


    // --- Core Functions ---

    function switchView(targetView) {
        document.querySelectorAll('.view-section').forEach(view => {
            view.classList.remove('active');
        });
        targetView.classList.add('active');
        window.scrollTo({ top: 0, behavior: 'smooth' });
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
                injectResults(data);
                switchView(viewResults);
            })
            .catch(error => {
                clearInterval(messageInterval);
                console.error('Erro na requisição:', error);
                switchView(viewHome);
                alert('Falha ao buscar a vibe. Tente novamente.');
            });
    }

    /**
     * Abre o TikTok de forma inteligente.
     */
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

    /**
     * Injeta dados no DOM com blindagem defensiva.
     * Toda propriedade tem fallback seguro: string vazia, array vazio ou null.
     */
    function injectResults(data) {
        // Garante que data.movie existe, mesmo que venha parcial
        const movie = data && data.movie ? data.movie : {};
        const safeStr = (val) => (val !== null && val !== undefined && typeof val === 'string') ? val : '';
        const safeArr = (val) => Array.isArray(val) ? val : [];

        // --- Meta ---
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

        // --- Vibe Report ---
        const elExplanation = document.getElementById('res-ai-explanation');
        if (elExplanation) elExplanation.innerHTML = safeStr(movie.ai_explanation) || '';

        const elDirector = document.getElementById('res-director');
        if (elDirector) elDirector.textContent = safeStr(movie.director);

        const elRelease = document.getElementById('res-release');
        if (elRelease) elRelease.textContent = safeStr(movie.release_year);

        const elOrigTitle = document.getElementById('res-original-title');
        if (elOrigTitle) elOrigTitle.textContent = safeStr(movie.original_title);
        
        // --- Poster & Text ---
        const elPoster = document.getElementById('res-poster');
        if (elPoster) elPoster.src = safeStr(movie.poster_url);

        const elTitle = document.getElementById('res-title');
        if (elTitle) elTitle.textContent = safeStr(movie.title);

        const elSynopsis = document.getElementById('res-synopsis');
        if (elSynopsis) elSynopsis.textContent = safeStr(movie.synopsis);

        // --- Links ---
        const elImdb = document.getElementById('res-imdb');
        if (elImdb) elImdb.href = safeStr(movie.imdb_url);

        const elLb = document.getElementById('res-letterboxd');
        if (elLb) elLb.href = safeStr(movie.letterboxd_url);

        // --- TikTok: event listener inteligente ---
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

        // --- Stills: itera sobre as 3 polaroids, oculta se nao houver imagem ---
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

        // --- Quotes: injeta citacoes, oculta se vazio ---
        const quotes = safeArr(movie.quotes);
        const quoteIds = ['res-quote-1', 'res-quote-2', 'res-quote-3'];
        quoteIds.forEach((id, index) => {
            const el = document.getElementById(id);
            if (el) {
                const quoteText = quotes[index] ? safeStr(quotes[index]) : '';
                el.textContent = quoteText;
                // Oculta o elemento se vazio, exibe se tem conteudo
                el.style.display = quoteText ? '' : 'none';
            }
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
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            return response.json();
        });

        startLoadingSequence(fetchPromise);
    });

    btnSearchAgain.addEventListener('click', () => {
        songInput.value = '';
        artistInput.value = '';
        switchView(viewHome);
    });

    tagButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            songInput.value = e.target.textContent;
            artistInput.value = '';
        });
    });

});
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
        // Hide all views
        document.querySelectorAll('.view-section').forEach(view => {
            view.classList.remove('active');
        });
        // Show target
        targetView.classList.add('active');
        // Scroll to top
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
        }, 800); // Change text every 800ms

        // Await the real fetch promise
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
     * Abre o TikTok de forma inteligente:
     * - Mobile: deep link nativo (tiktok://)
     * - Desktop: URL web em nova aba
     */
    function abrirTikTok(nomeFilme) {
        if (!nomeFilme) return;
        
        const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
        const query = encodeURIComponent(nomeFilme + " edit");
        
        if (isMobile) {
            // Deep link nativo para abrir o app TikTok
            window.location.href = "tiktok://search?keyword=" + query;
        } else {
            // Desktop: abre em nova aba
            window.open("https://www.tiktok.com/search?q=" + query, "_blank");
        }
    }

    function injectResults(data) {
        // Populate Meta
        const artistStr = data.artist ? ` - ${data.artist}` : "";
        document.getElementById('res-search-meta').textContent = `'${data.song}'${artistStr} → detected vibe:`;
        document.getElementById('res-vibe-title').textContent = data.movie.vibe_title;
        
        // Tags
        const tagsContainer = document.getElementById('res-vibe-tags');
        tagsContainer.innerHTML = '';
        const colors = ['t-red', 't-gold', 't-blue', 't-green'];
        data.movie.tags.forEach((tag, index) => {
            const span = document.createElement('span');
            span.className = `tag ${colors[index % colors.length]}`;
            span.textContent = tag;
            tagsContainer.appendChild(span);
        });

        // Vibe Report / Details
        document.getElementById('res-ai-explanation').innerHTML = data.movie.ai_explanation;
        document.getElementById('res-director').textContent = data.movie.director;
        document.getElementById('res-release').textContent = data.movie.release_year;
        document.getElementById('res-original-title').textContent = data.movie.original_title;
        
        // Poster & Text
        document.getElementById('res-poster').src = data.movie.poster_url;
        document.getElementById('res-title').textContent = data.movie.title;
        document.getElementById('res-synopsis').textContent = data.movie.synopsis;

        // Links
        document.getElementById('res-imdb').href = data.movie.imdb_url;
        document.getElementById('res-letterboxd').href = data.movie.letterboxd_url;

        // TikTok: substitui link estático por event listener inteligente
        const tiktokLink = document.getElementById('res-tiktok');
        const novoTiktokLink = tiktokLink.cloneNode(true);
        tiktokLink.parentNode.replaceChild(novoTiktokLink, tiktokLink);
        
        // Salva o nome do filme para usar no clique
        const nomeFilmeParaTikTok = data.movie.title || data.movie.original_title;
        
        novoTiktokLink.addEventListener('click', (e) => {
            e.preventDefault();
            abrirTikTok(nomeFilmeParaTikTok);
        });
        // Stills
        if (data.movie.stills.length >= 3) {
            document.getElementById('res-still-1').src = data.movie.stills[0];
            document.getElementById('res-still-2').src = data.movie.stills[1];
            document.getElementById('res-still-3').src = data.movie.stills[2];
        }
    }

    // --- Event Listeners ---

    searchForm.addEventListener('submit', (e) => {
        e.preventDefault();
        
        // Capture inputs
        const song = songInput.value.trim();
        const artist = artistInput.value.trim();

        if (!song) return;

        // Real fetch to the Cloudflare Pages Function (/recommend)
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

    // Make suggestion buttons populate the input
    tagButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            songInput.value = e.target.textContent;
            artistInput.value = ''; // clear artist to let AI figure it out
        });
    });

});
/**
 * Moovibe - Frontend Logic
 * Handles SPA navigation, loading states, and dynamic content injection.
 */

document.addEventListener('DOMContentLoaded', () => {
    
    // --- i18n Setup ---
    const isPT = navigator.language.toLowerCase().startsWith('pt');
    const lang = isPT ? 'pt' : 'en';

    const i18n = {
        en: {
            hero_eyebrow: '<span class="red-line"></span> THE CINEMA WAS ALWAYS INSIDE THE MUSIC',
            hero_subtitle: '<em>Every song already has a film.</em> <strong>We find it.</strong>',
            label_song: 'SONG TITLE (WRITE CORRECTLY)',
            label_artist: 'ARTIST — OPTIONAL (BUT HELPS A LOT)',
            btn_find: 'FIND MY MOVIE →',
            try_label: 'TRY:',
            loading_initial: 'Listening to the atmosphere...',
            loading_shared: 'Loading shared vibe...',
            search_meta: "'Style' — Taylor Swift → detected vibe:",
            vibe_report: 'VIBE REPORT',
            article_meta: 'CURATOR: MOOVIBE SYSTEM <span id="res-year">2026</span>',
            dir_label: 'DIR:',
            release_label: 'RELEASE:',
            original_title_label: 'ORIGINAL TITLE:',
            link_imdb: 'IMDb',
            link_letterboxd: 'Letterboxd',
            link_tiktok: 'TikTok',
            btn_new_search: '← NEW SEARCH',
            error_title: 'SOMETHING WENT WRONG',
            error_message: "Não foi possível encontrar a vibe dessa música. Tente novamente ou escolha outra faixa.",
            btn_try_again: '← TRY AGAIN',
            hall_of_fame: 'HALL OF FAME',
            how_it_works: 'HOW IT WORKS',
            about: 'ABOUT',
            hall_of_fame_title: 'HALL OF FAME',
            hall_subtitle: 'The greatest music-to-film matches ever discovered.',
            how_it_works_title: 'HOW IT WORKS',
            step1_title: 'INGEST: lyrics + context',
            step1_text: 'We take your song and pull together lyrics and meaning from multiple sources—LRCLIB, Genius, Brave Search, and Wikipedia PT—so the recommendation has real musical context, not just a title match.',
            step2_title: 'ENRICH: songfacts + cover art',
            step2_text: 'We then add real artist-curated facts from Songfacts and fetch the album cover from Apple Music. These extras help the model understand the song’s actual vibe, backstory, and visual identity.',
            step3_title: 'MATCH: AI + TMDb',
            step3_text: 'A strict JSON prompt asks the model to choose one real TMDb film—complete with a poetic justification, vibe title, tags, and lyric-based quotes. If TMDb is missing data, Wikipedia or Brave Search backfills the gaps.',
            step4_title: 'PERSIST + render',
            step4_text: 'The final match is stored in Cloudflare KV history and rendered as poster, stills, quotes, and links. The same logic also runs in the local Python terminal version.',
            about_title: 'ABOUT',
            about_p1: "Este projeto foi criado por um amante de filmes — sem a pretensão de ser crítico ou 'cinéfilo' — que também é obcecado por música e trilhas sonoras. E ele foi feito para pessoas que sentem o mesmo.",
            about_p2: "Sabe quando uma música te faz sentir tanta coisa — como a grandiosidade melancólica de Sign of the Times do Harry Styles — que você queria que ela durasse muito mais? Três minutos raramente são suficientes para processar tudo o que uma faixa pode transmitir. Eu sempre quis estender essa sensação. Já que uma música não pode te abraçar por duas horas seguidas, um filme pode.",
            about_p3: "O Moovibe nasceu dessa minha vontade: criar uma ponte que encontre automaticamente o filme perfeito que carrega exatamente a mesma aura, a mesma cor e a mesma vibe da sua música favorita.",
            about_p4: "Se essa experiência fez você sentir algo legal, encontrou um filme incrível para a sua noite ou simplesmente curtiu a ideia, considere me seguir nas redes sociais ou apoiar o projeto de alguma forma. E se você for desenvolvedor, o código-fonte está aberto no meu GitHub te esperando."
        },
        pt: {
            hero_eyebrow: '<span class="red-line"></span> O CINEMA ESTAVA SEMPRE DENTRO DA MÚSICA',
            hero_subtitle: '<em>Cada música já tem um filme.</em> <strong>Nós encontramos.</strong>',
            label_song: 'TÍTULO DA MÚSICA (ESCREVA CORRETAMENTE)',
            label_artist: 'ARTISTA — OPCIONAL (MAS AJUDA MUITO)',
            btn_find: 'ENCONTRAR MEU FILME →',
            try_label: 'TENTE:',
            loading_initial: 'Escutando a atmosfera...',
            loading_shared: 'Carregando vibe compartilhada...',
            search_meta: "'Style' — Taylor Swift → vibe detectada:",
            vibe_report: 'RELATÓRIO DE VIBE',
            article_meta: 'CURADOR: MOOVIBE SYSTEM <span id="res-year">2026</span>',
            dir_label: 'DIR:',
            release_label: 'LANÇAMENTO:',
            original_title_label: 'TÍTULO ORIGINAL:',
            link_imdb: 'IMDb',
            link_letterboxd: 'Letterboxd',
            link_tiktok: 'TikTok',
            btn_new_search: '← NOVA BUSCA',
            error_title: 'ALGO DEU ERRADO',
            error_message: "Não foi possível encontrar a vibe dessa música. Tente novamente ou escolha outra faixa.",
            btn_try_again: '← TENTAR NOVAMENTE',
            hall_of_fame: 'HALL DA FAMA',
            how_it_works: 'COMO FUNCIONA',
            about: 'SOBRE',
            hall_of_fame_title: 'HALL DA FAMA',
            hall_subtitle: 'As maiores conexões entre música e cinema já descobertas.',
            how_it_works_title: 'COMO FUNCIONA',
            step1_title: 'INGESTAR: letras + contexto',
            step1_text: 'Nós pegamos a sua música e reunimos letras e significado de várias fontes—LRCLIB, Genius, Brave Search e Wikipedia PT—para que a recomendação tenha contexto musical real, não apenas uma coincidência de título.',
            step2_title: 'ENRIQUECER: songfacts + capa do álbum',
            step2_text: 'Depois adicionamos fatos curados pelo próprio artista via Songfacts e buscamos a capa do álbum na Apple Music. Esses extras ajudam o modelo a entender a vibe real, a história e a identidade visual da música.',
            step3_title: 'COMBINAR: IA + TMDb',
            step3_text: 'Um prompt JSON estrito pede para o modelo escolher um filme real do TMDb—com uma justificativa poética, título de vibe, tags e citações baseadas na letra. Se o TMDb estiver faltando dados, Wikipedia ou Brave Search completam as lacunas.',
            step4_title: 'PERSISTIR + renderizar',
            step4_text: 'A combinação final é salva no histórico do Cloudflare KV e renderizada como pôster, stills, citações e links. A mesma lógica também roda na versão terminal Python local.',
            about_title: 'SOBRE',
            about_p1: "Este projeto foi criado por um amante de filmes — sem a pretensão de ser crítico ou 'cinéfilo' — que também é obcecado por música e trilhas sonoras. E ele foi feito para pessoas que sentem o mesmo.",
            about_p2: "Sabe quando uma música te faz sentir tanta coisa — como a grandiosidade melancólica de Sign of the Times do Harry Styles — que você queria que ela durasse muito mais? Três minutos raramente são suficientes para processar tudo o que uma faixa pode transmitir. Eu sempre quis estender essa sensação. Já que uma música não pode te abraçar por duas horas seguidas, um filme pode.",
            about_p3: "O Moovibe nasceu dessa minha vontade: criar uma ponte que encontre automaticamente o filme perfeito que carrega exatamente a mesma aura, a mesma cor e a mesma vibe da sua música favorita.",
            about_p4: "Se essa experiência fez você sentir algo legal, encontrou um filme incrível para a sua noite ou simplesmente curtiu a ideia, considere me seguir nas redes sociais ou apoiar o projeto de alguma forma. E se você for desenvolvedor, o código-fonte está aberto no meu GitHub te esperando."
        }
    };

    function applyLanguage() {
        const dictionary = i18n[lang] || i18n['en'];
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            const value = dictionary[key];
            if (!value) return;
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                if (el.placeholder && !el.hasAttribute('data-i18n-placeholder')) {
                    el.setAttribute('data-i18n-placeholder', 'true');
                    el.placeholder = value;
                }
            } else {
                el.innerHTML = value;
            }
        });
    }

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
    const loadingMessages = lang === 'pt'
        ? [
            "Lendo a letra...",
            "Garimpando o contexto...",
            "Perguntando pra IA...",
            "Escolhendo o filme..."
          ]
        : [
            "Reading the lyrics...",
            "Digging the context...",
            "Asking the AI...",
            "Choosing the movie..."
          ];

    // --- Theme (sessão noturna) ---
    const themeToggle = document.getElementById('theme-toggle');
    const STORAGE_KEY = 'moovibe-theme';

    function getInitialTheme() {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved === 'dark') return 'dark';
        if (saved === 'light') return 'light';
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
        return 'light';
    }

    function applyTheme(theme) {
        if (!themeToggle) return;
        const isDark = theme === 'dark';
        document.body.classList.toggle('theme-dark', isDark);
        themeToggle.textContent = isDark
            ? (lang === 'pt' ? 'SESSÃO DIURNA' : 'DAY SESSION')
            : (lang === 'pt' ? 'SESSÃO NOTURNA' : 'NIGHT SESSION');
    }

    applyTheme(getInitialTheme());
    if (themeToggle) {
        themeToggle.addEventListener('click', () => {
            const current = document.body.classList.contains('theme-dark') ? 'dark' : 'light';
            const next = current === 'dark' ? 'light' : 'dark';
            localStorage.setItem(STORAGE_KEY, next);
            applyTheme(next);
        });
    }

    // --- Randomização leve de rotação (fitas e polaroids) ---
    function aplicarRotacaoAleatoria(container) {
        if (!container) return;
        if (window.matchMedia && window.matchMedia('(max-width: 1100px)').matches) return;
        container.querySelectorAll('.rotate-left, .rotate-right').forEach(el => {
            const current = getComputedStyle(el).transform;
            if (current && current !== 'none') {
                const random = (Math.random() * 4 - 2); // ±2 graus
                const deg = parseFloat(current.match(/rotate\(([-\d.]+)deg\)/)?.[1] || '0');
                el.style.transform = `rotate(${(deg + random).toFixed(2)}deg)`;
            }
        });
    }

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
        }, 1500);

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
                showError(i18n[lang]?.error_message || 'Não foi possível encontrar a vibe dessa música. Tente novamente ou escolha outra faixa.');
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

        grid.innerHTML = '<p class="hall-subtitle">' + (i18n[lang]?.hall_subtitle || 'Loading matches...') + '</p>';

        try {
            const response = await fetch('/recommend', { method: 'GET' });
            if (!response.ok) {
                throw new Error('Failed to load history');
            }
            const items = await response.json();

            if (!Array.isArray(items) || items.length === 0) {
                grid.innerHTML = '<p class="hall-subtitle">' + (i18n[lang]?.hall_subtitle || 'No matches yet. Be the first to discover one.') + '</p>';
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
                const separator = lang === 'pt' ? ' — ' : ' — ';
                meta.innerHTML = `<strong>${escapeHtml(title)}</strong><br>${escapeHtml(year)}<br>${escapeHtml(song)}${separator}${escapeHtml(artist)}`;

                if (poster) {
                    card.appendChild(img);
                }
                card.appendChild(meta);
                aplicarOverlayHall(card, movie);
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

    const hallSubtitle = document.querySelector('#view-hall-of-fame .hall-subtitle');
    if (hallSubtitle) {
        hallSubtitle.textContent = i18n[lang]?.hall_subtitle || hallSubtitle.textContent;
    }

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
        const metaText = lang === 'pt' ? `'${song}'${artistStr} → vibe detectada:` : `'${song}'${artistStr} → detected vibe:`;
        if (elMeta) elMeta.textContent = metaText;

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

        // Aplica rotação aleatória nas polaroids da view de resultados
        const resultsView = document.getElementById('view-results');
        if (resultsView) aplicarRotacaoAleatoria(resultsView);

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

    function aplicarOverlayHall(card, movie) {
        const overlay = document.createElement('div');
        overlay.className = 'hall-overlay';
        const vibe = movie.vibe_title || '';
        const tags = Array.isArray(movie.tags) ? movie.tags : [];
        let html = '';
        if (vibe) html += '<span class="ho-vibe">' + escapeHtml(vibe) + '</span>';
        if (tags.length > 0) {
            html += '<div class="ho-tags">' + tags.map(function(t) { return '<span class="ho-tag">' + escapeHtml(t) + '</span>'; }).join('') + '</div>';
        }
        overlay.innerHTML = html;
        card.appendChild(overlay);
    }

    // --- Shared Link Detection (?r=) ---
    // Se a URL contiver ?r=slug, carrega diretamente o resultado compartilhado
    const sharedSlug = getUrlParam('r');
    if (sharedSlug) {
        // Pula a tela inicial e faz fetch GET para buscar o share
        switchView(viewLoading);
        loadingText.textContent = i18n[lang]?.loading_shared || "Loading shared vibe...";

        fetch('/recommend?slug=' + encodeURIComponent(sharedSlug))
            .then(response => {
                if (!response.ok) {
                    throw new Error(i18n[lang]?.error_message || 'Link não encontrado ou expirado.');
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
                showError(i18n[lang]?.error_message || 'Este link não está mais disponível. Tente fazer uma nova busca.');
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
            body: JSON.stringify({ nome_musica: song, artista: artist, lang: lang })
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

    applyLanguage();

});
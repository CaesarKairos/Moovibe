import { BETA_COPY, LANGUAGES, PAGE_METADATA, detectLanguage, normalizeLanguage, translations } from './i18n/locales.js';
/**
 * Moovibe - Frontend Logic
 * Handles SPA navigation, loading states, and dynamic content injection.
 */

document.addEventListener('DOMContentLoaded', () => {
    let anonymousSession='';
    try { anonymousSession=localStorage.getItem('moovibe.session')||crypto.randomUUID(); localStorage.setItem('moovibe.session',anonymousSession); } catch { anonymousSession=crypto.randomUUID(); }
    const track=(event,extra={})=>{try{return fetch('/analytics',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event,route:location.pathname,language:lang,session_id:anonymousSession,...extra}),keepalive:true}).catch(()=>{});}catch{return Promise.resolve();}};
    
    // --- i18n Setup ---
    let storedLanguage=null;
    try { storedLanguage=localStorage.getItem('moovibe.language'); } catch {}
    let lang = normalizeLanguage(storedLanguage || detectLanguage(navigator.languages || [navigator.language]));

    const i18n = translations;

    // Mapeamento view → URL, título e descrição (SEO)
    const VIEW_ROUTES = {
        'view-home': {
            path: '/',
            meta: 'home'
        },
        'view-about': {
            path: '/about',
            meta: 'about'
        },
        'view-how-it-works': {
            path: '/how-it-works',
            meta: 'how'
        },
        'view-hall-of-fame': {
            path: '/hall-of-fame',
            meta: 'hall'
        }
    };

    function viewToPath(targetView) {
        const rota = VIEW_ROUTES[targetView?.id];
        return rota ? rota.path : null;
    }

    function pathToView(pathname) {
        for (const [viewId, rota] of Object.entries(VIEW_ROUTES)) {
            if (rota.path === pathname) return document.getElementById(viewId);
        }
        return null;
    }

    function atualizarMetaPorView(targetView) {
        const rota = VIEW_ROUTES[targetView?.id];
        if (!rota) return;
        const [title,description]=PAGE_METADATA[lang]?.[rota.meta]||PAGE_METADATA.en[rota.meta];
        document.title = title;
        const metaDesc = document.querySelector('meta[name="description"]');
        if (metaDesc) metaDesc.setAttribute('content', description);
        document.querySelectorAll('meta[property="og:title"],meta[name="twitter:title"]').forEach(meta=>meta.setAttribute('content',title));
        document.querySelectorAll('meta[property="og:description"],meta[name="twitter:description"]').forEach(meta=>meta.setAttribute('content',description));
    }

    function applyLanguage() {
        const dictionary = i18n[lang] || i18n['en'];
        // Sincroniza o atributo lang do <html> com o idioma ativo
        if (document.documentElement) {
            document.documentElement.setAttribute('lang', lang);
        }
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
        const beta=BETA_COPY[lang]||BETA_COPY.en;const badge=document.getElementById('beta-badge'),note=document.getElementById('beta-note');if(badge)badge.innerHTML=beta[0];if(note)note.textContent=beta[1];
        atualizarMetaPorView(document.querySelector('.view-section.active'));
        document.querySelectorAll('.extra-song-input').forEach(input=>{input.placeholder=dictionary.add_song;});
        document.querySelectorAll('.remove-song-btn').forEach(button=>button.setAttribute('aria-label',dictionary.remove_song));
        if(errorMessage&&viewError?.classList.contains('active'))errorMessage.textContent=dictionary.error_message;
    }

    const languagePicker=document.querySelector('.language-picker');
    const languageButton=document.getElementById('language-button');
    const languageMenu=document.getElementById('language-menu');
    function renderLanguageMenu(){
        languageButton.querySelector('.language-code').textContent=lang==='pt-BR'?'PT':lang.split('-')[0].toUpperCase();
        languageMenu.innerHTML=Object.entries(LANGUAGES).map(([code,item])=>`<button type="button" role="option" data-lang="${code}" aria-selected="${code===lang}"><span class="language-mark" aria-hidden="true"></span><span>${item.label}</span><small>${code}</small></button>`).join('');
        languageMenu.querySelectorAll('[role=option]').forEach(option=>option.addEventListener('click',()=>{lang=option.dataset.lang;try{localStorage.setItem('moovibe.language',lang);}catch{}applyLanguage();renderLanguageMenu();closeLanguageMenu(true);}));
    }
    function closeLanguageMenu(restoreFocus=false){languagePicker?.classList.remove('open');languageButton?.setAttribute('aria-expanded','false');if(restoreFocus)languageButton?.focus();}
    languageButton?.addEventListener('click',()=>{const open=languagePicker.classList.toggle('open');languageButton.setAttribute('aria-expanded',String(open));if(open)languageMenu.querySelector('[aria-selected=true]')?.focus();});
    languagePicker?.addEventListener('keydown',event=>{const options=[...languageMenu.querySelectorAll('[role=option]')];const current=options.indexOf(document.activeElement);if(event.key==='Escape'){event.preventDefault();closeLanguageMenu(true);}if(event.key==='ArrowDown'){event.preventDefault();options[(current+1+options.length)%options.length]?.focus();}if(event.key==='ArrowUp'){event.preventDefault();options[(current-1+options.length)%options.length]?.focus();}});
    document.addEventListener('click',event=>{if(languagePicker&&!languagePicker.contains(event.target)){languagePicker.classList.remove('open');languageButton?.setAttribute('aria-expanded','false');}});
    renderLanguageMenu();
    track('page_view');

    // --- DOM Elements ---
    const searchForm = document.getElementById('search-form');
    const songInput = document.getElementById('song-title');
    const songSuggestions = document.getElementById('song-suggestions');
    const songLrclibIdInput = document.getElementById('song-lrclib-id');
    // Estado em memória do artista resolvido (o input #artist-name foi removido
    // na unificação do campo de busca; o artista agora é guardado aqui).
    let artistaResolvido = '';
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
    const btnAddSong = document.getElementById('btn-add-song');
    const extraSongsContainer = document.getElementById('extra-songs-container');
    const MAX_SONGS = 3;
    let extraSongCount = 0;
    let extraSongInputs = [];

    // Loading strings for cinematic feel
    const getLoadingMessages = () => [i18n[lang].loading_initial, i18n[lang].step1_title, i18n[lang].step3_title, i18n[lang].step4_title];
    applyLanguage();

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

    function pararAudio() {
        // Pausa todos os players de áudio dinâmicos dos cards de música
        document.querySelectorAll('.song-card audio').forEach(audio => {
            if (!audio.paused) {
                audio.pause();
                audio.currentTime = 0;
            }
        });
        document.querySelectorAll('.song-card .audio-preview-btn').forEach(btn => {
            btn.classList.remove('playing');
        });
    }

    function switchView(targetView, viaUI = false) {
        if (!targetView) return;
        pararAudio();
        document.querySelectorAll('.view-section').forEach(view => {
            view.classList.remove('active');
        });
        targetView.classList.add('active');
        // SEO: atualiza URL (apenas quando a navegação vem da UI) + título + meta description
        const novaUrl = viewToPath(targetView);
        if (novaUrl !== null) {
            if (viaUI) {
                window.history.pushState(null, '', novaUrl);
            }
            atualizarMetaPorView(targetView);
        }
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
        const loadingMessages = getLoadingMessages();
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
                if (data?.cancelled) {
                    switchView(viewHome);
                } else if (data && data.error && data.error.message) {
                    showError(data.error.message);
                } else {
                    injectResults(data);
                    switchView(viewResults);
                    // Atualiza a URL com o slug para compartilhamento (rota real /share/{slug})
                    if (data && data.share_slug) {
                        window.history.pushState(null, '', '/share/' + data.share_slug);
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
        artistaResolvido = '';
        if (songLrclibIdInput) songLrclibIdInput.value = '';
        if (songSuggestions) {
            songSuggestions.classList.remove('active');
            songSuggestions.innerHTML = '';
        }
        // Remove todos os campos extras
        if (extraSongsContainer) extraSongsContainer.innerHTML = '';
        extraSongCount = 0;
        extraSongInputs = [];
        if (btnAddSong) btnAddSong.disabled = false;
    }

    function addExtraSongField() {
        if (!extraSongsContainer || extraSongCount >= MAX_SONGS - 1) return;
        const row = document.createElement('div');
        row.className = 'extra-song-row';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'extra-song-input';
        input.placeholder = i18n[lang].add_song;
        input.autocomplete = 'off';
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'remove-song-btn';
        removeBtn.setAttribute('aria-label', i18n[lang].remove_song);
        const removeIcon = document.createElement('img');
        removeIcon.src = '/images/x.svg';
        removeIcon.alt = '';
        removeIcon.width = 24;
        removeIcon.height = 24;
        removeIcon.setAttribute('aria-hidden', 'true');
        removeBtn.appendChild(removeIcon);
        removeBtn.addEventListener('click', () => {
            row.remove();
            extraSongCount--;
            extraSongInputs = extraSongInputs.filter(el => el !== input);
            if (btnAddSong) btnAddSong.disabled = false;
        });
        row.appendChild(input);
        row.appendChild(removeBtn);
        extraSongsContainer.appendChild(row);
        extraSongCount++;
        extraSongInputs.push(input);
        if (extraSongCount >= MAX_SONGS - 1 && btnAddSong) btnAddSong.disabled = true;
        // Cria um dropdown de autocomplete para este campo extra
        const dropdown = document.createElement('div');
        dropdown.className = 'autocomplete-dropdown';
        dropdown.setAttribute('role', 'listbox');
        dropdown.setAttribute('aria-label', i18n[lang].suggestions);
        row.appendChild(dropdown);
        // Configura o autocomplete (mesma função de pesquisa do campo principal)
        setupAutocomplete(input, dropdown);
        input.focus();
    }

    if (btnAddSong) {
        btnAddSong.addEventListener('click', addExtraSongField);
    }

    function goHome() {
        resetSearch();
        switchView(viewHome, true);
    }

    // --- Autocomplete de música (LRCLIB) ---
    // Replica a interação de barra de busca de app de streaming: o usuário
    // digita algumas letras e vê sugestões aparecendo embaixo do campo.
    // A fonte é o LRCLIB (proxy /lrclib-search no backend), sem dependência paga.
    // A função setupAutocomplete é reutilizável: funciona no campo principal
    // e também nos campos extras adicionados pelo botão "+".

    function setupAutocomplete(input, dropdown, onSelect) {
        if (!input || !dropdown) return;
        let autocompleteItems = [];
        let autocompleteIndex = -1;
        let autocompleteTimer = null;

        function closeSuggestions() {
            dropdown.classList.remove('active');
            dropdown.innerHTML = '';
            autocompleteItems = [];
            autocompleteIndex = -1;
        }

        function selectSuggestion(item) {
            if (!item) return;
            input.value = item.trackName || '';
            input.dataset.artist=item.artistName||''; input.dataset.lrclibId=String(item.id||''); input.dataset.album=item.albumName||''; input.dataset.duration=String(item.duration||'');
            if (onSelect) onSelect(item);
            closeSuggestions();
        }

        function updateHighlight() {
            const els = dropdown.querySelectorAll('.autocomplete-item');
            els.forEach((el, i) => {
                el.classList.toggle('selected', i === autocompleteIndex);
            });
            if (autocompleteIndex >= 0 && els[autocompleteIndex]) {
                els[autocompleteIndex].scrollIntoView({ block: 'nearest' });
            }
        }

        function renderSuggestions(items) {
            autocompleteItems = items;
            autocompleteIndex = -1;
            dropdown.innerHTML = '';
            if (!items || items.length === 0) {
                // Graceful degradation: se não retornar nada, simplesmente não mostra
                closeSuggestions();
                return;
            }
            items.forEach((item, index) => {
                const div = document.createElement('div');
                div.className = 'autocomplete-item';
                div.setAttribute('role', 'option');
                div.dataset.index = String(index);

                const title = document.createElement('div');
                title.className = 'ac-title';
                title.textContent = item.trackName || '';

                const artist = document.createElement('div');
                artist.className = 'ac-artist';
                artist.textContent = item.artistName || '';

                div.appendChild(title);
                div.appendChild(artist);
                div.addEventListener('click', () => selectSuggestion(item));
                div.addEventListener('mousemove', () => {
                    autocompleteIndex = index;
                    updateHighlight();
                });
                dropdown.appendChild(div);
            });
            dropdown.classList.add('active');
        }

        async function fetchSuggestions(termo) {
            try {
                const resp = await fetch('/lrclib-search?q=' + encodeURIComponent(termo));
                if (!resp.ok) {
                    closeSuggestions();
                    return;
                }
                const data = await resp.json();
                const items = Array.isArray(data.items) ? data.items : [];
                renderSuggestions(items);
            } catch (err) {
                // Graceful degradation: se falhar, o campo funciona como digitação livre normal
                closeSuggestions();
            }
        }

        input.addEventListener('input', () => {
            const termo = input.value.trim();
            closeSuggestions();
            // Só dispara a partir de 2 caracteres, pra não bombardear o endpoint
            if (termo.length < 2) return;
            clearTimeout(autocompleteTimer);
            autocompleteTimer = setTimeout(() => {
                if (!viewHome.classList.contains('active')) return;
                fetchSuggestions(termo);
            }, 350);
        });

        input.addEventListener('keydown', (e) => {
            if (!dropdown.classList.contains('active')) return;
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                autocompleteIndex = Math.min(autocompleteIndex + 1, autocompleteItems.length - 1);
                updateHighlight();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                autocompleteIndex = Math.max(autocompleteIndex - 1, -1);
                updateHighlight();
            } else if (e.key === 'Enter') {
                if (autocompleteIndex >= 0 && autocompleteItems[autocompleteIndex]) {
                    e.preventDefault();
                    selectSuggestion(autocompleteItems[autocompleteIndex]);
                }
            } else if (e.key === 'Escape') {
                closeSuggestions();
            }
        });

        // Fecha o dropdown ao clicar fora
        document.addEventListener('click', (e) => {
            const group = input.closest('.autocomplete-group') || input.parentElement;
            if (group && group.contains(e.target)) return;
            closeSuggestions();
        });

        return { closeSuggestions };
    }

    // Configura o autocomplete do campo principal
    if (songInput && songSuggestions) {
        setupAutocomplete(songInput, songSuggestions, (item) => {
            artistaResolvido = item.artistName || '';
            if (songLrclibIdInput) songLrclibIdInput.value = String(item.id || '');
        });
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
                const separator = ' — ';
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
            switchView(target, true);
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
        const metaText = `'${song}'${artistStr} → ${i18n[lang].search_meta}`;
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

        // Songs List (múltiplas músicas: principal + extras)
        const songsList = document.getElementById('res-songs-list');
        if (songsList) {
            songsList.innerHTML = '';
            const songs = safeArr(data && data.songs);
            const songsToRender = songs.length > 0 ? songs : [{ title: song, artist: artist, cover_url: movie.cover_url, audio_preview_url: movie.audio_preview_url }];
            songsToRender.forEach((s, index) => {
                const card = document.createElement('div');
                card.className = 'song-card';
                const cover = document.createElement('img');
                cover.className = 'song-card-cover';
                cover.alt = '';
                const coverUrl = safeStr(s.cover_url);
                if (coverUrl) {
                    cover.src = coverUrl;
                } else {
                    cover.style.display = 'none';
                }
                const info = document.createElement('div');
                info.className = 'song-card-info';
                const label = document.createElement('p');
                label.className = 'song-card-label';
                label.textContent = i18n[lang]?.song_card_label || 'THE SONG';
                const titleEl = document.createElement('p');
                titleEl.className = 'song-card-title';
                titleEl.textContent = safeStr(s.title) || song;
                const artistEl = document.createElement('p');
                artistEl.className = 'song-card-artist';
                artistEl.textContent = safeStr(s.artist);
                artistEl.style.display = safeStr(s.artist) ? '' : 'none';
                info.appendChild(label);
                info.appendChild(titleEl);
                info.appendChild(artistEl);
                card.appendChild(cover);
                card.appendChild(info);
                const audioUrl = safeStr(s.audio_preview_url);
                if (audioUrl) {
                    const audio = document.createElement('audio');
                    audio.preload = 'none';
                    audio.src = audioUrl;
                    const btn = document.createElement('button');
                    btn.className = 'audio-preview-btn';
                    btn.setAttribute('aria-label', i18n[lang].preview);
                    const playIcon = document.createElement('span');
                    playIcon.className = 'play-icon';
                    playIcon.setAttribute('aria-hidden', 'true');
                    const btnLabel = document.createElement('span');
                    btnLabel.className = 'audio-btn-label';
                    btnLabel.textContent = i18n[lang].preview;
                    btn.appendChild(playIcon);
                    btn.appendChild(btnLabel);
                    btn.addEventListener('click', () => {
                        if (audio.paused) {
                            audio.play().then(() => {
                                btn.classList.add('playing');
                            }).catch(err => {
                                console.error('Falha ao reproduzir prévia:', err);
                            });
                        } else {
                            audio.pause();
                            btn.classList.remove('playing');
                        }
                    });
                    audio.addEventListener('ended', () => {
                        btn.classList.remove('playing');
                    });
                    card.appendChild(audio);
                    card.appendChild(btn);
                }
                songsList.appendChild(card);
            });
        }

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

        const elTmdb = document.getElementById('res-tmdb');
        if (elTmdb) {
            const tmdbUrl = safeStr(movie.tmdb_url);
            if (tmdbUrl) {
                elTmdb.href = tmdbUrl;
                elTmdb.style.display = '';
            } else {
                elTmdb.style.display = 'none';
            }
        }

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

    // --- Detecção de rota inicial ---
    // 1) Links compartilhados agora usam /share/{slug} (rota real, não query param)
    const sharedMatch = window.location.pathname.match(/^\/share\/([^/]+)\/?$/);
    if (sharedMatch) {
        const sharedSlug = decodeURIComponent(sharedMatch[1]);
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
    } else {
        // 2) Acesso direto a /about, /how-it-works ou /hall-of-fame (F5/link direto)
        const viewInicial = pathToView(window.location.pathname);
        if (viewInicial) {
            switchView(viewInicial, false);
        }
    }

    // --- Event Listeners ---

    // Tenta extrair artista do texto digitado livremente usando separadores comuns.
    // Último recurso quando o LRCLIB não retorna nada.
    function extrairArtistaDoTexto(texto) {
        if (!texto) return { musica: texto, artista: '' };
        // Separa por " - ", " – ", " by ", " de " (case-insensitive)
        const separadores = [/\s+-\s+/, /\s+–\s+/, /\s+by\s+/i, /\s+de\s+/i];
        for (const sep of separadores) {
            const partes = texto.split(sep);
            if (partes.length >= 2) {
                const musica = partes[0].trim();
                const artista = partes.slice(1).join(' - ').trim();
                if (musica && artista) return { musica, artista };
            }
        }
        return { musica: texto, artista: '' };
    }

    // Resolve o artista via /lrclib-search quando o usuário digitou livremente
    // e enviou sem escolher uma sugestão do autocomplete (lrclib_id vazio).
    async function resolverArtistaViaLrclib(song) {
        try {
            const resp = await fetch('/lrclib-search?q=' + encodeURIComponent(song));
            if (!resp.ok) return null;
            const data = await resp.json();
            const items = Array.isArray(data.items) ? data.items : [];
            if (items.length > 0) {
                const primeiro = items[0];
                console.log('[LRCLIB-RESOLVE] Sugestão encontrada:', primeiro.trackName, '-', primeiro.artistName);
                return {
                    trackName: primeiro.trackName || song,
                    artistName: primeiro.artistName || '',
                    id: primeiro.id || ''
                };
            }
        } catch (err) {
            console.error('[LRCLIB-RESOLVE] Erro na busca:', err);
        }
        return null;
    }

    searchForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        track('recommend_started');
        
        let song = songInput.value.trim();
        if (!song) return;

        // Se o usuário digitou livremente (sem escolher sugestão), tenta resolver
        // o artista via LRCLIB antes de montar o payload do /recommend.
        const lrclibIdAtual = songLrclibIdInput ? songLrclibIdInput.value : '';
        if (!lrclibIdAtual) {
            const resolvido = await resolverArtistaViaLrclib(song);
            if (resolvido) {
                song = resolvido.trackName || song;
                artistaResolvido = resolvido.artistName || '';
                if (songLrclibIdInput) songLrclibIdInput.value = String(resolvido.id || '');
                console.log('[LRCLIB-RESOLVE] Artista preenchido automaticamente:', artistaResolvido);
            } else {
                // Último recurso: tenta dividir o texto digitado por separadores comuns
                const { musica, artista } = extrairArtistaDoTexto(song);
                song = musica;
                artistaResolvido = artista;
                if (artista) console.log('[LRCLIB-RESOLVE] Artista extraído do texto:', artista);
            }
        }

        const artist = artistaResolvido;

        // Agrupa as músicas extras (até 3 no total)
        const extraSongs = [];
        if (extraSongInputs) {
            for (const input of extraSongInputs) {
                const val = input.value.trim();
                if (val) extraSongs.push({title:val,artist:input.dataset.artist||'',lrclib_id:input.dataset.lrclibId||null,album:input.dataset.album||null,duration:Number(input.dataset.duration)||null});
            }
        }

        const payload={
                nome_musica: song,
                artista: artist,
                lang: lang,
                lrclib_id: songLrclibIdInput ? songLrclibIdInput.value : '',
                album:songInput.dataset.album||null,
                duration:Number(songInput.dataset.duration)||null,
                musicas_extras: extraSongs
            };
        async function requestRecommendation(body) {
          const response=await fetch('/recommend', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
          });
          const data=await response.json();
          if(response.status===422&&data.error?.code==='LYRICS_REQUIRED'){
            track('lyrics_required');
            const dialog=document.getElementById('lyrics-dialog'),fields=document.getElementById('lyrics-fields');
            fields.innerHTML=data.error.missing_songs.map((missing,index)=>`<label>${missing.title} — ${missing.artist||''}<textarea required minlength="80" maxlength="20000" data-song-key="${missing.song_key.replace(/"/g,'&quot;')}"></textarea></label>`).join('');
            const accepted=await new Promise(resolve=>{dialog.addEventListener('close',()=>resolve(dialog.returnValue==='default'),{once:true});dialog.showModal();});
            if(!accepted){track('lyrics_cancelled');return {cancelled:true};}
            body.user_lyrics=Object.fromEntries([...fields.querySelectorAll('textarea')].map(x=>[x.dataset.songKey,x.value])); track('lyrics_submitted');
            return requestRecommendation(body);
          }
          if(!response.ok)throw new Error(data.error?.message||`HTTP ${response.status}`);
          track('recommend_success'); return data;
        }
        const fetchPromise=requestRecommendation(payload);

        startLoadingSequence(fetchPromise);
    });

    btnSearchAgain.addEventListener('click', goHome);

    if (btnRetry) {
        btnRetry.addEventListener('click', goHome);
    }

    tagButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            songInput.value = e.target.textContent;
            artistaResolvido = '';
            if (songLrclibIdInput) songLrclibIdInput.value = '';
            if (songSuggestions) {
                songSuggestions.classList.remove('active');
                songSuggestions.innerHTML = '';
            }
        });
    });

    // Botões voltar/avançar do navegador entre as views mapeadas
    window.addEventListener('popstate', () => {
        const viewAlvo = pathToView(window.location.pathname);
        if (viewAlvo) {
            switchView(viewAlvo, false);
        } else if (window.location.pathname === '/') {
            switchView(viewHome, false);
        }
    });

    applyLanguage();

});

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

    // --- Mock Backend Data ---
    // In production, this would be fetched from your OpenRouter/TMDb backend route.
    const mockApiResponse = {
        song: "Bohemian Rhapsody",
        artist: "Queen",
        movie: {
            title: "Magnolia",
            original_title: "Magnolia",
            release_year: "1999",
            director: "Paul Thomas Anderson",
            synopsis: "An epic mosaic of interrelated characters in search of love, forgiveness, and meaning in the San Fernando Valley. A cinematic crescendo.",
            poster_url: "https://image.tmdb.org/t/p/w600_and_h900_bestv2/uqN2csO2Lz2R9O31O8TETLAnNto.jpg",
            stills: [
                "https://image.tmdb.org/t/p/w780/5NEM4f3XQ1k5R14iFk5Gk1BqAEE.jpg",
                "https://image.tmdb.org/t/p/w780/6x8Z52w0F2iU9J2wH7M1L4R5v0V.jpg",
                "https://image.tmdb.org/t/p/w780/7H2zQ8O6oG4M2vYwQ5M8B6pE0gL.jpg"
            ],
            ai_explanation: "<p>Both the song and the film are sprawling, operatic tapestries of human emotion. They defy traditional structural conventions, opting instead for a cascading series of crescendos.</p><p>Just as 'Bohemian Rhapsody' moves from a cappella to ballad, to opera, to hard rock, <em>Magnolia</em> sweeps through varying states of grief, regret, and sudden, miraculous catharsis. The feeling is one of overwhelming, chaotic grandeur that somehow resolves perfectly.</p>",
            vibe_title: "OPERATIC CHAOS",
            tags: ["GRANDIOSE", "TRAGICOMIC", "CATHARTIC", "MOSAIC"],
            imdb_url: "https://www.imdb.com/title/tt0175880/",
            letterboxd_url: "https://letterboxd.com/film/magnolia/",
            tiktok_url: "#"
        }
    };

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

    function startLoadingSequence(onComplete) {
        switchView(viewLoading);
        
        let messageIndex = 0;
        loadingText.textContent = loadingMessages[0];
        
        const messageInterval = setInterval(() => {
            messageIndex++;
            if (messageIndex < loadingMessages.length) {
                loadingText.textContent = loadingMessages[messageIndex];
            }
        }, 800); // Change text every 800ms

        // Simulate network request delay (3 seconds)
        setTimeout(() => {
            clearInterval(messageInterval);
            onComplete();
        }, 3500);
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

        // Update mock data for demonstration
        mockApiResponse.song = song;
        mockApiResponse.artist = artist;

        startLoadingSequence(() => {
            injectResults(mockApiResponse);
            switchView(viewResults);
        });
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
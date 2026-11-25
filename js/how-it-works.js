import { HOW_COPY } from './i18n/how-it-works.js';
import { diagrams } from './how-it-works-art.js';

const technologies = [
    ['Spotify', 'LRCLIB'],
    ['LRCLIB', 'Genius', 'ReccoBeats', 'Gemini'],
    ['Gemini Embeddings', 'Cloudflare Vectorize', 'Cloudflare D1'],
    ['Moovibe'],
    ['Gemini', 'Cloudflare KV'],
];
const catalogTechnologies = ['TMDb', 'Groq', 'Gemini Embeddings', 'Cloudflare D1', 'Cloudflare Vectorize', 'Cloudflare Workers', 'Cloudflare Queues'];
// The regression test compares these public labels with the ranking implementation.
export const HOW_WEIGHTS = [50, 35, 10, 5];
export const howDescription = language => (HOW_COPY[language] || HOW_COPY.en)[0];

function create(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text) el.textContent = text;
    return el;
}

function chips(names) {
    const list = create('ul', 'how-technologies');
    list.append(...names.map(name => create('li', '', name)));
    return list;
}

function scoreBars(labels, language) {
    const list = create('ul', 'how-weights');
    const percent = new Intl.NumberFormat(language, {style:'percent'});
    for (const [index, weight] of HOW_WEIGHTS.entries()) {
        const row = create('li');
        const bar = create('span', 'how-weight-bar');
        bar.style.setProperty('--weight', `${weight}%`);
        bar.setAttribute('aria-hidden','true');
        row.append(create('span','',labels[index]), create('strong','',percent.format(weight/100)), bar);
        list.append(row);
    }
    return list;
}

export function renderHowItWorks(language) {
    const root = document.getElementById('how-content');
    if (!root || root.dataset.language === language) return;
    const expanded = [...root.querySelectorAll('details')].map(detail => detail.open);
    const focused = [...root.querySelectorAll('summary')].indexOf(document.activeElement);
    root.dataset.language = language;
    const [intro, detailsLabel, steps, catalogTitle, catalogCopy, flow, scoreLabels] = HOW_COPY[language] || HOW_COPY.en;
    const heading = create('header', 'how-heading');
    heading.append(document.getElementById('how-title'), create('p','',intro));
    const list = create('ol', 'how-steps');
    for (const [index, [title, description, detail, caption]] of steps.entries()) {
        const entry = create('li', 'how-step');
        const number = create('span', 'how-number', String(index+1).padStart(2,'0'));
        number.setAttribute('aria-hidden','true');
        const copy = create('div', 'how-step-copy');
        const details = create('details');
        details.open = expanded[index] || false;
        details.append(create('summary','',detailsLabel), create('p','',detail));
        copy.append(create('h3','',title), create('p','',description), chips(technologies[index]), details);
        const figure = create('figure', 'how-diagram');
        if (index === 3) figure.append(scoreBars(scoreLabels, language));
        else {
            const art = create('div','how-art');
            art.innerHTML = diagrams[index]; // Static illustrations shipped with this module.
            figure.append(art);
        }
        figure.append(create('figcaption','',caption));
        entry.append(number, copy, figure);
        list.append(entry);
    }
    const catalog = create('section', 'how-catalog');
    const catalogContent = create('div');
    const pipeline = create('ol', 'how-pipeline');
    pipeline.append(...['TMDb', ...flow].map(label => create('li','',label)));
    catalogContent.append(create('p','',catalogCopy),pipeline,chips(catalogTechnologies));
    catalog.append(create('h3','',catalogTitle),catalogContent);
    root.replaceChildren(heading,list,catalog);
    if (focused >= 0) root.querySelectorAll('summary')[focused]?.focus({preventScroll:true});
}

export const LANGUAGES = Object.freeze({
  'pt-BR': { label: 'Português (Brasil)', aiName: 'Brazilian Portuguese', intl: 'pt-BR' },
  en: { label: 'English', aiName: 'English', intl: 'en' },
  'zh-CN': { label: '简体中文', aiName: 'Simplified Chinese', intl: 'zh-CN' },
  ru: { label: 'Русский', aiName: 'Russian', intl: 'ru' },
  es: { label: 'Español', aiName: 'international Spanish', intl: 'es' },
  de: { label: 'Deutsch', aiName: 'German', intl: 'de' },
  fr: { label: 'Français', aiName: 'French', intl: 'fr' },
  ja: { label: '日本語', aiName: 'Japanese', intl: 'ja' }
});

export const DEFAULT_LANGUAGE = 'en';
export function normalizeLanguage(value) {
  const raw=String(value||'').trim();
  if (LANGUAGES[raw]) return raw;
  const lower=raw.toLowerCase();
  if(lower.startsWith('pt')) return 'pt-BR';
  if(lower==='zh-cn'||lower==='zh-sg'||lower.startsWith('zh-hans')) return 'zh-CN';
  for(const code of ['ru','es','de','fr','ja']) if(lower===code||lower.startsWith(`${code}-`)) return code;
  return DEFAULT_LANGUAGE;
}
export function detectLanguage(languages=[]) {
  for(const value of languages) { const code=normalizeLanguage(value); if(code!==DEFAULT_LANGUAGE||String(value).toLowerCase().startsWith('en')) return code; }
  return DEFAULT_LANGUAGE;
}
export function getLanguageConfig(value) { const code=normalizeLanguage(value); return { code, ...LANGUAGES[code] }; }


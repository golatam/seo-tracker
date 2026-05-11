/**
 * SEO Tracking — Configuration
 *
 * Firmalo.io — LATAM PDF signing tool
 * Google only (no Yandex needed for LATAM market)
 */

/** Site domain */
export const SITE_URL = 'https://firmalo.io';

/** Regions */
export const REGIONS = [
  { id: 'google-latam', engine: 'google', label: 'Google — LATAM' },
];

/** Default search engine */
export const DEFAULT_ENGINE = 'google';

/**
 * CSV column mapping (for manual imports from Semrush, Ahrefs, etc.)
 */
export const CSV_COLUMNS = {
  keyword: 'Keyword',
  url: 'URL',
  position: 'Position',
  volume: 'Volume',
  engine: 'Engine',
  difficulty: 'Difficulty',
};

export const CSV_COLUMN_ALIASES = {
  keyword: ['Keyword', 'Query', 'Palabra clave', 'Palavra-chave', 'Запрос'],
  url: ['URL', 'Landing Page', 'Page', 'Страница'],
  position: ['Position', 'Pos', 'Google', 'Позиция'],
  volume: ['Volume', 'Search Volume', 'Volumen', 'Частотность'],
  engine: ['Engine', 'Search Engine', 'SE'],
  difficulty: ['Difficulty', 'KD', 'Competition'],
};

export const CSV_DELIMITERS = [';', ',', '\t'];

/** Noise threshold: changes <= N positions are insignificant */
export const NOISE_THRESHOLD = 2;

/** Alert threshold: position drop >= N */
export const ALERT_DECLINE_THRESHOLD = 5;

/** Alert threshold: dropping out of TOP-N */
export const ALERT_TOP_THRESHOLD = 50;

/**
 * Notification channels.
 * CLI args (--no-telegram, --no-slack) take priority.
 */
export const NOTIFICATIONS = {
  telegram: false,
  slack: true,
};

/** Snapshots directory */
export const SNAPSHOTS_DIR = new URL('./snapshots/', import.meta.url).pathname;

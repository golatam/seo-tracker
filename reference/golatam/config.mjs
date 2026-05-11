/**
 * SEO Tracking — Configuration
 *
 * Настройки системы отслеживания позиций.
 * Редактируйте этот файл под свои нужды.
 */

/** Домен сайта */
export const SITE_URL = 'https://golatam.group';

/** Регионы для отслеживания */
export const REGIONS = [
  { id: 'google-ru', engine: 'google', label: 'Google — Россия' },
  { id: 'yandex-msk', engine: 'yandex', label: 'Яндекс — Москва' },
];

/** Дефолтная поисковая система, если не указана в CSV */
export const DEFAULT_ENGINE = 'google';

/**
 * Маппинг колонок CSV.
 *
 * Укажите названия колонок из вашего CSV-файла.
 * Поддерживаются экспорты из: Topvisor, Serpstat, Keys.so, ручные таблицы.
 *
 * Если колонка отсутствует, оставьте undefined — скрипт пропустит.
 */
export const CSV_COLUMNS = {
  keyword: 'Запрос',
  url: 'URL',
  position: 'Позиция',
  volume: 'Частотность',
  engine: 'Поисковик',
  difficulty: 'Конкурентность',
};

/**
 * Альтернативные названия колонок (для автодетекта формата).
 * Скрипт попробует каждый вариант по очереди.
 */
export const CSV_COLUMN_ALIASES = {
  keyword: ['Запрос', 'Ключевое слово', 'Keyword', 'Query', 'Фраза'],
  url: ['URL', 'Страница', 'Landing Page', 'Target URL', 'Ссылка'],
  position: ['Позиция', 'Position', 'Pos', 'Google', 'Yandex', 'Google (Москва)', 'Яндекс (Москва)'],
  volume: ['Частотность', 'Volume', 'Search Volume', 'Частота', 'Показы'],
  engine: ['Поисковик', 'Search Engine', 'Engine', 'SE'],
  difficulty: ['Конкурентность', 'Difficulty', 'KD', 'Competition'],
};

/** Разделитель CSV (автоопределение: запятая, точка с запятой, таб) */
export const CSV_DELIMITERS = [';', ',', '\t'];

/** Порог шума: изменения ≤ N позиций считаются незначительными */
export const NOISE_THRESHOLD = 2;

/** Порог для алертов: падение позиции на N и более */
export const ALERT_DECLINE_THRESHOLD = 5;

/** Порог для алертов: выход из ТОП-N */
export const ALERT_TOP_THRESHOLD = 50;

/**
 * Каналы уведомлений.
 * Включите/отключите каждый канал здесь. CLI-аргументы (--no-telegram, --no-slack) имеют приоритет.
 */
export const NOTIFICATIONS = {
  telegram: false,  // временно отключён — включить обратно: true
  slack: true,
};

/** Директория для снэпшотов */
export const SNAPSHOTS_DIR = new URL('./snapshots/', import.meta.url).pathname;

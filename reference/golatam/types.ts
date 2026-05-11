/**
 * SEO Position Tracking System — Type Definitions
 *
 * Типы для системы отслеживания позиций сайта golatam.group
 * в поисковых системах Google и Яндекс.
 */

// ─── Поисковые системы и регионы ─────────────────────────────────────

export type SearchEngine = 'google' | 'yandex';

export interface SearchRegion {
  /** Код региона (google-ru, yandex-msk, yandex-spb) */
  id: string;
  /** Поисковая система */
  engine: SearchEngine;
  /** Человекочитаемое название */
  label: string;
  /** Код региона в сервисе трекинга (если есть) */
  serviceRegionId?: string;
}

// ─── Семантическое ядро ──────────────────────────────────────────────

export type KeywordPriority = 'high' | 'medium' | 'low';
export type PageCategory =
  | 'main'
  | 'country'
  | 'service'
  | 'service-sub'
  | 'blog'
  | 'news'
  | 'audience'
  | 'info';

export interface Keyword {
  /** Ключевая фраза */
  keyword: string;
  /** В каких поисковиках отслеживать */
  engines: SearchEngine[];
  /** Частотность (wordstat / Google KP) */
  volume?: number;
  /** Конкурентность 0–100 */
  difficulty?: number;
  /** Приоритет */
  priority: KeywordPriority;
  /** Активно отслеживается (попадает в снэпшоты и отчёты) */
  tracked?: boolean;
  /** Целевая позиция (к которой стремимся) */
  targetPosition?: number;
  /** Тип запроса: информационный, коммерческий, навигационный */
  intent?: 'informational' | 'commercial' | 'navigational' | 'transactional';
}

export interface PageKeywords {
  /** URL страницы относительно корня (e.g. "/strana/biznes-v-meksike/") */
  url: string;
  /** Заголовок страницы (для отчётов) */
  title: string;
  /** Категория страницы */
  category: PageCategory;
  /** Ключевые слова для этой страницы */
  keywords: Keyword[];
}

/** Всё семантическое ядро сайта */
export type SemanticCore = PageKeywords[];

// ─── Снэпшоты позиций ───────────────────────────────────────────────

export interface PositionEntry {
  /** Ключевая фраза */
  keyword: string;
  /** URL страницы */
  url: string;
  /** Поисковая система */
  engine: SearchEngine;
  /** Позиция (null = не в ТОП-100) */
  position: number | null;
  /** URL, найденный в выдаче (может отличаться от целевого) */
  foundUrl?: string;
}

export interface PositionSnapshot {
  /** Дата снэпшота (ISO: "2026-02-19") */
  date: string;
  /** Источник данных */
  source: 'manual' | 'csv-import' | 'topvisor' | 'serpstat' | 'keys-so';
  /** Комментарий (e.g. "после миграции на Astro") */
  comment?: string;
  /** Записи позиций */
  entries: PositionEntry[];
}

// ─── Отчёты ──────────────────────────────────────────────────────────

export interface PositionChange {
  keyword: string;
  url: string;
  engine: SearchEngine;
  previousPosition: number | null;
  currentPosition: number | null;
  /** Изменение (отрицательное = улучшение) */
  change: number | null;
  priority: KeywordPriority;
}

export interface PositionReport {
  /** Дата текущего снэпшота */
  currentDate: string;
  /** Дата предыдущего снэпшота */
  previousDate: string;
  /** Общая статистика */
  summary: {
    totalKeywords: number;
    improved: number;
    declined: number;
    unchanged: number;
    newInTop: number;
    droppedFromTop: number;
    avgPosition: number;
    prevAvgPosition: number;
  };
  /** Детали по каждому ключу */
  changes: PositionChange[];
}

// ─── Конфигурация CSV-импорта ────────────────────────────────────────

export interface CsvColumnMapping {
  /** Название колонки с ключевым словом */
  keyword: string;
  /** Название колонки с URL страницы */
  url?: string;
  /** Название колонки с позицией */
  position?: string;
  /** Название колонки с частотностью */
  volume?: string;
  /** Название колонки с поисковой системой */
  engine?: string;
  /** Название колонки с конкурентностью */
  difficulty?: string;
}

import { en } from "./en";
import { ko } from "./ko";

/**
 * Desktop 표시 계층 다국어(v0.2.0 P0-3 PR B). Desktop만 번역한다. CLI 출력·Core 문장·오류 코드·schema·Plan digest는 그대로다.
 * - 언어: 저장된 사용자 선택 > OS 언어(ko 계열이면 한국어) > English.
 * - 번역 값은 텍스트다. 화면은 textContent로만 넣는다(HTML로 해석하지 않는다). 보간 값도 텍스트로만 들어간다.
 * - ko 카탈로그는 en의 모든 key를 가져야 한다(타입으로 강제, 테스트로 placeholder까지 비교).
 */
export const LOCALES = ["en", "ko"] as const;
export type Locale = (typeof LOCALES)[number];
export type MessageKey = keyof typeof en;
export type Params = Readonly<Record<string, string | number>>;

const CATALOGS: Readonly<Record<Locale, Readonly<Record<MessageKey, string>>>> = { en, ko };

export const isLocale = (value: unknown): value is Locale => value === "en" || value === "ko";

/** 저장값이 유효하면 그것, 아니면 OS 언어 목록의 첫 항목이 ko 계열(ko, ko-KR, ko_KR …)일 때 한국어, 그 밖에는 English. */
export function resolveLocale(input: { stored: unknown; system: readonly string[] }): Locale {
  if (isLocale(input.stored)) return input.stored;
  const first = input.system.find((s) => typeof s === "string" && s.trim() !== "");
  return first !== undefined && /^ko(?:$|[-_])/iu.test(first.trim()) ? "ko" : "en";
}

/** key의 번역. {name} 자리에 params 값을 텍스트로 넣는다. 없는 key는 en, 그래도 없으면 key 자체(누락은 테스트가 잡는다). */
export function translate(locale: Locale, key: string, params?: Params): string {
  const raw = (CATALOGS[locale] as Record<string, string>)[key] ?? (en as Record<string, string>)[key] ?? key;
  if (params === undefined) return raw;
  return raw.replace(/\{([A-Za-z0-9_]+)\}/gu, (whole, name: string) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole));
}

export const catalog = (locale: Locale): Readonly<Record<MessageKey, string>> => CATALOGS[locale];

let current: Locale = "en";
/** main 프로세스가 시작할 때와 사용자가 언어를 바꿀 때 정한다. */
export const setDesktopLocale = (locale: Locale): void => void (current = locale);
export const getDesktopLocale = (): Locale => current;
/** 현재 Desktop 언어로 번역한다(main 프로세스 화면 데이터·네이티브 대화상자용). */
export const tr = (key: MessageKey, params?: Params): string => translate(current, key, params);

const intlTag = (locale: Locale) => (locale === "ko" ? "ko-KR" : "en-US");
/** ISO 시각 → 지역 표기(날짜·시간). 잘못된 값은 그대로 돌려준다. */
export function formatDateTime(iso: string, locale: Locale = current): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat(intlTag(locale), { dateStyle: "medium", timeStyle: "short" }).format(d);
}
/** ISO 날짜 → 지역 표기(날짜만). */
export function formatDate(iso: string, locale: Locale = current): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat(intlTag(locale), { dateStyle: "medium" }).format(d);
}
export const formatNumber = (n: number, locale: Locale = current): string => new Intl.NumberFormat(intlTag(locale)).format(n);


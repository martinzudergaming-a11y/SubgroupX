import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { normalizeLanguage } from '../../files/languages';

type Highlighter = Awaited<ReturnType<typeof createHighlighterCore>>;

let highlighterPromise: Promise<Highlighter> | null = null;
let highlighterInstance: Highlighter | null = null;
const bootstrapLanguages = new Set<SupportedLanguage>();

const LANGUAGE_LOADERS = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  dart: () => import('shiki/langs/dart.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  regexp: () => import('shiki/langs/regexp.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  glsl: () => import('shiki/langs/glsl.mjs'),
  haml: () => import('shiki/langs/haml.mjs'),
  'cpp-macro': () => import('shiki/langs/cpp.mjs'),
} as const;

type SupportedLanguage = keyof typeof LANGUAGE_LOADERS;
const languageLoads = new Map<SupportedLanguage, Promise<void>>();

export const SHIKI_LIGHT_THEME = 'vitesse-light';
export const SHIKI_DARK_THEME = 'vitesse-dark';

const THEMES = { light: SHIKI_LIGHT_THEME, dark: SHIKI_DARK_THEME };

export interface HighlightSegment {
  code: string;
  lang: string;
}

type Hl = Awaited<ReturnType<typeof getHighlighter>>;
function highlightOne(h: Hl, code: string, lang: string): string {
  const safeLang = h.getLoadedLanguages().includes(lang) ? lang : 'plaintext';
  return h.codeToHtml(code, { lang: safeLang, themes: THEMES });
}

function isSupportedLanguage(lang: string): lang is SupportedLanguage {
  return Object.hasOwn(LANGUAGE_LOADERS, lang);
}

async function ensureLanguage(h: Hl, lang: string): Promise<void> {
  if (lang === 'plaintext' || !isSupportedLanguage(lang) || h.getLoadedLanguages().includes(lang)) return;

  const inFlight = languageLoads.get(lang);
  if (inFlight) return inFlight;

  const request = h.loadLanguage(LANGUAGE_LOADERS[lang]).finally(() => {
    languageLoads.delete(lang);
  });
  languageLoads.set(lang, request);
  return request;
}

function markdownEmbeddedLanguages(code: string): SupportedLanguage[] {
  const embedded = new Set<SupportedLanguage>();
  const fences = /(?:^|\n)[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*([^\s`~]+)/g;
  for (const match of code.matchAll(fences)) {
    const info = match[1].replace(/^\{?\.?/, '').replace(/\}?$/, '').replace(/^language-/, '');
    const language = normalizeLanguage(info);
    if (language !== 'markdown' && isSupportedLanguage(language)) embedded.add(language);
  }
  if (/<(?:\/?[A-Za-z]|!DOCTYPE|!--)/i.test(code)) embedded.add('html');
  if (/^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/.test(code)) embedded.add('yaml');
  return [...embedded];
}

function visibleLanguages(code: string, lang: string): SupportedLanguage[] {
  const languages = new Set(lang === 'markdown' ? markdownEmbeddedLanguages(code) : []);
  if (isSupportedLanguage(lang)) languages.add(lang);
  return [...languages];
}

function prefetchLanguages(languages: SupportedLanguage[]): void {
  for (const language of languages) void LANGUAGE_LOADERS[language]().catch(() => {});
}

async function ensureVisibleLanguages(h: Hl, languages: SupportedLanguage[]): Promise<void> {
  await Promise.all(languages.map((language) => ensureLanguage(h, language)));
}

export async function highlightSegmentsToHtml(segments: HighlightSegment[]): Promise<string> {
  const visibleSegments = segments.filter((s) => s.code.length > 0);
  const languages = [...new Set(visibleSegments.flatMap((segment) => visibleLanguages(segment.code, segment.lang)))];
  prefetchLanguages(languages);
  const h = await getHighlighter(languages);
  await ensureVisibleLanguages(h, languages);
  return visibleSegments
    .map((s) => highlightOne(h, s.code, s.lang))
    .join('');
}

export async function highlightCodeToHtml(code: string, lang: string): Promise<string> {
  const languages = visibleLanguages(code, lang);
  prefetchLanguages(languages);
  const h = await getHighlighter(languages);
  await ensureVisibleLanguages(h, languages);
  return highlightOne(h, code, lang);
}

export async function getHighlighter(initialLanguages: readonly string[] = []) {
  if (highlighterInstance) return highlighterInstance;

  for (const language of initialLanguages) {
    if (isSupportedLanguage(language)) bootstrapLanguages.add(language);
  }

  if (!highlighterPromise) {
    highlighterPromise = Promise.resolve()
      .then(() => createHighlighterCore({
        themes: [
          () => import('@shikijs/themes/vitesse-light'),
          () => import('@shikijs/themes/vitesse-dark'),
        ],
        langs: [...bootstrapLanguages].map((language) => LANGUAGE_LOADERS[language]),
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      }))
      .then((highlighter) => {
        highlighterInstance = highlighter;
        return highlighter;
      });
  }

  return highlighterPromise;
}

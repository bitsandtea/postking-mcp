import { z } from "zod";

/**
 * The language vocabulary PostKing accepts (feature 104; `cs` added in 108).
 *
 * This is a deliberate mirror of `src/const/languages.ts` in the main PostKing
 * repo — the server validates every `language` field against its own copy and
 * 400s on anything else, so the two lists must stay in lockstep. When a
 * language ships there, add the row here and rebuild/redeploy this server;
 * until then agents simply won't be offered the new code.
 *
 * Codes are BCP-47 with canonical casing: `pt-BR`, never `pt`, `pt_br` or
 * `ptBR`. Nothing else in this repo may hardcode a language string.
 */
export const SUPPORTED_LANGUAGES = [
  { code: "en", endonym: "English", english: "English" },
  { code: "es", endonym: "Español", english: "Spanish" },
  { code: "pt-BR", endonym: "Português (Brasil)", english: "Portuguese (Brazil)" },
  { code: "de", endonym: "Deutsch", english: "German" },
  { code: "fr", endonym: "Français", english: "French" },
  { code: "cs", endonym: "Čeština", english: "Czech" },
] as const;

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]["code"];

/** Non-empty tuple so it can be handed straight to `z.enum(...)`. */
export const SUPPORTED_LANGUAGE_CODES = SUPPORTED_LANGUAGES.map((l) => l.code) as unknown as [
  LanguageCode,
  ...LanguageCode[]
];

/** `en (English), es (Spanish), …` — reused verbatim in tool descriptions. */
export const LANGUAGE_LIST_TEXT = SUPPORTED_LANGUAGES.map(
  (l) => `${l.code} (${l.english})`
).join(", ");

/** The bare code list, e.g. `en, es, pt-BR, de, fr, cs`. */
export const LANGUAGE_CODE_LIST_TEXT = SUPPORTED_LANGUAGE_CODES.join(", ");

/**
 * Zod field for a tool's per-request output-language override.
 *
 * Deliberately `.optional()` with NO `.default()`: the server needs to tell
 * "caller asked for English" apart from "caller said nothing" (the latter
 * falls through to the brand's configured content language, then English).
 * A default here would collapse that distinction and poison the audit trail —
 * `undefined` is dropped by `JSON.stringify` so an omitted param never
 * reaches the wire.
 */
export function languageParam(extra?: string) {
  return z
    .enum(SUPPORTED_LANGUAGE_CODES)
    .optional()
    .describe(
      `Output language for this generation, as a BCP-47 code. One of: ${LANGUAGE_LIST_TEXT}. ` +
        "Omit to use the brand's configured content language (English if unset) — do NOT pass 'en' " +
        "just to mean 'unspecified'. Does not translate anything already generated." +
        (extra ? ` ${extra}` : "")
    );
}

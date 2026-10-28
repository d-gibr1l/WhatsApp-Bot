export const VIEWONCE_EMOJIS_KEY = "HOOPER_VIEWONCE_EMOJIS";
export const DEFAULT_VIEWONCE_EMOJIS = ["👀"];
export const MAX_VIEWONCE_EMOJIS = 20;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|^[0-9#*]️?⃣$/u;

// Variation selectors differ between keyboards (❤ vs ❤️) but mean the same emoji.
const normalize = (s) => String(s ?? "").replace(/️/g, "").trim();

/** Accepts an array or a comma/space separated string; returns unique, valid, single-emoji entries. */
export function parseEmojiList(input) {
  const raw = Array.isArray(input) ? input.join(",") : String(input ?? "");
  const seen = new Set();
  const out = [];
  for (const { segment } of segmenter.segment(raw)) {
    if (!EMOJI_RE.test(segment)) continue;
    const key = normalize(segment);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(segment);
    if (out.length >= MAX_VIEWONCE_EMOJIS) break;
  }
  return out;
}

/** Stored setting -> list. A never-set setting means "use the default"; an explicit "" means disabled. */
export function emojisFromSetting(stored) {
  return stored == null ? [...DEFAULT_VIEWONCE_EMOJIS] : parseEmojiList(stored);
}

export const emojisToSetting = (list) => parseEmojiList(list).join(",");

/** True when `text` is exactly one of the configured emojis (nothing else in the message). */
export function isViewOnceTrigger(text, list) {
  const t = normalize(text);
  if (!t || !Array.isArray(list)) return false;
  return list.some((e) => normalize(e) === t);
}

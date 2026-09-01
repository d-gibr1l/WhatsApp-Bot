/**
 * The Mongo Setting schema stores `value` as a String, so a stored boolean
 * `false` comes back as the string "false" — which is truthy. Normalize any
 * setting value that's meant to be a boolean flag through this.
 *
 * Kept in its own side-effect-free module so it's testable without pulling in
 * the whole db.js (which connects to MongoDB on import).
 */
export function coerceBool(v) {
  if (typeof v === "boolean") return v;
  return v === "true" || v === "1" || v === 1;
}

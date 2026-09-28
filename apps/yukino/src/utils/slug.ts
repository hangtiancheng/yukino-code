export const ADJECTIVES = [
  "brave",
  "calm",
  "dark",
  "eager",
  "fair",
  "gentle",
  "happy",
  "kind",
  "lively",
  "mighty",
  "noble",
  "proud",
  "quiet",
  "swift",
  "warm",
  "wise",
];

export const NOUNS = [
  "crystal",
  "dragon",
  "eagle",
  "falcon",
  "flame",
  "forest",
  "frost",
  "mountain",
  "ocean",
  "phoenix",
  "river",
  "shadow",
  "thunder",
  "tiger",
];

export function generateSlug(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const ts = Date.now().toString(36).slice(-4);
  return `${adj}-${noun}-${ts}`;
}

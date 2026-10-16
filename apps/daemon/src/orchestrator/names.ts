import { createHash } from "node:crypto";

/**
 * Run codenames (ADR 0027): an adjective and a ship of the fleet, like "brave-frigate". The run id
 * stays the identifier everywhere (events, branches, worktrees); the name is what people read and
 * type. 64 × 64 = 4,096 pairs, and a pair already taken gets a number ("brave-frigate-2").
 */
export const ADJECTIVES = [
  "able", "agile", "amber", "ancient", "arctic", "azure", "bold", "brave",
  "bright", "brisk", "calm", "clever", "coral", "crimson", "daring", "deep",
  "eager", "early", "fair", "fast", "fearless", "fierce", "firm", "fleet",
  "gentle", "golden", "grand", "hardy", "honest", "humble", "iron", "jade",
  "jolly", "keen", "kind", "lively", "loyal", "lucky", "mighty", "misty",
  "noble", "patient", "polar", "proud", "quick", "quiet", "rapid", "royal",
  "salty", "silent", "silver", "sly", "solid", "stark", "steady", "stormy",
  "sturdy", "swift", "tidal", "true", "valiant", "vivid", "wild", "witty",
] as const;

export const SHIPS = [
  "barque", "brig", "brigantine", "caravel", "carrack", "catamaran", "clipper", "cog",
  "corsair", "corvette", "cruiser", "cutter", "dhow", "dinghy", "dory", "dragonboat",
  "drakkar", "felucca", "ferry", "flagship", "fluyt", "frigate", "galleass", "galleon",
  "galley", "gondola", "hooker", "hulk", "ironclad", "junk", "kayak", "ketch",
  "knarr", "launch", "longship", "lugger", "man-o-war", "monitor", "navette", "pinnace",
  "pirogue", "polacre", "pram", "punt", "quinquereme", "raft", "schooner", "scow",
  "skiff", "sloop", "snow", "steamer", "tartane", "tender", "trawler", "trimaran",
  "trireme", "tug", "umiak", "wherry", "windjammer", "xebec", "yacht", "yawl",
] as const;

/** The codename a seed (a run id) maps to, always the same for the same seed. */
export function codename(seed: string): string {
  const h = createHash("sha256").update(seed).digest();
  return `${ADJECTIVES[h[0]! % ADJECTIVES.length]}-${SHIPS[h[1]! % SHIPS.length]}`;
}

/** The seed's codename, with the lowest number that makes it unique among `taken`. */
export function uniqueCodename(seed: string, taken: (name: string) => boolean): string {
  const base = codename(seed);
  if (!taken(base)) return base;
  for (let n = 2; ; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
}

/** Whether a reference looks like a run name rather than a run id. */
export function isRunName(ref: string): boolean {
  return /^[a-z]+-[a-z-]+(-\d+)?$/.test(ref) && !ref.startsWith("run_");
}

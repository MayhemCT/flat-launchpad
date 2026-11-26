// Launchpads. On Pool Launch every Launcher Factory is somebody's launchpad: this gives each one a name and a
// colour that stay the same on every page. Flap itself, and RaidPass, have fixed ones.
import { short } from "./format";
import { FACTORY, RAIDPASS_CHAIN, type Site } from "./site";

/** Flap's own lime, used wherever the page points at Flap. */
export const FLAP_COLOUR = "#d0ff00";
const RAIDPASS_COLOUR = "#f0b90b";

export interface Platform {
  /** Stable id: the factory address, or "flap" for tokens launched straight through Flap's Portal. */
  key: string;
  name: string;
  colour: string;
  factory: string | null;
  kind: "flap" | "raidpass" | "factory";
  /** False when the factory's Launchers carry no common title, so the name is only its address. */
  named: boolean;
}

/** A factory's title as a short launchpad name: "KabalKult: KOLs paid in stock…" reads "KabalKult". */
function shorten(title: string): string {
  const head = (title.split(":")[0] ?? title).trim();
  const characters = [...head];
  return characters.length > 26 ? `${characters.slice(0, 25).join("")}…` : head;
}

/** One hue per factory address, kept clear of RaidPass's gold and Flap's lime. */
function colourOf(address: string): string {
  let hash = 0;
  for (let index = 0; index < address.length; index++) hash = (hash * 31 + address.charCodeAt(index)) >>> 0;
  // 280 hues starting past lime: 95° round to 15°, which skips the 15°–95° band gold and lime sit in.
  const hue = (95 + (hash % 280)) % 360;
  return `hsl(${hue} 82% 68%)`;
}

export const FLAP: Platform = { key: "flap", name: "Flap", colour: FLAP_COLOUR, factory: null, kind: "flap", named: true };

export function platformOf(site: Site, factory: string | null, titles: ReadonlyMap<string, string | null>): Platform {
  if (!factory) return FLAP;
  if (site.key === RAIDPASS_CHAIN && factory === FACTORY) {
    return { key: factory, name: "RaidPass", colour: RAIDPASS_COLOUR, factory, kind: "raidpass", named: true };
  }
  const title = titles.get(factory);
  return {
    key: factory,
    name: title ? shorten(title) : `Factory ${short(factory)}`,
    colour: colourOf(factory),
    factory,
    kind: "factory",
    named: Boolean(title),
  };
}

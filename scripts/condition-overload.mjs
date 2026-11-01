// Reads the wiki's measurements of how Condition Overload-style bonuses behave on each attack.
// https://wiki.warframe.com/w/Condition_Overload_(Mechanic)#Attack_Catalog

// The wiki's attack names, where they differ from the data's. An attack left out here and not matched by name is listed
// as unmapped rather than guessed at.
const ALIASES = {
  "Acceltra|Normal Attack": ["Rocket Impact"], "Battacor|Main-fire": ["Normal Attack"], "Ambassador|Alt-fire Hitscan Radial Attack": ["Charged AoE"], "Basmu|Main-fire": ["Auto"],
  "Braton|Incarnon Form Radial Attack": ["Incarnon Form AoE"], "Mk1-Braton|Incarnon Form Radial Attack": ["Incarnon Form AoE"],
  "Braton Prime|Incarnon Form Radial Attack": ["Incarnon Form AoE"], "Braton Vandal|Incarnon Form Radial Attack": ["Incarnon Form AoE"],
  "Bubonico|Main-fire": ["Auto"], "Bubonico|Alt-fire": ["Burst"], "Buzlok|Alt-fire": ["Beacon"],
  "Cedo|Alt-fire": ["Alt-Fire Glaive"], "Cedo Prime|Alt-fire": ["Alt-Fire Glaive"],
  "Cernos Prime|Charged Attack": ["Charged Horizontal/Vertical Shot"], "Mutalist Cernos|Uncharged Attack": ["Uncharged Shot"],
  "Mutalist Cernos|Charged AoE Toxin Cloud": ["Toxin Cloud"], "Cinta|Uncharged Attack": ["Quick Shot"],
  "Dread|Incarnon Mode": ["Incarnon Form Charged Shot"], "Fulmin|Semi-Mode": ["Semi-Auto Mode"], "Harpak|Alt-fire": ["Harpoon"],
  "Javlok|Main-fire": ["Projectile Impact"], "Opticor|Charged Hitscan Direct Hit Radial Attack": ["Charged Shot AoE"],
  "Opticor Vandal|Charged Hitscan Radial Attack": ["Charged Shot AoE"], "Paracyst|Alt-fire": ["Infested Harpoon"],
  "Paris|Incarnon Mode": ["Incarnon Form Charged Shot"], "Paris Prime|Incarnon Mode": ["Incarnon Form Charged Shot"],
  "Phantasma|Alt-fire Child Bomb": ["Cluster Bombs Impact"], "Phantasma Prime|Alt-fire Child Bomb": ["Cluster Bombs Impact"],
  "Proboscis Cernos|Radial attack": ["Charged Shot Explosion"], "Proboscis Cernos|Tendrils": ["Appendages"],
  "Scourge|Throw": ["Spear Throw Impact"], "Scourge Prime|Throw": ["Spear Throw"], "Stahlta|Main-fire": ["Auto"],
  "Tenet Envoy|Normal Attack": ["Grenade Impact"], "Torid|Main-fire": ["Grenade Impact"], "Torid|Toxin AoE Cloud": ["Poison Cloud"],
  "Trumna|Main-fire Hitscan Radial Attack": ["Auto AoE"], "Trumna|Alt-fire": ["Grenade Impact"],
  "Zarr|Cannon Child Bomb": ["Cannon Mode Cluster Bomb Contact"], "Kuva Zarr|Cannon Child Bomb": ["Cannon Mode Cluster Bomb Contact"],
  "Zhuge Prime|Arrow Direct Hit": ["Arrow Impact"], "Zhuge Prime|Arrow Embedded Explosion": ["Arrow Explosion"],
  "Castanas|Normal Attack": ["Mid-Flight Detonation", "Embedded Detonation"], "Kompressa Prime|Radial Attack": ["Explosion"],
  "Tenet Plinx|Alt Fire Impact": ["Alt-Fire"], "Pox|DoT Cloud": ["Poison Cloud"], "Stug|Blob Impact": ["Blob Embed", "Blob Explosion"],
  "Stug|Incarnon Form": ["Incarnon Form Blob Embed", "Incarnon Form Blob Explosion"], "Sonicor|Projectile Wave": ["Projectile Impact", "Explosion"],
  "Zakti|Normal Attack": ["Dart Impact"], "Argo & Vel|Thrown Glaive": ["Heavy Attack Glaive"], "Corufell|Heavy Attack Projectile": ["Charged Projectile"],
  "Edun|Heavy Attack Projectile": ["Polearm Throw"], "Innodem|Aerial Incarnon Projectile": ["Dagger Projectile"], "Nepheri|Neutral Combo Fireball": ["Fireballs"],
  "Arum Spinosa|Heavy Attack 1 Daggers": ["First Heavy Attack - Toxic Spines"], "Arum Spinosa|Heavy Attack 2 Daggers": ["Second Heavy Attack - Toxic Spines"],
  "Quassus Prime|Heavy Attack 1 Daggers": ["First Heavy Attack - Ethereal Daggers"], "Quassus Prime|Heavy Attack 2 Daggers": ["Second Heavy Attack - Ethereal Daggers"], "Stropha|Heavy Attack Projectile": ["Ranged Attack"],
  "Syam|Heavy Attack Wave 1": ["First Shockwave"], "Syam|Heavy Attack Wave 2": ["Second Shockwave"], "Zenistar|Heavy Disc": ["Disc Impact"],
  "Arbucep|Direct Hit": ["1st Attack", "2nd Attack", "3rd Attack"], "Kuva Ayanga|Direct Hit": ["Grenade Impact"], "Corvas Prime|Uncharged Attack": ["Uncharged Shot"],
  "Grattler|Normal attack": ["Projectile Impact"], "Larkspur Prime|Alt-fire": ["Alt-Fire Projectile Impact"], "Mandonel|Uncharged Attack": ["Horizontal Spread"],
  "Mandonel|Charged attack": ["Charge"], "Mausolon|Main-fire Radial Attack": ["Auto Radial Attack"], "Mausolon|Alt-fire Radial Attack": ["Charged Shot Explosion"],
  "Velocitus|Uncharged attack": ["Uncharged Shot"], "Noctua|Noctua Primary Fire": ["Normal Attack"], "Cryotra|Normal Attack": ["Direct Hit"], "Multron|Normal Attack": ["Projectile Impact"],
};

const plain = (text) => text
  .replace(/\{\{[A-Za-z]+\|([^}|]+)(?:\|[^}]*)?\}\}/g, "$1").replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
  .replace(/'{2,}/g, "").replace(/<[^>]+>/g, "").trim();
const sameName = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
  .replace(/\bincarnon mode\b/, "incarnon form").replace(/\bcharged attack\b/, "charged shot").replace(/\balternate fire\b/, "alt fire");

function catalogRows(page) {
  const start = page.indexOf("==Attack Catalog==");
  const rows = [];
  for (const [, section, table] of page.slice(start, page.indexOf("==Patch History==")).matchAll(/===\s*([^\n=]+?)\s*===[\s\S]*?\{\|[^\n]*\n([\s\S]*?)\n\|\}/g)) {
    if (section === "Stances") continue;
    const parts = table.split(/(?:^|\n)\|-\n?/);
    const header = parts.find((part) => part.startsWith("!"));
    const columns = header.replace(/^!/, "").split(/!!|\n!/).map(plain);
    const at = (label) => columns.findIndex((column) => column.startsWith(label));
    const [weapon, attack, ratio, behavior] = [at("Weapon"), at("Attack Name"), at("CO Damage Bonus Relative"), at("Math/Behavior")];
    for (const part of parts) {
      if (!part.startsWith("|")) continue;
      const cells = part.replace(/^\|/, "").split(/\|\||\n\|/).map(plain);
      if (cells[behavior]) rows.push({ weapons: cells[weapon].split("/").map((name) => name.trim()), attack: cells[attack], ratio: cells[ratio], behavior: cells[behavior] });
    }
  }
  return rows;
}

// { weapon: { attack: { behavior, ratio } } }, where ratio is the share of the listed bonus the attack really gets.
export function importConditionOverload(page, weapons) {
  const behaviors = {};
  const unmapped = [];
  for (const row of catalogRows(page)) {
    const multiplying = row.behavior === "Multiplying";
    const none = /^(N\/A|Does not apply)/i.test(row.behavior);
    const ratio = none ? 0 : Number.parseFloat(row.ratio) / 100;
    if (!none && !multiplying && row.behavior !== "Adding") continue;
    if (Number.isNaN(ratio)) continue;
    for (const name of row.weapons) {
      const modes = weapons[name]?.modes.map((mode) => mode.name) ?? [];
      const exact = modes.find((mode) => sameName(mode) === sameName(row.attack));
      const targets = exact ? [exact] : (ALIASES[`${name}|${row.attack}`] ?? []).filter((mode) => modes.includes(mode));
      if (!targets.length) unmapped.push(`${name}: ${row.attack}`);
      for (const mode of targets) {
        (behaviors[name] ??= {})[mode] = { behavior: none ? "none" : multiplying ? "multiplying" : "adding", ratio };
      }
    }
  }
  return { behaviors, unmapped };
}

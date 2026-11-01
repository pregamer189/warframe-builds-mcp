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
  "Velocitus|Uncharged attack": ["Uncharged Shot"], "Noctua|Noctua Primary Fire": ["Normal Attack"], "Noctua|Noctua Alt Fire": ["Active Attack"], "Cryotra|Normal Attack": ["Direct Hit"], "Multron|Normal Attack": ["Projectile Impact"],
  "Ferrox|Hitscan AoE Direct": ["Radial Attack"], "Tenet Ferrox|Hitscan AoE Direct": ["Radial Attack"], "Glaxion Vandal|Normal Attack Hitscan AoE": ["Normal Attack"],
  "Vadarya Prime|Primary Fire Lightning Strikes": ["Normal Attack"], "Artemis Bow|Uncharged/Charged Attack": ["Base Uncharged Shot", "Base Charged Shot"], "Vulcax|Normal Attack + AoE": ["Impact", "Radial Attack"],
};

// Measured attacks the data has no entry for, so the bonus has nothing to apply to. Anything else unmatched is worth a look.
const NOT_IN_DATA = new Set([
  "Mutalist Cernos: Uncharged AoE Toxin Cloud", "Zenith: Alt-fire Disk Bonk", "Azima: Alt-Fire Turret Bullets", "Scyotid: Alt-Fire Grab", "Destreza: Spectral Rapiers",
  "Destreza Prime: Spectral Rapiers", "Exodia Contagion: Aerial Projectile", "Tenet Agendus: Heavy Attack Wave 1", "Tenet Agendus: Heavy Attack Wave 2", "Corvas: Normal attack",
  "Noctua: Final Verse Wordwarden", "Exalted Umbra Blade: Light Waves", "Exalted Umbra Blade: Heavy Waves", "Shwaak Prism: Normal Attack", "Phahd Scaffold: Normal Attack",
  "Shraksun Scaffold: Normal Attack", "Sporelacer (Secondary): Bomblet Impact", "Stance: Razorwing",
]);

const KITGUN_NAME = /^(\w+) \((Primary|Secondary)\)(?: \((\w+)\))?$/;

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
    const [weapon, attack, ratio, behavior, notes, damage] = [at("Weapon"), at("Attack Name"), at("CO Damage Bonus Relative"), at("Math/Behavior"), at("Notes"), Math.max(at("Attack Unmodded"), at("Attack Damage"))];
    for (const part of parts) {
      if (!part.startsWith("|")) continue;
      const cells = part.replace(/^\|/, "").split(/\|\||\n\|/).map(plain);
      if (cells[behavior]) rows.push({ weapons: cells[weapon].split("/").map((name) => name.trim()), attack: cells[attack], ratio: cells[ratio], behavior: cells[behavior], note: notes < 0 ? "" : cells[notes] ?? "", damage: damage < 0 ? "" : cells[damage] ?? "" });
    }
  }
  return rows;
}

// { stance: { input: share } }, how much of the bonus each combo keeps. Blank cells are untested, so they're left out.
function stanceShares(page, stances, unmapped) {
  const start = page.indexOf("===Stances===");
  const [, table] = page.slice(start).match(/\{\|[^\n]*\n([\s\S]*?)\n\|\}/);
  const parts = table.split(/(?:^|\n)\|-\n?/);
  const columns = parts.find((part) => part.startsWith("!")).replace(/^!/, "").split("!!").map(plain);
  const shares = {};
  for (const part of parts) {
    if (!part.startsWith("|")) continue;
    const cells = part.replace(/^\|/, "").split("||").map(plain);
    const stance = cells[columns.indexOf("Stance")];
    if (!stances[stance]) {
      if (!NOT_IN_DATA.has(`Stance: ${stance}`)) unmapped.push(`Stance: ${stance}`);
      continue;
    }
    columns.forEach((input, index) => {
      const share = Number.parseFloat(cells[index]) / 100;
      if (index > 1 && !Number.isNaN(share)) (shares[stance] ??= {})[input] = share;
    });
  }
  return shares;
}

// { weapon: { attack: { behavior, ratio, note? } } }, where ratio is the share of the listed bonus the attack really gets.
// Kitguns are listed separately by chamber and slot, because their attacks only exist once they're built.
export function importConditionOverload(page, weapons, stances = {}) {
  const behaviors = {};
  const kitguns = {};
  const unmapped = [];
  for (const row of catalogRows(page)) {
    const multiplying = row.behavior === "Multiplying";
    const none = /^(N\/A|Does not apply)/i.test(row.behavior);
    const ratio = none ? 0 : Number.parseFloat(row.ratio) / 100;
    if (!none && !multiplying && row.behavior !== "Adding") continue;
    if (Number.isNaN(ratio)) continue;
    const measured = { behavior: none ? "none" : multiplying ? "multiplying" : "adding", ratio, ...(row.note && !/^Does not apply$/i.test(row.note) && { note: row.note }) };
    for (const name of row.weapons) {
      const kitgun = name.match(KITGUN_NAME);
      if (kitgun && row.attack === "Normal Attack") {
        // One Kitgun's bonus reads a fixed number, whatever the grip makes its damage.
        const fixed = row.note.match(/uses (\d+) damage value for any configuration/);
        (kitguns[kitgun[1]] ??= {})[kitgun[2].toLowerCase()] = { ...measured, ...(kitgun[3] && { grip: kitgun[3] }), ...(fixed && { fixedBonus: Number(fixed[1]) }) };
        continue;
      }
      const modes = weapons[name]?.modes.map((mode) => mode.name) ?? [];
      const exact = modes.find((mode) => sameName(mode) === sameName(row.attack));
      const targets = exact ? [exact] : (ALIASES[`${name}|${row.attack}`] ?? []).filter((mode) => modes.includes(mode));
      if (!targets.length && !NOT_IN_DATA.has(`${name}: ${row.attack}`)) unmapped.push(`${name}: ${row.attack}`);
      for (const mode of targets) {
        // Some attacks hit for more than the data lists, such as a heavy attack's projectile, so results can say so.
        const { damage, pellets = 1 } = weapons[name].modes.find((entry) => entry.name === mode);
        const ours = Object.values(damage).reduce((sum, value) => sum + value, 0) * pellets;
        const listed = /\+/.test(row.damage) ? Number.NaN : Number.parseFloat(row.damage);
        (behaviors[name] ??= {})[mode] = { ...measured, ...(listed > ours * 1.2 && { listedDamage: listed }) };
      }
    }
  }
  // The catalog's note on the Artemis Bow: the bonus stops working with Concentrated Arrow equipped.
  for (const { name } of weapons["Artemis Bow"]?.modes ?? []) {
    if (name.startsWith("Concentrated Arrow")) (behaviors["Artemis Bow"] ??= {})[name] = { behavior: "none", ratio: 0, note: "Doesn't work while Concentrated Arrow is equipped." };
  }
  return { behaviors, kitguns, stances: stanceShares(page, stances, unmapped), unmapped };
}

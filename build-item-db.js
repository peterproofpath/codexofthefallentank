#!/usr/bin/env node
// build-item-db.js — fetches the wowsims database, filters it to TBC-era
// paladin-relevant items/gems/enchants/sets, then writes items-db.json and
// injects the minified JSON into wcl-analyzer.html between markers.
//
// Run: node build-item-db.js

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SOURCES = {
  db:  'https://raw.githubusercontent.com/wowsims/wotlk/master/assets/database/db.json',
  leftover: 'https://raw.githubusercontent.com/wowsims/wotlk/master/assets/database/leftover_db.json',
};

// Stat index order used by wowsims/wotlk `sim/core/stats/stats.go`.
// Length 35. TBC-era items map cleanly into these slots.
const STAT_NAMES = [
  'strength','agility','stamina','intellect','spirit','spellPower','mp5',
  'spellHit','spellCrit','spellHaste','spellPenetration','attackPower',
  'meleeHit','meleeCrit','meleeHaste','armorPenetration','expertise',
  'mana','energy','rage','armor','rangedAttackPower','defense','blockRating',
  'blockValue','dodgeRating','parryRating','resilience','health',
  'arcaneResist','fireResist','frostResist','natureResist','shadowResist',
  'bonusArmor',
];

// wowsims `type` field == inventory slot id (matches Wowhead INVTYPE).
// Paladin-equippable slot ids (1h, 2h, shield, plate everything, neck, ring,
// trinket, cloak, ranged, tabard, shirt, libram/relic).
const PALADIN_SLOT_IDS = new Set([
  1,  // head
  2,  // neck
  3,  // shoulder
  4,  // shirt
  5,  // chest
  6,  // waist
  7,  // hands
  8,  // legs
  9,  // feet
  10, // wrist
  11, // finger
  12, // trinket
  13, // 1h weapon (main)
  14, // shield
  15, // ranged (paladins use librams here)
  16, // cloak
  17, // 2h weapon (paladin can use)
  19, // tabard
  20, // robe (legacy)
  21, // main-hand only
  22, // off-hand only
  23, // held-in-off-hand (libram)
  25, // ranged-right (wand/relic)
  26, // ranged-right alt
]);

// wowsims `classAllowlist`: index 4 = Paladin.
const PALADIN_CLASS_ID = 4;

// wowsims armorType: 1 cloth, 2 leather, 3 mail, 4 plate.
// Slots where the "must be plate" check does NOT apply (non-armor or cosmetic).
const NON_ARMOR_SLOTS = new Set([2, 4, 11, 12, 13, 14, 15, 16, 17, 19, 21, 22, 23, 25, 26]);

// Item-level ceiling. TBC Sunwell (T6) items cap around ilvl 164; leave slack
// for trinkets/weapons that sometimes push a little higher. Anything above
// this is WotLK+ and shouldn't be equipped in a 2.4.3 log.
const MAX_ILVL = 164;

// TBC paladin tier set bonuses. `setName` keys match the strings wowsims
// stores on each item (confirmed by spot-checking Cassen's Justicar pieces in
// report w2aQqPTyMKbFRWgY). Bonus text is summarised — exact numbers match
// Wowhead Classic TBC tooltips.
const TBC_SET_BONUSES = {
  // T4 Karazhan/Gruul/Mag — prot paladin
  'Justicar Armor': {
    name: 'Justicar Armor (T4 Prot)',
    bonuses: [
      { pieces: 2, text: 'Increases the block value of your shield by 30.' },
      { pieces: 4, text: 'Increases the damage of your Holy Shield spell by 10%.' },
    ],
  },
  'Justicar Battlegear': {
    name: 'Justicar Battlegear (T4 Ret)',
    bonuses: [
      { pieces: 2, text: 'Increases damage from Judgement of Command by 10%.' },
      { pieces: 4, text: 'Judgement of Command increases holy damage dealt by 20 for 10 sec.' },
    ],
  },
  'Justicar Raiment': {
    name: 'Justicar Raiment (T4 Holy)',
    bonuses: [
      { pieces: 2, text: 'Reduces the cost of your Flash of Light spell by 5%.' },
      { pieces: 4, text: 'Increases the duration of your Greater Blessing of Wisdom/Might by 15 min.' },
    ],
  },
  // T5 SSC/TK — prot paladin
  'Lightbringer Armor': {
    name: 'Lightbringer Armor (T5 Prot)',
    bonuses: [
      { pieces: 2, text: 'Your Judgements now heal you for 70.' },
      { pieces: 4, text: 'Your Blessings and Seals last 10% longer.' },
    ],
  },
  'Lightbringer Battlegear': {
    name: 'Lightbringer Battlegear (T5 Ret)',
    bonuses: [
      { pieces: 2, text: 'Reduces the mana cost of your Seal of Command by 10%.' },
      { pieces: 4, text: 'Your Blessings and Seals last 10% longer.' },
    ],
  },
  'Lightbringer Raiment': {
    name: 'Lightbringer Raiment (T5 Holy)',
    bonuses: [
      { pieces: 2, text: 'Your Holy Light grants the target 100 bonus armor for 10 sec.' },
      { pieces: 4, text: 'Your Blessings and Seals last 10% longer.' },
    ],
  },
  // T6 Hyjal/BT — prot paladin
  'Crystalforge Armor': {
    name: 'Crystalforge Armor (T6 Prot)',
    bonuses: [
      { pieces: 2, text: '15% chance on Judgement cast to increase your block value by 100 for 10 sec.' },
      { pieces: 4, text: 'Consecration deals additional damage equal to 80% of your bonus spell power.' },
    ],
  },
  'Crystalforge Battlegear': {
    name: 'Crystalforge Battlegear (T6 Ret)',
    bonuses: [
      { pieces: 2, text: '15% chance on Judgement to grant an additional instant Judgement.' },
      { pieces: 4, text: 'Increases the critical strike chance of Crusader Strike by 15%.' },
    ],
  },
  'Crystalforge Raiment': {
    name: 'Crystalforge Raiment (T6 Holy)',
    bonuses: [
      { pieces: 2, text: 'Increases healing done by Flash of Light and Holy Light by 5%.' },
      { pieces: 4, text: '10% chance on cast of Flash of Light to give the target Blessing of Light.' },
    ],
  },
  // Bonus: S3/S4 arena (fairly common on tanks as filler).
  "Merciless Gladiator's Redemption": {
    name: "Merciless Gladiator's Redemption (S2 Prot)",
    bonuses: [
      { pieces: 2, text: '+35 Resilience Rating.' },
      { pieces: 4, text: '+50 Resilience Rating, reduces cooldown of Hammer of Justice by 10 sec.' },
    ],
  },
  "Vengeful Gladiator's Redemption": {
    name: "Vengeful Gladiator's Redemption (S3 Prot)",
    bonuses: [
      { pieces: 2, text: '+35 Resilience Rating.' },
      { pieces: 4, text: '+50 Resilience Rating, reduces cooldown of Hammer of Justice by 10 sec.' },
    ],
  },
};

// -------- helpers ----------------------------------------------------------

async function fetchJson(url) {
  process.stderr.write(`fetch ${url}\n`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

function decodeStats(arr) {
  if (!Array.isArray(arr)) return {};
  const out = {};
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v && STAT_NAMES[i]) out[STAT_NAMES[i]] = v;
  }
  return out;
}

function trimItem(it) {
  return {
    id: it.id,
    name: it.name,
    icon: it.icon,
    slot: it.type,                 // wowsims `type` = inventory slot
    armorType: it.armorType ?? 0,  // 0 = non-armor (weapon/neck/etc)
    ilvl: it.ilvl ?? 0,
    quality: it.quality ?? 0,
    stats: decodeStats(it.stats),
    sockets: it.gemSockets || [],
    socketBonus: decodeStats(it.socketBonus || []),
    setName: it.setName || undefined,
    classAllowlist: it.classAllowlist || undefined,
    weaponDamageMin: it.weaponDamageMin,
    weaponDamageMax: it.weaponDamageMax,
    weaponSpeed: it.weaponSpeed,
    weaponType: it.weaponType,
    handType: it.handType,
  };
}

function trimGem(g) {
  return {
    id: g.id,
    name: g.name,
    icon: g.icon,
    color: g.color,
    stats: decodeStats(g.stats),
  };
}

function trimEnchant(e) {
  return {
    effectId: e.effectId,
    spellId: e.spellId,
    itemId: e.itemId,
    name: e.name,
    slot: e.type,                  // which slot category
    stats: decodeStats(e.stats),
  };
}

function isPaladinEquippable(it) {
  if (!PALADIN_SLOT_IDS.has(it.type)) return false;
  if (Array.isArray(it.classAllowlist) && it.classAllowlist.length > 0) {
    if (!it.classAllowlist.includes(PALADIN_CLASS_ID)) return false;
  }
  // For armor slots (head/shoulder/chest/waist/legs/feet/wrist/hands),
  // require plate. Paladins can theoretically equip lower armor for
  // transmog/twink logs but TBC logs should only show plate.
  const isArmorSlot = !NON_ARMOR_SLOTS.has(it.type);
  if (isArmorSlot && it.armorType && it.armorType !== 4) return false;
  return true;
}

// -------- main -------------------------------------------------------------

async function main() {
  const db = await fetchJson(SOURCES.db);
  let leftover = { items: [], gems: [], enchants: [] };
  try {
    leftover = await fetchJson(SOURCES.leftover);
  } catch (e) {
    process.stderr.write(`(leftover fetch failed, skipping: ${e.message})\n`);
  }

  // Merge item pools, dedupe by id — primary db wins.
  const itemsById = new Map();
  for (const it of db.items || []) itemsById.set(it.id, it);
  for (const it of leftover.items || []) if (!itemsById.has(it.id)) itemsById.set(it.id, it);

  const allItems = [...itemsById.values()];
  const items = allItems
    .filter(it => it.ilvl === undefined || it.ilvl === 0 || it.ilvl <= MAX_ILVL)
    .filter(isPaladinEquippable)
    .map(trimItem);

  // Always keep shirts/tabards regardless of ilvl — they're cosmetic.
  const cosmeticIds = new Set();
  for (const it of allItems) {
    if (it.type === 4 || it.type === 19) {
      if (!items.find(x => x.id === it.id)) {
        items.push(trimItem(it));
        cosmeticIds.add(it.id);
      }
    }
  }

  // Gems — keep them all, they're small.
  const gemsById = new Map();
  for (const g of db.gems || []) gemsById.set(g.id, g);
  for (const g of leftover.gems || []) if (!gemsById.has(g.id)) gemsById.set(g.id, g);
  const gems = [...gemsById.values()].map(trimGem);

  // Enchants — keep them all.
  const enchantsById = new Map();
  for (const e of db.enchants || []) enchantsById.set(`${e.effectId}|${e.spellId}`, e);
  for (const e of leftover.enchants || []) {
    const k = `${e.effectId}|${e.spellId}`;
    if (!enchantsById.has(k)) enchantsById.set(k, e);
  }
  const enchants = [...enchantsById.values()].map(trimEnchant);

  // Build output.
  const out = {
    meta: {
      generated: new Date().toISOString(),
      source: 'wowsims/wotlk master db.json + leftover_db.json',
      notes: 'Filtered to paladin-equippable, ilvl <= ' + MAX_ILVL +
             '. Stat keys match wowsims stats.go index 0..34.',
    },
    statNames: STAT_NAMES,
    items,
    gems,
    enchants,
    sets: TBC_SET_BONUSES,
  };

  const pretty = JSON.stringify(out, null, 2);
  const minified = JSON.stringify(out);
  await fs.writeFile(path.join(__dirname, 'items-db.json'), pretty);
  process.stderr.write(
    `wrote items-db.json: ${items.length} items, ${gems.length} gems, ` +
    `${enchants.length} enchants, ${Object.keys(TBC_SET_BONUSES).length} sets ` +
    `(${(pretty.length/1024).toFixed(1)} KB pretty, ${(minified.length/1024).toFixed(1)} KB min)\n`
  );

  // Inject into wcl-analyzer.html between markers if present.
  const htmlPath = path.join(__dirname, 'wcl-analyzer.html');
  try {
    const html = await fs.readFile(htmlPath, 'utf8');
    const start = '/*__ITEMS_DB_START__*/';
    const end   = '/*__ITEMS_DB_END__*/';
    const si = html.indexOf(start);
    const ei = html.indexOf(end);
    if (si === -1 || ei === -1 || ei < si) {
      process.stderr.write('(markers not found in wcl-analyzer.html — skipping injection)\n');
      return;
    }
    const before = html.slice(0, si + start.length);
    const after  = html.slice(ei);
    const injected = before + minified + after;
    await fs.writeFile(htmlPath, injected);
    process.stderr.write(`injected minified DB into wcl-analyzer.html (${(minified.length/1024).toFixed(1)} KB)\n`);
  } catch (e) {
    if (e.code === 'ENOENT') {
      process.stderr.write('(wcl-analyzer.html not found — skipping injection)\n');
    } else {
      throw e;
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

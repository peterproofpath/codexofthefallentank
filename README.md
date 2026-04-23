# WCL Raid Death Analyzer — TBC Paladin Tank Edition

A forensic tool that pulls a Warcraft Logs V1 report in the browser and
produces a per-fight deep dive into why a specific tank died, and whether
their gear was appropriate for that boss. Built for TBC 2.4.3 / Karazhan
(Classic Fresh), tuned for Holy/Prot paladin tanks.

## Files

| File                  | What it is                                            |
|-----------------------|-------------------------------------------------------|
| `wcl-analyzer.html`   | Single-file artifact. Open it and go.                 |
| `build-item-db.js`    | Node script that regenerates `items-db.json` and re-injects it into the HTML. |
| `items-db.json`       | Filtered TBC-era paladin item/gem/enchant database (pretty-printed for diffs). |

## Running the analyzer

1. Open `wcl-analyzer.html` directly in a browser — no build step, no server.
2. Fill in the form:
   - **Report code** — e.g., `w2aQqPTyMKbFRWgY`
   - **API key** — a Warcraft Logs V1 API key (persisted in `localStorage`)
   - **Player (tank)** — defaults to `Cassen`
   - **Healer (reference)** — defaults to `Dharkon`
   - **Region** — defaults to `fresh` (Classic Fresh). Use `www` for retail, `classic` for era, `cata` for Cata Classic.
3. Hit **Load Report**.

Per-fight cards render along a vertical spine. For every fight the player
was in, you get a gear breakdown with derived defense/crit-immunity numbers
plus a "swaps from previous fight" diff. For every fight the player **died**
in, you also get a 5-second death timeline (damage taken, healer casts,
Holy Shield uptime) and a written autopsy.

### Caching

- Form values persist in `localStorage` (`wcl-form`).
- Network responses cached in memory per session, keyed by URL, and dumped
  to `localStorage` per report (`wcl-cache:<region>:<code>`) so refreshing
  the page doesn't re-spend API points.
- The **Clear Report Cache** button in the footer nukes all report caches.

### CORS

Warcraft Logs V1 sends `Access-Control-Allow-Origin: *`, so the browser
can `fetch()` directly from `file://`. No proxy needed.

## Regenerating the item database

The HTML file embeds a minified copy of `items-db.json` between markers.
To refresh it:

```bash
node build-item-db.js
```

That script:
1. Downloads `db.json` and `leftover_db.json` from `wowsims/wotlk` master
   (~8 MB total; WotLK's DB cleanly covers all TBC-era items with plain
   JSON — the TBC repo itself embeds data in Go source, which is not
   easily fetchable).
2. Filters to paladin-equippable items with `ilvl <= 164` (through T6),
   all gems, and all enchants.
3. Decodes wowsims' positional `stats` arrays into readable keys via the
   stat index in `sim/core/stats/stats.go`.
4. Hand-transcribed TBC tier-set bonuses (T4/T5/T6 prot/ret/holy) are
   merged in.
5. Writes pretty-printed `items-db.json` (~2.8 MB) and injects a minified
   copy (~1.7 MB) into `wcl-analyzer.html` between the `ITEMS_DB_START` /
   `ITEMS_DB_END` markers.

If the markers aren't present (e.g., you deleted the HTML), the script
just writes the JSON file and logs a warning.

## WCL V1 endpoints used

All under `https://{region}.warcraftlogs.com/v1`. All require `?api_key=...`.

| Endpoint                                                | Purpose                                                                 |
|---------------------------------------------------------|-------------------------------------------------------------------------|
| `/report/fights/{code}`                                 | Fight list, friendlies, enemies, fight windows.                         |
| `/report/events/deaths/{code}?targetid=<playerId>`      | Player death events. `targetid` works here.                             |
| `/report/events/damage-taken/{code}?filter=target.name="..."` | Damage events against the player. **`targetid` is broken on this endpoint** — use the `filter` form. |
| `/report/events/casts/{code}?sourceid=<healerId>`       | Healer cast events in a window.                                         |
| `/report/events/buffs/{code}?targetid=<playerId>&abilityid=20925` | Holy Shield buff events. Fetched once per rank (20925, 20927, 20928, 27179). |
| `/report/tables/summary/{code}?start=X&end=Y`           | `playerDetails[role][i].combatantInfo.gear` array per fight, with item ID, iLvl, permanent enchant id+name, and gem ids. Called per fight. |

Rate limit is 3,600 points/hour. A typical report fetch spends ~200-400
points depending on death count. The in-memory + localStorage cache keeps
re-loads free.

## Stat engine

The stat pipeline sums:
1. Item base stats (from `items-db.json`).
2. Gem stats.
3. Socket bonus (if all sockets are filled).
4. Enchant stats, looked up by `permanentEnchant` (= wowsims `effectId`),
   falling back to an enchant-name match if the effect id is unknown.
5. Set bonuses at 2pc / 4pc thresholds.

Derived values (TBC level 70 vs level 73 boss):

- **Defense Skill** = 350 + floor(DefenseRating / 2.3653)
- **Crit reduction** = (DefenseSkill - 350) × 0.04% + (Resilience / 39.4)
- **Crit immune** when total crit reduction ≥ 5.6%
- **Dodge %** = DodgeRating / 18.92
- **Parry %** = ParryRating / 23.65
- **Block %** = BlockRating / 7.88

All constants live at the top of the `<script>` block in `TBC`.

## Testing

The artifact was validated against report `w2aQqPTyMKbFRWgY` (Karazhan +
Gruul + Magtheridon night). Expected signals that confirm the pipeline
works:

- Attumen fight shows Cassen's threat-leaning gear (Bloodmaw Magus-Blade
  with `+14 Spell Power` enchant, `Bracers of Dignity`, spell-power
  trinkets) → 565 Spell Power, **not crit immune** (−0.96% below the 5.6% line).
- Gear diff between Attumen and Curator is populated.
- Attumen Death 1 timeline shows:
  - Shadow Cleave for 4,791 at t≈-2.0s
  - Midnight knockdown at t≈-0.02s
  - Killing blow: Attumen Melee for 2,036 (1,899 overkill)
  - Dharkon's Circle of Healing at t≈-4.4s, Renew on player at t≈-3.1s
  - Holy Shield lapsed at t≈-4.0s and was not refreshed (20% uptime)

## Stretch goals not implemented

- BIS gear comparison per-fight
- Swing-gap detection (consecutive melee with no intervening heal)
- PDF export
- Multi-player (tank + co-tank) simultaneous analysis
- V2 GraphQL fallback

## Known quirks

- Some non-stat cosmetic items (Sawbones Shirt id `14617`, old faction
  tabards) aren't in the wowsims DB. The gear table still shows their
  name+icon from the WCL payload, just with no stat contribution.
- T4 Justicar tank set bonus text is hand-transcribed from Wowhead
  Classic TBC and is approximate.
- Death events fired by WCL inside a fight but after the tank's actual
  killing blow (e.g. release → re-die from AOE ticks, or log noise from a
  wipe) appear as successive deaths with 0 damage in the 5s window —
  those autopsies are correctly terse, not a bug.

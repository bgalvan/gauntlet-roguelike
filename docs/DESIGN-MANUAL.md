# DESIGN MANUAL — Untitled Co-op Roguelike
**Version 0.11 · Last updated 2026-08-04**

> **STATUS: CANONICAL.** This document supersedes `coop-roguelike-spec.md` (v0.1) and `coop-roguelike-loot-and-party-items.md`. Both are archived; their content is folded in below. This is the single source of truth.

---

## 0. MAINTENANCE PROTOCOL

**Read this section first on every session.**

- Every design element carries a status tag. Never remove a tag; change it.
  - `[LOCKED]` — decided by Bobby. Do not relitigate without being asked.
  - `[DEFAULT]` — Claude's proposal, standing until overruled. Safe to build on.
  - `[OPEN]` — unresolved. Flag it when relevant to the current discussion.
  - `[CUT]` — considered and rejected. Kept with the reason, so it isn't re-proposed.
- When Bobby decides something, promote the tag and add a changelog line in §12.
- When adding content (items, weapons, bosses), follow the existing table schema exactly. The schemas are the point — they make the content extensible without re-deciding format.
- Bump the minor version on any substantive change. Update the date.
- Contradictions are more dangerous than gaps. If new content conflicts with something existing, resolve it explicitly rather than letting both stand.

---

## 1. PILLARS `[LOCKED]`

1. **Four distinct silhouettes.** Identify each class by shape and screen effect alone.
2. **Loot is a group decision.** The interesting moment is "who should get this," not "I got this."
3. **Readable chaos.** Four players + 40 enemies + summons + projectiles must stay parseable. This is a hard constraint that vetoes features, not a nice-to-have. It has already constrained the Necromancer (§4).
4. **Runs end.** ~40 minutes. `[DEFAULT]`

---

## 2. RUN STRUCTURE

| Element | Value | Status |
|---|---|---|
| Floors | 8, in 4 acts of 2 | `[DEFAULT]` |
| Run length | ~40 min | `[DEFAULT]` |
| Rooms per floor | 8–14 + boss | `[DEFAULT]` |
| Bosses | 1 per floor, pool of ~12 | `[DEFAULT]` |
| Shop | After each boss except floor 8 | `[DEFAULT]` |
| Party size | 1–4 | `[LOCKED]` |
| Combat style | Real-time twin-stick | `[OPEN]` — dodge-roll/stamina variant undecided |
| Multiplayer scope | Online vs local vs both | `[OPEN]` — largest cost driver in the project |

**Acts:** I Crypt (1–2, teaching) · II Foundry (3–4, hazards) · III Sunken Halls (5–6, elites) · IV The Spire (7–8, two bosses, no shop before final)

**Floor anatomy:**
```
Entry → 8–14 combat rooms → [secret / challenge / treasure] → Boss → Shop → Descend
```

### Generation `[DEFAULT]`
- **Room-graph, not tile-noise.** Generate a node graph with a critical path plus 2–3 branches, populate each node from a hand-authored template library. Isaac feels good because the *rooms* are designed and the *layout* is random.
- Target library: ~150 templates (~40/act), tagged by act, enemy budget, and shape.
- Templates declare: door positions, spawn anchors with budget cost, hazard slots, and a **safe pocket** so four players can enter without instantly eating damage.
- **Doors lock during combat.** Keeps the party together; prevents one player speedrunning ahead.
- **Seeded runs from day one.** Trivial early, impossible to retrofit, enables dailies and races.

### Party scaling `[DEFAULT]`
Enemy count and boss HP at **100 / 165 / 220 / 270%** for 1–4 players. Not linear — four players are more than 4× as effective due to stunlock and cross-covering. Solo starts with one free revive.

### Camera `[DEFAULT]`
Shared dynamic camera that zooms to fit, plus a soft leash: players outside frame get a directional arrow and light damage-over-time until they return. Combined with locked doors this holds. Split-screen on separation is `[CUT]` — expensive and unreadable at four.

---

## 3. CLASS SYSTEM

### 3.1 Roster

| Class | Role | Status |
|---|---|---|
| Warrior | Melee DPS | `[LOCKED]` launch |
| Archer | Ranged DPS | `[LOCKED]` launch |
| Sorcerer | AoE / Control | `[LOCKED]` launch |
| Valkyrie | Frontline / Protection | `[DEFAULT]` launch |
| Necromancer | Summoner | `[LOCKED]` concept · `[DEFAULT]` unlock, not launch |
| Classes 6+ | — | `[OPEN]` post-launch |

**Recommendation on roster size (see §11 for the argument): ship 4 deep, not 6 shallow.** Build the class definition as data so adding one later is content work, not engineering work.

### 3.2 Differentiation levers
Each class must differ on **at least four** of these, not just damage numbers:
- Movement speed and acceleration
- Attack cadence — Warrior 0.5s · Archer 0.25s · Sorcerer 1.2s · Valkyrie 0.7s · Necromancer 0.9s
- Resource system — Warrior rage (built by hitting) · Sorcerer mana (regen) · Archer none (pure skill) · Valkyrie stamina (block) · Necromancer essence (from enemy deaths)
- Traversal — Warrior charge · Archer dash · Sorcerer blink · Valkyrie shield-plow · Necromancer swap places with a summon
- Relationship to pickups — Sorcerer sees secret rooms · Archer sees chest contents at range · Warrior gets more gold from kills · Valkyrie gets more from chests · Necromancer sees enemy health bars

---

### 3.3 Ability budget `[DEFAULT]`

**Three combat abilities beyond the basic attack, plus one context button.** Four inputs total.

The number is set by the mobile thumb budget (§16.5), which is the tightest constraint in the project. A right thumb comfortably fans across **3–4 buttons**; beyond that, either every button shrinks or the cluster intrudes on the movement thumb. Four also maps exactly to gamepad face buttons and sits naturally on keyboard.

| Slot | Contents | Notes |
|---|---|---|
| **1 — Traversal** | Warrior charge · Archer dash · Sorcerer blink · Valkyrie shield-plow · Necromancer summon-swap | **Always slot 1, every class.** Muscle memory transfers between classes, which directly lowers the cost of trying an unfamiliar one — that matters because party-composition variety is the locked retention strategy (§12.5). |
| **2 — Signature** | Valkyrie block · Necromancer Command · Sorcerer heavy spell · Warrior rage-spend cleave · Archer charged shot | The thing that *is* the class. Should be recognizable from across the room. |
| **3 — Payoff** | Gated by the class resource (rage / mana / stamina / essence) | Where the upgrade axes (§4) visibly cash out. Breakpoint transformations should be most legible here. |
| **4 — Context** | Pickup · transfer · revive · interact · claim | Not an ability. These never conflict — you are either standing on something or you aren't — so they share one input safely. |

**Conditional 5th slot:** rare **active items** get a dedicated slot that only appears when one is held. Standard pattern (Isaac's Q). Doesn't cost anything on runs where the slot is empty.

#### Slots 2 vs. 3 — the distinction is frequency and audience, not power

**Slot 2 is rhythm. Slot 3 is punctuation.**

| | Slot 2 — Signature | Slot 3 — Payoff |
|---|---|---|
| Answers | "What do I do *right now*?" | "We're in trouble" / "there's the opening" |
| Cadence | Every few seconds — part of the loop | 3–8 times per floor |
| Gate | Short cooldown, low or no cost | The class resource, built up over a fight |
| Scope | **About you** — your damage, your safety | **Often about the party** — openings, shields, crowd control |
| Upgrade interaction | Modified incrementally by the axes (§4) | Where breakpoint transformations should read loudest |

| Class | Slot 2 | Slot 3 |
|---|---|---|
| **Warrior** | Whirlwind — cleave in all directions, ~6s cooldown | Spend full rage → shockwave that staggers the room |
| **Archer** | Charged piercing shot | Volley — arrows rain over a chosen area |
| **Sorcerer** | Targeted heavy blast, moderate mana | Spend the pool → room-wide freeze or zone |
| **Valkyrie** | Directional block, held, drains stamina | Shield slam — knocks back the cone, briefly shields allies |
| **Necromancer** | Command — send / recall summons, free | Spend essence → detonate all summons, then resummon |

**The party-coordination point matters most.** Putting party-affecting effects on slot 3 makes it a *social* moment — "wait for my slam" is the kind of callout a co-op game wants, and it turns a resource bar into a shared clock. Slot 2 never needs a callout.

**Two tests for whether they're actually separated:**
1. If a player would happily press slot 3 as often as slot 2, you've built two signatures and one is redundant.
2. If slot 2 sits on a 20-second cooldown, it isn't a slot 2 — it's a second slot 3, and the class has no rhythm.

**Why not more.** Six abilities in a four-player room with forty enemies is where Pillar 3 dies — tracking six cooldowns while parsing that much screen is the failure point, not the button count itself. The game's depth already lives in items, upgrade axes, and weapon sidegrades; abilities do not need to carry it.

**Why not fewer.** Traversal consumes a slot on its own, so a two-ability class is really one ability plus a dash. Three is the minimum that yields traversal + identity + payoff.

**Cooldowns vs. resources:** slot 1 on a cooldown, slot 3 on the class resource, slot 2 either. Mixing both systems across all three slots creates tracking load for no design gain.

---

## 4. BI-DIRECTIONAL UPGRADES `[LOCKED]` concept

**Core:** each class upgrade presents two directions; the player picks one. The class evolves by accumulated choice.

### 4.1 The failure mode to design around

A repeated binary A/B produces **a slider, not a build.** If the Sorcerer picks AoE-vs-Power six times, the outcome space is just "how many points in AoE." Players find the optimal ratio in a week and stop deciding. Three fixes, all recommended together:

**1. Breakpoint transformations `[DEFAULT]` — the important one.**
Investment isn't linear. At **3** and **6** stacks in a direction, the class gains a *new behavior*, not a bigger number.
- Sorcerer, 3 AoE → blasts leave a lingering damage field. 6 AoE → fields chain between each other.
- Sorcerer, 3 Power → blasts pierce the first enemy. 6 Power → overkill damage detonates the corpse.

This converts a slider into a commitment. It's what makes the system produce builds.

**2. Rotating axis pairs `[DEFAULT]`.**
Not always the same two options. Each class has 4–5 axes; each upgrade draws one pair from that pool. Players can't precompute a fixed order, and the run generates its own shape.

**3. Capstone divergence `[DEFAULT]`.**
At 6 stacks the dominant direction offers a one-time class transformation with a name and a visual change. AoE Sorcerer becomes a zone controller; Power Sorcerer becomes a nuker. This is the moment players screenshot.

### 4.2 Axis pools

| Class | Axes `[DEFAULT]` |
|---|---|
| **Warrior** | Reach (arc width + range) ↔ Force (single-target damage) · Rage Generation ↔ Rage Capacity · Armor ↔ Aggression |
| **Archer** | Fire Rate ↔ Charge Damage · Pierce ↔ Multishot · Mobility ↔ Stability (damage while stationary) |
| **Sorcerer** | Blast Radius ↔ Attack Power · Cast Speed ↔ Mana Pool · Duration ↔ Burst |
| **Valkyrie** | Cone Width ↔ Absorption · Retaliation ↔ Endurance · Self ↔ Party (who the block protects) |
| **Necromancer** | Legion (more, weaker) ↔ Champion (fewer, stronger) · Summon Damage ↔ Summon Durability · Command ↔ Autonomy |

Reach ↔ Force and Blast Radius ↔ Attack Power are Bobby's original axes and are the model the rest follow.

### 4.3 Rules
- **Regret is real.** A wrong pick on floor 2 rides for 35 minutes. Add a rare **Reforge** shop item that flips one prior choice. Don't allow free respec — commitment is the mechanic.
- **Choices must be visible to the party.** Small branch indicator under each player's health bar. If the Sorcerer commits to AoE, the Warrior can go Reach to complement — that's the co-op layer this system unlocks, and it's free if the information is on screen.
- **Upgrade cadence:** ~1 per floor plus 1 per boss. 12–14 choices per run. `[DEFAULT]`

---

## 5. WEAPONS — SIDEGRADES `[LOCKED]` concept

**Core:** each class has multiple weapons with real pros and cons, not a power ladder.

### 5.1 Two rules that make this work

**Rule 1: A sidegrade must change the verb, not the numbers.**
If greatsword and spear differ by 12 damage vs 8, they're an upgrade ladder wearing a costume. The difference must be *what you do with it* — commitment, range, rhythm, safety.

**Rule 2: Weapons bias branches, they don't lock them.**
The spear naturally wants Reach. Taking Force on a spear should produce something weird but viable — a short-range lunge build. If a weapon *requires* a branch, you've built a linear path with extra steps.

### 5.2 Multiplication effect
This is where replayability comes from cheaply. **4 weapons × 3 axis pairs × breakpoints ≈ 20+ distinct play patterns per class** from a fraction of the content cost of a new class. This is the strongest argument for depth-over-roster in §11.

### 5.3 Warrior weapons `[DEFAULT]`

| Weapon | Verb | Pro | Con |
|---|---|---|---|
| **Greatsword** | Wide committed arc | High damage, hits crowds | Can't cancel the swing — you're locked in |
| **Spear** | Fast long poke | Safe, outranges most melee enemies | Low damage, thin hitbox, misses moving targets |
| **Dual Axes** | Rapid tiny slashes | Fastest rage generation, best DPS uptime | Almost no range, must be inside the danger |
| **Warhammer** | Slow heavy slam | Staggers and knocks back everything hit | Lowest DPS in the class — a control weapon |

### 5.4 Other classes `[OPEN]` — sketch only
- **Archer:** Longbow (charge/pierce) · Shortbow (rapid, low damage) · Crossbow (huge single shot, slow reload) · Sling (bouncing, unpredictable)
- **Sorcerer:** Staff (big slow blasts) · Orb (fast small bolts) · Tome (channelled beam) · Censer (persistent aura, no projectile)
- **Valkyrie:** Sword+Shield (balanced) · Tower Shield (huge cone, near-zero offense) · Spear+Buckler (block while attacking) · Banner (weak, but block grants allies buffs)

---

## 6. NECROMANCER `[LOCKED]` concept · `[DEFAULT]` implementation

**Bobby's concept:** weak personal attack, upgradable summons that follow him, summon type determined by wand.

**The wand-determines-summon idea is the strongest hook in the design.** It turns weapon choice into a class-identity choice — a bigger swing than any other class's weapon selection, and worth preserving even if the rest changes.

### 6.1 Wands `[DEFAULT]`

| Wand | Summons | Behavior | Tradeoff |
|---|---|---|---|
| **Bone Wand** | Skeletons (3–5) | Melee, swarm the nearest enemy | Cheap, numerous, die instantly to AoE |
| **Grave Wand** | Ghoul (1) | Tanky, slow, taunts nearby enemies | A single point of failure; useless if it dies |
| **Spirit Wand** | Wisps (2–3) | Ranged, float, pass through walls | Extremely fragile, but reach anything |
| **Plague Wand** | Carrion swarm (2) | No direct attack — applies rot, spreads on death | Zero burst; pure attrition, bad against bosses |

### 6.2 Three problems, with fixes

**Problem 1 — screen readability.** Four players plus 40 enemies plus 8 skeletons violates Pillar 3 outright. This is the biggest risk in the class.
> **Fix `[DEFAULT]`:** hard-cap summons at **4**, ever, under any combination of upgrades. Render them in the Necromancer's player color with a persistent outline and reduced opacity so they read as *not-enemies* at a glance. If it's still unreadable in the prototype, the class doesn't ship — that's the honest constraint.

**Problem 2 — networking cost.** Every summon is a networked entity with AI and pathing. A Necromancer meaningfully increases the entity count the network must sync, in a game that already has a hard netcode problem. Prototype the class *after* the networking decision, not before.

**Problem 3 — "watch the game play itself."** If the summons deal the damage, the player is a spectator with a management UI. That's the failure mode of every summoner class ever shipped.
> **Fix `[DEFAULT]` — make the wand bolt interact with the summons.** The Necromancer's attack is weak *against enemies* but **empowers a summon it passes through** (brief damage/speed buff), or **detonates** one for area damage. Now the player is aiming at their own minions. That's a genuinely novel verb, it keeps the hands busy, and it makes the "weak attack" fantasy honest instead of just underpowered.

Add a **Command** input (send summons to a location / recall) so positioning is player-driven, not purely AI. The Command ↔ Autonomy axis in §4.2 lets players tune how much micromanagement they want.

### 6.3 Death interaction
The Necromancer should have the deepest relationship with the death systems in §8 — likely the class that can consume ally Wraiths for power, or raise fallen enemies. `[OPEN]` — needs design, but it's the obvious thematic fit and shouldn't be left on the table.

---

## 7. LOOT DISTRIBUTION `[DEFAULT]`

### 7.1 The tension
Every co-op loot system gets two of: **speed**, **fairness**, **meaning**. Free-for-all sacrifices fairness. Personal loot sacrifices meaning. Need/greed sacrifices speed. **The escape is to stop applying one rule to everything.**

### 7.2 Tiered rules — friction proportional to stakes

| Item class | Rule | Rationale |
|---|---|---|
| Gold, hearts, keys, bombs | Free-for-all, touch pickup | High frequency, low stakes. Ceremony here is pure friction. |
| Class-specific upgrades | Auto-assign to eligible class | No debate is *possible*. Zero friction. |
| Universal items | Shared pedestal + skippable claim window | The only place the argument happens — which makes each one weighty. |
| Party items | Designated holder; group picks | Holder choice is the strategic decision (§9). |

Result: **6–10 real loot conversations per run instead of 60 trivial ones.** Scarcity makes them matter.

### 7.3 Required supporting mechanics
- **Hold-to-take (0.4–0.6s) on significant items.** Cheapest high-value fix in the design. Most co-op loot resentment is accidental pickup in a crowded room — a UX defect, not a design tradeoff.
- **Transfer verb.** Any player can drop a held item; any player can take it. Makes every decision reversible, which collapses the stakes of a bad call.
- **Visible holdings.** Item icons under each health bar. For *social pressure*, not information. Does more anti-griefing work than any hard rule, and hard rules punish friends more than griefers.
- **Class-weighted drops.** Never roll a Sorcerer item in a party with no Sorcerer.

### 7.4 Rejected
- **Personal loot `[CUT]`** — in a roguelike, items are build-defining, not incremental. Four private streams = four solo games in one room. Also contradicts Pillar 2.
- **Rotating priority / need-greed `[CUT]`** — MMO raid bureaucracy. Converts the fastest-feeling moments into administration.

### 7.5 Class-item scarcity — structural note `[OPEN]`
Class items as a fixed % of the pool scales badly: at 30% with 4 classes each class sees ~7.5% of drops; with 6 classes, ~5%. **Fix: make class items a separate drop channel** (dedicated chest type, or boss rewards) rather than a share of the universal pool. Then roster growth doesn't dilute anyone. Decide this before authoring the item pool.

---

## 8. DEATH SYSTEMS `[LOCKED]` direction

Bobby has explicitly endorsed items and mechanics that make death productive. This is a core identity, not a subsystem.

**Three stages `[DEFAULT]`:**
1. **Downed** — crawling, can't attack, bleeds out over 20s. Any ally revives with a 3s channel. Free.
2. **Dead** — becomes a **Wraith**: moves freely, can't be hurt, has one weak utility (slow enemies, reveal room contents). Still playing, weakly.
3. **Resurrection** — free at the next boss defeat, immediate at a shop shrine for gold, or via a rare revive item. Costs the score multiplier, not items.

**Total party wipe ends the run.** `[LOCKED]` — no compromise; the run needs stakes.

**Design rule:** any effect that scales with living players creates a death spiral — weakest exactly when already losing. **Deliberately stock inverting effects** that strengthen on death (§9). Target roughly a 2:1 ratio of scaling to inverting.

---

## 9. ITEMS

### 9.1 Pool composition `[DEFAULT]`
- **Universal** ~60% — usable by anyone. The contested tier. Design so *every* class wants them.
- **Class-specific** ~30% — see §7.5 re: drop channel.
- **Party items** ~10% — the differentiator. Rare and memorable.

**Tag every item from day one** (`fire`, `projectile`, `aura`, `on-kill`, `defensive`, `death`). Costs nothing now, enables named synergies later.

### 9.2 Party item principles
1. **It must cost someone something.** A pure party buff is a universal item with extra steps.
2. **Change positioning, not numbers.** The best co-op items make you move differently.
3. **Degrade gracefully on death, or invert.** See §8.
4. **Tune at ~1/3 potency.** Any per-player effect ×4. A +10% aura is a +40% party swing.
5. **Handle solo explicitly.** Don't drop, or define a solo mode. A dead drop is worse than no drop.

### 9.3 Party item catalog `[DEFAULT]`

**Redistribution**
| Item | Effect |
|---|---|
| Bloodbond | Damage taken splits evenly across living players |
| Quartermaster's Ledger | Gold pickups pay all living players at 60% |
| Tithe | Health taken at full HP routes to the most-injured ally |
| Chalice of Rot | You heal allies for the overheal you waste |

**Tethers & spatial** — *stock contradictory incentives on purpose; which you find defines the run*
| Item | Effect |
|---|---|
| Chain Lightning Tether | Visible arc between the two nearest players damages crossing enemies |
| Ironbound Pact | Within a short radius of an ally, both gain armor (clumping incentive) |
| The Long Rope | The two farthest-apart players each deal bonus damage (opposes Ironbound) |

**Conditional auras**
| Item | Effect |
|---|---|
| Standard Bearer | Holder grants +10% damage in radius, takes +15% themselves |
| Choir | Damage scales with living players in the room — *deliberate trap item* |

**Sacrificial** — *strongest category*
| Item | Effect |
|---|---|
| Martyr's Brand | Holder going down grants all allies 8s invulnerability |
| Blood Price | Holder spends own HP to instantly revive a downed ally at range |
| Effigy | On holder's death, a random ally is fully healed and gains permanent +1 damage |

**Comeback / inverting**
| Item | Effect |
|---|---|
| Vengeful Echo | +20% damage to living players per dead player |
| Wraith Conduit | Dead players can channel to grant a living ally a temporary buff |

**Handoff & combo**
| Item | Effect |
|---|---|
| Split Sigil | Drops as two halves held by two players; both effects end if either dies |
| Relay Charm | Transferring an item to an ally grants both a 10s damage buff |

---

## 10. SCORE, ECONOMY, SHOP

**Two currencies, kept separate `[DEFAULT]`.** If score buys things, players optimize for score and it stops measuring skill.
- **Gold** — spent, resets each run.
- **Score** — never spendable. Run-end rating and leaderboards.

```
Floor score = (kills × 10) + (rooms × 50) + (secrets × 200) + boss bonus (500 + time)
            × floor multiplier (floor number)
            × party multiplier (1.0 no deaths, ×0.8 per death this floor)
            × flawless bonus (×1.5 if no damage taken in the boss fight)
```

**Shop — 4 slots `[DEFAULT]`:** (1) universal item · (2) class item weighted to present classes · (3) consumable · (4) rotating special — resurrection shrine, reroll, **Reforge** (§4.3), health cap, or a curse (powerful item, permanent drawback). Prices scale with floor. Reroll cost escalates.

**Gold model `[DEFAULT]`:** individual gold with a **give** verb. Rewards generosity without enforcing it. Shared gold lets one player spend the party's money; fully individual gold makes helping impossible.

---

## 11. BOSSES

- **Every boss must have a job for each role.** Adds (Sorcerer), telegraphed heavies (Valkyrie), positional weak points (Warrior), a ranged phase (Archer).
- **Three phases minimum**, each changing the *movement pattern*, not just numbers.
- **No instant kills.** With a shared camera, unavoidable one-shots read as bugs.
- **Boss rooms larger than standard.** Four players need space.

*Example — The Gravewarden:* P1 melee-only, summons skeletons (Warrior/Valkyrie carry) → P2 armor breaks, gains ranged bone-throw, stops summoning (Archer carries) → P3 splits into three fast fragments (Sorcerer carries).

---

## 12. ROSTER SIZE — THE ARGUMENT `[LOCKED]`

**Decided: ship 4 classes deep. Roster growth is not the retention strategy** — see §12.5 for what is. Necromancer remains a post-launch unlock, not a launch class.

A new class is the most expensive content type in the game — unique animations, VFX, its own weapon set, its own class-item pool, balance against every other class, and boss encounters that account for it. Meanwhile §5.2 shows that **weapons × axes already generates 20+ play patterns per existing class** at a fraction of that cost.

The instinct that the game needs more classes is usually a symptom of classes being too shallow, and the branching-upgrade and weapon systems already fix that. Build class definitions as **data, not code**, so adding one later is content work.

**Unlock conditions `[DEFAULT]`: discovery, not grind.** "Reach floor 5 as a Sorcerer," "find the sealed sarcophagus." Isaac and Hades both do this well. Playtime-gated unlocks feel like homework.

---

## 12.5 REPLAY VALUE WITHOUT ROSTER GROWTH `[LOCKED]`

**Premise:** classes are a weak retention driver anyway. A new class buys N runs of novelty, then you're back in the same dungeon. The games with the longest tails don't lean on roster — they lean on the pool getting deeper and the ceiling getting higher.

Ranked by value per unit of cost:

### Tier 1 — reuses 100% of existing content

**1. Difficulty ladder (Heat / Ascension / Boss Cells).** The highest-ROI retention system in the genre. Hades, Slay the Spire, and Dead Cells all built hundreds of hours out of it with zero new content.
> **Do the Hades version, not the Isaac version:** players *choose which constraints to add* from a menu (enemies +40% HP, shop prices doubled, one fewer upgrade per floor, boss gains a phase, no revives). Difficulty becomes a build decision, and it pairs directly with the score system — higher constraints, higher multiplier.
>
> Co-op wrinkle nobody has exploited: the party negotiates the constraint set together before descending. That's a social ritual at the start of every session.

**2. Party composition as the primary variable.** *This is the replay engine single-player roguelikes structurally cannot have, and it's already free.*
> 4 classes × 4 slots with duplicates = **35 distinct party compositions.** Four Warriors is a genuinely different game from one-of-each: no ranged answer, no crowd clear, everything solved by walking into it. Layer weapons on top and it's effectively unbounded.
>
> Cost to exploit: **surface it.** Track compositions played, name the notable ones, and put per-composition leaderboards on the score table. "Best score as 4 Sorcerers" is a self-generating challenge list that costs one database filter.

**3. Seeded daily and weekly runs.** Seeded runs are already `[DEFAULT]` in §2. A daily seed with a global leaderboard means you and three friends race the same dungeon everyone else is racing. This is the single strongest *social* retention mechanic available and it's nearly free once seeding exists.

### Tier 2 — cheap content, high compounding

**4. Item pool unlocks.** Items enter the drop pool by being found once. The game gets **deeper**, not easier — the opposite of stat-based meta-progression, which makes early runs feel bad and late runs feel unearned. Target: ~40% of the item pool locked at first launch.

**5. Weapon unlocks.** Already planned in §5. Each new weapon multiplies against every axis pair. Cheapest per-hour-of-play content in the design.

**6. Score mastery as an explicit ladder.** The score system (§10) is currently a number. Make it a target list: per-floor records, per-composition records, flawless-boss tracking, speed tiers. Underused in the genre and the foundation already exists.

### Tier 3 — real cost, do later
Boss variants and alternate phase orders · a fifth act · challenge rooms with fixed loadouts · the Necromancer (§6).

### The principle
**Depth over breadth: the pool gets deeper and the ceiling gets higher, rather than the roster getting wider.** Roster growth also dilutes the class-item pool (§7.5) and multiplies balance surface. Every Tier 1 item above does the opposite — it makes existing content more valuable.

---

## 13. SCOPE — PROTOTYPE

**Build:** 2 classes (Warrior, Archer) · 1 act, 2 floors, ~25 templates · 1 boss · 15 items · 3 party items · one weapon each plus one alternate · one axis pair each · shared camera + locked doors · local multiplayer only.

**Party items to test:** Chain Lightning Tether (are spatial effects readable?), Standard Bearer (does holder-choice generate discussion?), Martyr's Brand (does sacrificial design feel heroic or punishing?).

**Questions the prototype must answer:**
1. Is the shared camera survivable with four players?
2. Does the tiered loot rule create fun arguments or real resentment?
3. Is a full room readable with four players' VFX on screen?
4. Does a single binary upgrade choice feel meaningful, or like a stat point?

If (4) is "stat point," breakpoints (§4.1) need to arrive earlier than stack 3.

**Networking:** four-player real-time action with hundreds of entities is likely a larger engineering cost than all content combined. Decide **deterministic lockstep vs. client-server with rollback** before writing gameplay code — retrofitting either is a rewrite. Local-first is a legitimate shipping strategy; Isaac shipped local co-op for years.

---

## 14. OPEN QUESTIONS

1. Multiplayer scope — online / local / both. **Blocks the Necromancer and the netcode architecture.**
2. Combat feel — pure twin-stick, or dodge-roll + stamina. Affects every class kit.
3. Run length — 40 min assumed.
4. Drop-in/drop-out mid-run?
5. Friendly fire — off by default, on as a difficulty modifier?
6. Engine and platform.
7. Class-item drop channel (§7.5) — decide before authoring the item pool.
8. Necromancer death interaction (§6.3).
9. Title.

---

## 16. PLATFORM & NETWORK ARCHITECTURE

> **DECIDED 2026-08-04 `[LOCKED]`:** Target **mouse+keyboard and gamepad**, delivered as a **web build**. Mobile is **deferred, not cancelled** — the mobile-derived constraints in §3.3, §16.5 and §17.3 are retained as design discipline, because keeping them costs nothing now and abandoning them is a one-way door.

### 16.0 Locked control mapping

Auto-target with tactical override survives unchanged (§16.5b) — the precision-tier argument still applies between a mouse and a gamepad stick, even with mobile out of scope.

| Function | Keyboard + Mouse | Gamepad |
|---|---|---|
| Move | WASD | Left stick |
| Basic attack | Automatic | Automatic |
| **Target override** | Cursor / LMB | Right stick flick |
| Slot 1 — Traversal | Space | A |
| Slot 2 — Signature | RMB | RT *(analog — supports held abilities like Valkyrie's block)* |
| Slot 3 — Payoff | Shift | RB |
| Slot 4 — Context | E | X |
| Active item (conditional) | Q | LB |

LT, Y, and the shoulder remainder stay free. **Do not spend them** — the four-input budget is what keeps a mobile port viable later.

**Bonus from this decision:** gamepad support *is* the mobile rehearsal identified in §16.5b. A pad is structurally closer to touch than a mouse is, so building for both inputs now means the mobile scheme is being continuously validated without any mobile work.


### 16.1 Bluetooth local co-op — not viable `[CUT]`

Bluetooth is the wrong transport, but the *goal* (local co-op, no server) is achievable. Reasons it fails:

- **Not a bandwidth problem.** Input-only lockstep (§16.3) is ~1 KB/s for four players, well within Bluetooth Classic. Bandwidth is not the blocker.
- **Platform APIs are the blocker.** iOS exposes peer-to-peer via **Multipeer Connectivity**; Android via **Nearby Connections**. Both work, both are native-only, and **they do not interoperate.** Cross-platform Bluetooth co-op means writing and maintaining two incompatible transports for one feature.
- **Web has no path at all.** Web Bluetooth is Chrome-only, absent from Safari, and is BLE-GATT-central only — a browser can talk to a heart-rate monitor, not to another phone acting as a game peer. A web build cannot do Bluetooth co-op under any configuration.
- **Pairing UX is hostile** for a four-device party game.

> **Use local WiFi instead.** Same-network play gives sub-5ms latency, ample bandwidth, cross-platform parity, and works in a browser. It delivers everything Bluetooth was wanted for.

### 16.2 Web viability — yes, with real constraints `[DEFAULT]`

A 2D sprite game of this scale runs fine on modern mobile browsers via WebGL2. Engine candidates: **Phaser** or **PixiJS** (small bundles, excellent mobile web), **Defold** (very good web export), **Construct 3**. **Godot 4 web export is not recommended for mobile** — large WASM bundles and persistently shaky iOS Safari behavior.

**Web upside for a party game is large:** no store fees, no review cycle, no install friction, and the invite is a URL. That last point matters more than it sounds for a game whose whole premise is getting four people playing together.

**Constraints to design around:**
- iOS allows only one browser engine, so **Safari is the floor**, not Chrome. Test there first.
- PWA install on iOS is second-class; no reliable fullscreen guarantee.
- No store discovery and no easy monetization path.
- **Escape hatch:** build web-first, wrap with Capacitor later for store distribution without a rewrite.

### 16.3 Transport — WebRTC DataChannel, lockstep `[DEFAULT]`

WebRTC DataChannels are the only peer-to-peer option in a browser. Topology: **full mesh** — 4 players is 6 connections, trivial at this scale.

**Use deterministic lockstep, not state sync.** Sync ~4 player inputs per frame instead of hundreds of entity states. Bandwidth drops by orders of magnitude, and the game is *already seeded and procedural*, so determinism is a natural fit. On a LAN the latency penalty is negligible.
- **Cost:** any nondeterminism (float drift, iteration order, `Math.random`) desyncs the whole party. Requires discipline — fixed-point or carefully-controlled float math, a seeded PRNG for everything, deterministic entity iteration order.
- **Cost:** one laggy player stalls everyone. Acceptable on LAN, painful over the internet.
- If internet play becomes a priority later, revisit — host-authoritative with rollback is the better fit there.

### 16.4 Backend cost — effectively zero `[DEFAULT]`

WebRTC peers cannot find each other without a **signaling server**, but signaling is tiny: a handful of SDP/ICE messages per player, only at connect time, then the server is out of the loop entirely.

**Recommended: Cloudflare Workers + a Durable Object as the signaling room.** Bobby already works in Workers, so this is existing expertise rather than new infrastructure.
- <cite index="6-1">The Workers Free plan includes 100,000 Durable Object requests per day and 13,000 GB-s of duration daily</cite>, and <cite index="3-1">SQLite-backed Durable Objects are available on the Workers Free plan</cite>. A signaling session costs perhaps 20–40 requests. This is free at any plausible scale for a long time.
- <cite index="6-1">WebSocket messages bill at a 20:1 ratio — 100 incoming messages count as 5 requests</cite>, which makes signaling cheaper still.
- Use the **WebSocket Hibernation API** so idle lobby connections don't accrue duration charges.

**NAT traversal:** STUN is free (public servers exist). **TURN relays all traffic and costs real bandwidth money** — but TURN is only needed when peers can't connect directly, which **does not happen on a shared LAN**. Local co-op needs no TURN. Internet play would need it for roughly 10–20% of connections; that's the one line item that would ever cost money.

**Persistence:** local device storage (IndexedDB) for unlocks and settings. Leaderboards, if wanted, fit inside the same free Workers tier with D1.

> **Verdict: local co-op, web-based, with no meaningful backend cost, is achievable.** The signaling Worker is the only server-side component and it is free at this scale.

### 16.5 The actual hard problem — controls and camera `[OPEN]`

**Mobile is not a port decision; it is a redesign decision.** Networking is the easy part. Two systems in this manual break on a phone:

**1. Twin-stick controls — correction to v0.5, which overstated this.** Virtual twin-stick on a phone is a **standard, shipped pattern**: Call of Duty Mobile, PUBG Mobile, Brawl Stars, and Soul Knight all do it. Both thumbs on sticks works, and **floating sticks** (the stick origin spawns wherever the thumb lands rather than sitting at a fixed spot) solve most of the drift and reach problems. Occlusion is real but confined to the bottom corners, which is a small share of a modern tall screen.

**The actual cost is not the sticks — it's that they consume both thumbs, leaving nowhere for ability inputs.** This design currently needs: attack, a traversal ability (charge / dash / blink / plow), Valkyrie's block, Necromancer's Command, item pickup, and item transfer. With both thumbs pinned to sticks there is no free digit for any of them. That's the real constraint, and it's a design problem rather than an ergonomic one.

Secondary costs: aiming precision is meaningfully lower than a stick or mouse, so hitboxes must grow and projectiles must slow; and two thumbs pinned for a 40-minute run causes genuine fatigue.

**Three viable control models `[OPEN]` — pick one before the prototype:**

| Model | Layout | Gains | Loses |
|---|---|---|---|
| **A. True twin-stick** | Both thumbs on floating sticks; abilities on small buttons near the right thumb | Full aim expression; Necromancer's summon-bolt verb survives | Every ability press costs aim; fatigue on long runs |
| **B. Auto-aim + abilities** *(reference: Soul Knight — a mobile co-op roguelike, the closest comparable)* | Left stick moves; auto-target handles aim; right thumb is a button cluster | Abilities stay first-class; low fatigue; forgiving | Aim as a skill axis disappears |
| **C. Survivors-like** | One thumb, movement only, everything automatic | Trivially playable one-handed; enormous mobile audience | A different genre; most class kits collapse |

**Recommendation: Model B.** The bidirectional upgrades (§4) and weapon sidegrades (§5) express through *behavior*, not aim, so they survive auto-targeting fully intact — while abilities, which are what actually distinguish the classes moment-to-moment, keep a dedicated thumb. Model A remains viable if aim is judged essential; it costs an ability slot.

The Necromancer's "aim the bolt through your own summon" verb (§6.2) survives only under Model A. Under B it needs redesign — most likely a targeted Command that empowers the nearest summon instead.

### 16.5b Cross-input parity — the real question `[DEFAULT]`

WASD+mouse is unquestionably the best *desktop* scheme, and it's what Isaac, Hades, and Gungeon use on PC. But choosing it surfaces the actual problem, which is not "which input scheme" but:

> **Does aim skill affect outcomes?**

That's a balance question with one answer for the whole game, because precision comes in three tiers — **mouse > gamepad stick > touch stick** — and if aim matters, hardware silently imposes three difficulty levels. Balance for mouse and touch is unplayable; balance for touch and mouse aim is wasted.

**Observation: this game's classes already don't want precision.** Warrior swings a wide arc. Sorcerer aims at a cluster, not a pixel. Valkyrie points a block cone. Three of five classes are *directional*, not precise. Only the Archer genuinely wants pixel aim, and the Necromancer's designed verb.

**Resolution — separate direction from precision.** They are not the same input problem. Aiming at a moving target's center of mass needs precision; pointing a dash, cone, or blast in a general direction does not. Directional input works equally well on mouse, stick, and thumb.

| Layer | Design | Parity |
|---|---|---|
| Basic attack | **Auto-target**, nearest or facing | Identical on all inputs |
| **Target override** | Point / flick / tap to pick a *different* target than the auto-pick | Identical on all inputs |
| Abilities | **Directional** — dash, cone, blast, throw | Identical on all inputs |
| Positioning & spacing | The primary skill | Identical on all inputs |

The target override is the important piece. It is a **tactical choice, not a precision test** — auto-target grabs the nearest enemy, the override lets you focus the summoner across the room. That gives mouse players real agency without creating a power gap, because a tap or a flick expresses it just as well as a cursor.

This also keeps §10 and §12.5 honest: leaderboards stay comparable across platforms. Ship **separate leaderboards per input class** anyway as cheap insurance.

**Rejected:** manual aim granting bonus damage or weak-point hits `[CUT]` — it directly recreates the three-tier disparity it was meant to solve.

**Free early-warning system: support gamepad on desktop from day one.** A gamepad is closer to touch than a mouse is, so it rehearses the mobile scheme years early. If the game feels good on a pad, it will feel good on a phone. If it only feels good with a mouse, mobile is already in trouble and you'll know in Phase 1 instead of Phase 3.

**2. Shared camera (§2).** On a phone, a camera zoomed to fit four players makes each character a few pixels tall. Directly violates Pillar 3.
> **But mobile inverts this into an advantage:** four players on four phones means **four independent cameras**. The shared-camera problem disappears entirely — nobody has to share a frame. It's strictly better than couch co-op on this axis.
>
> **What it costs:** the locked-door and soft-leash design (§2) exists to keep four players in one frame. With per-device cameras that rationale evaporates and party cohesion needs a new mechanic — proximity bonuses, shared health, or objectives that require multiple players in a room.

**3. Session length.** 40 minutes (§2) is long for phone play. Either shorten runs or add per-floor save-and-resume — which is genuinely hard with four players who must all return.

### 16.6 Decision required
Mobile-web-first and PC-desktop-first produce **different games**, not different builds. The controls question cascades into class design, the camera question cascades into level design, and both need answering before the prototype in §13. This now blocks more than the online-vs-local question in §14.

### 16.7 Online co-op — what it actually costs `[DEFAULT]`

**In dollars: close to nothing. The real costs are not financial.**

**Why hosting stays cheap.** Online P2P is normally expensive because relayed state sync is bandwidth-heavy. **Lockstep collapses that.** At roughly 1 KB/s per player, a 40-minute session is ~10 MB of traffic total. Even if every session were relayed through TURN, that is cents per thousand sessions.

| Component | Needed for online? | Cost |
|---|---|---|
| Signaling (Workers + Durable Object) | Yes | Free tier, comfortably |
| STUN (NAT discovery) | Yes | Free — public servers |
| TURN (relay when P2P fails) | Sometimes | The only real line item — and tiny under lockstep |
| Matchmaking service | **Only for random matchmaking** | Avoid it: friend-invite-by-URL needs no lobby backend |
| Leaderboard storage | Optional | Free tier (D1) |

**The catch worth knowing: mobile networks are the worst case for TURN.** Carrier-grade NAT is pervasive on cellular, so phone-to-phone over mobile data falls back to relay far more often than desktop-to-desktop — plausibly well above the ~10–20% typical elsewhere. It stays cheap because the payload is small, but plan for relay as the common path rather than the exception.

**The costs that aren't money:**
1. **Latency, and it's the serious one.** Lockstep means every player waits for the slowest. A 100 ms ping is 100 ms of input delay *for everyone*, every frame. Fine on a LAN, bad for an action game over the internet. Real online play needs **rollback netcode**, which is a substantial engineering project and must be architected up front — it cannot be retrofitted.
2. **Cheating.** Pure P2P has no authority; any client can be modified. This makes the score leaderboards (§10, §12.5) trivially forgeable, which undercuts the retention strategy that was just locked in §12.5. Mitigations — host validation, replay verification from the seed — all require a real backend.
3. **Free tiers hold until success.** Everything above is free at prototype and early-launch scale. A hit exceeds it. That's a good problem, but it means "free forever" is not the claim.

> **Summary:** local co-op is genuinely free. Online co-op is *nearly* free to host, but costs a rollback netcode implementation and gives up verifiable leaderboards. Decide based on engineering budget, not hosting budget.

---

## 17. DEVELOPMENT & RELEASE PATHWAY `[DEFAULT]`

### 17.1 The strategy in one line
**Design under mobile's constraints. Ship on desktop first.**

Desktop-first is right for iteration speed, promotion, and testing. The failure mode is *designing* desktop-first — building around six simultaneous inputs and a 27-inch screen, then discovering mobile can't hold it. That turns the mobile version into a redesign (§16.5) instead of a port.

If the control model is chosen for mobile's limits, desktop becomes a **superset**, not a conflict:

| Input | Mobile | Gamepad | Keyboard |
|---|---|---|---|
| Move | Left floating stick | Left stick | WASD |
| Abilities ×3–4 | Right thumb cluster | Face buttons | 1–4 / Space |
| Attack | Auto-target | Auto-target (or right stick) | Auto-target (or mouse) |

Same abstract input state everywhere. Desktop just gets more precision.

### 17.2 Web is the whole point
A web build **is** the mobile build. Same codebase, same engine, same renderer — only the input layer and layout change. This is the single largest cost saving available and the strongest argument for Phaser/PixiJS over a native engine. Do not fragment into two codebases.

### 17.3 Five things to do now so mobile isn't a rewrite

1. **Input abstraction layer, from the first commit.** Game code never reads a key or a touch. It reads an abstract state (`moveVector`, `ability[0..3]`, `confirm`). Touch then becomes one new module instead of a refactor of everything. Cheap now, brutal later.
2. **Set the performance budget to mobile, not desktop.** Cap entity counts, particles, and draw calls at mobile-viable numbers *from the start*. Building to desktop's budget and cutting later means gutting content that's already designed and balanced. This is the one that most often forces a mobile version to be abandoned.
3. **Resolution-independent UI.** No hardcoded pixel positions. Assume anything from a 5.4" phone to a 27" monitor.
4. **Build bot players early.** See §17.5 — this is the difference between testing co-op weekly and testing it daily.
5. **Validate readability at phone size on desktop.** Run the game in a window at phone dimensions. Free, catches most readability failures years before you own four test devices.

### 17.4 Staged pathway

| Phase | Build | Purpose |
|---|---|---|
| **0 — Prototype** | Desktop web, keyboard, 2 players local | Answer the four questions in §13 |
| **1 — Vertical slice** | Desktop web + gamepad, 4 players (four pads on one machine), LAN via WebRTC | Prove the co-op core; playable build on **itch.io** for early feedback |
| **2 — Promotion** | Steam page + demo (native wrapper via Tauri/Electron; $100 Steam Direct) | **Wishlists are the currency.** Steam Next Fest is the real promotion engine for indie roguelikes. Discord community is essential — a co-op game needs groups of four to test. |
| **3 — Mobile layer** | Same codebase, touch input, responsive layout | Device testing begins here, not before |
| **4 — Mobile release** | Web-playable + optional Capacitor store builds | — |

### 17.5 Yes, mobile testing takes substantially longer — roughly 2–3×

Ranked by actual impact:

1. **You cannot test four-player co-op alone.** On desktop, four windows and four gamepads on one machine is a solo test. On mobile it requires **four physical phones and, realistically, four people.** Every co-op test becomes a scheduling problem. This dwarfs every other factor.
   > **Mitigation — build bot players.** AI-controlled party members let one person on one device test four-player behavior. Worth building in Phase 0 purely as testing infrastructure; it also gives solo players a party mode later.
2. **Device fragmentation.** Desktop is a handful of browsers. Mobile is hundreds of device/OS/screen/GPU combinations with wildly different performance.
3. **Thermal throttling and battery.** A 40-minute run heats a phone and performance degrades over the session — a failure class that does not exist on desktop and that only appears in long real-device tests.
4. **Touch tuning is slow and subjective.** Deadzones, button sizes, thumb reach across screen sizes. Weeks of iteration that cannot be shortcut or automated.
5. **iOS Safari is the hardest target and the least debuggable.** Requires a Mac plus Safari Web Inspector, and it has the strictest limits of any browser you'll ship to.

**Practical consequence:** budget mobile as its own phase with its own timeline, not as a two-week port at the end. The five items in §17.3 are what keep that phase to weeks rather than months.

---

## 18. CHANGELOG

**v0.11 — 2026-08-04**
- **Platform decision `[LOCKED]`:** mouse+keyboard and gamepad, web build, desktop-first. Mobile deferred, not cancelled.
- Added §16.0 locked control mapping for both inputs. Four-input budget retained deliberately.
- Auto-target + tactical override confirmed unchanged; the precision-tier argument holds between mouse and stick.
- Moving to implementation. Next artifact: Phase 0 skeleton per §17.3 — input abstraction layer, seeded PRNG, fixed-timestep loop.

**v0.10 — 2026-08-04**
- Sharpened §3.3 slots 2 vs 3: separated by frequency and audience rather than power. Slot 2 is personal rhythm on a short cooldown; slot 3 is resource-gated, party-affecting, and a coordination callout. Added per-class examples and two separation tests.

**v0.9 — 2026-08-04**
- Added §3.3 ability budget: three combat abilities (traversal / signature / payoff) plus one shared context button, with a conditional fifth slot for rare active items. Number derived from the mobile thumb budget.

**v0.8 — 2026-08-04**
- Added §16.5b cross-input parity. Reframed the control question as "does aim skill affect outcomes," since precision tiers (mouse > stick > touch) would otherwise impose hardware-based difficulty.
- Resolution: separate direction from precision. Auto-target basic attacks, directional abilities, plus a target-override that is tactical rather than precision-based. Aim-for-bonus-damage `[CUT]`.
- Gamepad support on desktop from day one, as an early rehearsal of the mobile scheme.

**v0.7 — 2026-08-04**
- Added §17 development & release pathway. Core principle: design under mobile constraints, ship desktop first, so mobile is a port rather than a redesign.
- Five architectural commitments (§17.3) that keep the mobile phase to weeks: input abstraction, mobile-first performance budget, resolution-independent UI, bot players, phone-size readability checks on desktop.
- Confirmed mobile testing runs ~2–3× desktop, dominated by the four-physical-devices problem. Bot players identified as the mitigation, to be built in Phase 0.

**v0.6 — 2026-08-04**
- **Correction:** §16.5 overstated the case against mobile twin-stick. It is a shipped, standard pattern. Rewritten with three control models; the real constraint is thumb availability for abilities, not the sticks. Model B (auto-aim + ability cluster) recommended.
- Added §16.7 honest online cost breakdown: hosting is near-free under lockstep, but online costs rollback netcode and verifiable leaderboards.

**v0.5 — 2026-08-04**
- Added §16 platform & network architecture. Bluetooth co-op `[CUT]` with reasoning; local WiFi + WebRTC lockstep recommended.
- Confirmed near-zero backend cost via Cloudflare Workers signaling on the free tier.
- Flagged §16.5: mobile is a redesign, not a port. Controls and camera cascade into class and level design, and now block the prototype.

**v0.4 — 2026-08-04**
- Bobby approved the depth-over-breadth direction. §12 and §12.5 promoted to `[LOCKED]`.
- Roster growth is formally off the table as a retention strategy. Necromancer stays a post-launch unlock.

**v0.3 — 2026-08-04**
- Added §12.5 replay value without roster growth: difficulty ladder, party composition as primary variable (35 compositions), seeded dailies, pool unlocks, score ladder.
- Established depth-over-breadth as the retention principle.

**v0.2 — 2026-08-04**
- Established this as canonical; folded in spec v0.1 and the loot deep-dive.
- Added §0 maintenance protocol and status tagging.
- Added §4 bi-directional upgrades, with the slider-vs-build failure mode and three fixes.
- Added §5 weapon sidegrades, with the two design rules and the multiplication argument.
- Added §6 Necromancer, with three problems and fixes; capped summons at 4.
- Added §12 roster-size position (depth over breadth).
- Flagged §7.5 class-item drop-channel problem.

**v0.1 — 2026-08-04**
- Initial spec: pillars, classes, run structure, loot models, party items, score, bosses.

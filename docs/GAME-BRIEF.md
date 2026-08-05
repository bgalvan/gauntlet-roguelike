# GAME BRIEF
*Untitled 4-Player Co-op Roguelike · v0.2 · August 2026*

---

## The Pitch

Four heroes descend through a procedurally generated dungeon. Every floor is a fresh layout, every chest is a decision, every floor ends in a boss. **Gauntlet's arcade party chaos, with Binding of Isaac's build variety, and a score that actually means something.**

The hook nobody else has: **it's built co-op-first.** The roguelike genre is full of brilliant single-player games with multiplayer bolted on. This one is designed from the loot rules up around four people in a room together — including items that only make sense with a party, and a death system that turns dying into something the team can use.

---

## The Loop

```
Enter floor → clear 8–14 rooms → open chests, argue over items,
pick your upgrade path → fight the boss → spend gold at the shop
→ descend → it gets harder
```

**8 floors. About 40 minutes. Then you die and do it again differently.**

---

## The Classes

Five classes. Four at launch, one unlockable.

| | Role | The fantasy |
|---|---|---|
| **Warrior** | Melee damage | Wades in. Wide arcing cleave, highest damage, gets stronger the more enemies he's swinging through. |
| **Archer** | Ranged damage | Fastest attacks, best single-target and boss damage, dies if anything touches her. |
| **Sorcerer** | Area control | Slow, heavy spells that delete crowds and freeze rooms. Helpless alone against a boss. |
| **Valkyrie** | Frontline | Shield-bash and a directional block that stops projectiles for everyone behind her. Lowest damage, keeps everyone alive. |
| **Necromancer** *(unlock)* | Summoner | Weak attack, but a pack of undead follows him. His wand determines what he raises. |

---

## Three Systems That Define the Game

### 1. You choose how your class evolves

Every upgrade offers **two directions, and you pick one.**

- Sorcerer: *bigger blast radius* or *more attack power*
- Warrior: *reach* or *raw slash force*
- Necromancer: *more summons* or *stronger summons*

Pick the same direction three times and your class doesn't just get better numbers — it **changes behavior.** Three points in blast radius and your spells start leaving lingering fields. Three in power and they pierce. Six and you get a named transformation.

Twelve to fourteen choices per run. No two Sorcerers come out the same.

### 2. Weapons are sidegrades, not upgrades

Each class has multiple weapons that are genuinely different — not better and worse.

The Warrior's **greatsword** hits wide and hard but locks you into the swing. The **spear** is safe and long but thin and weak. **Dual axes** are lightning fast with almost no range. The **warhammer** does the least damage in the class and staggers everything it touches.

The Necromancer's wands are the clearest version: **the wand decides what you summon.** Bone wand raises a swarm of fragile skeletons. Grave wand raises one tanky ghoul that taunts enemies. Spirit wand summons wisps that pass through walls. Plague wand raises a carrion swarm that deals no direct damage but spreads rot on death.

Weapons × upgrade paths gives roughly **20 distinct ways to play each class.**

### 3. Dying is a resource

Most co-op games punish the team when someone goes down and then punish them again by making them watch. This one doesn't.

When you die you become a **Wraith** — you keep moving, you can still slow enemies and reveal rooms, and you come back free at the next boss. And a whole category of items makes your death *useful to the team*:

- **Martyr's Brand** — when you go down, your allies get 8 seconds of invulnerability
- **Effigy** — your death fully heals an ally and permanently buffs them
- **Vengeful Echo** — everyone still alive hits 20% harder for each player who's dead

Sometimes tanking the boss phase and dying on purpose is the right play. That's a thing you can do in this game.

---

## Loot: Who Gets the Item?

The core co-op problem nobody solves well. The answer here is **friction proportional to stakes:**

- **Gold, health, keys** — grab them, no ceremony
- **Class-specific upgrades** — auto-assigned; the Archer can't use a Sorcerer's staff anyway
- **Universal items** — go on a pedestal. Everyone gets a moment to call it or wave it off.
- **Party items** — the group picks who carries it, and that choice matters

Six to ten real conversations per run instead of sixty trivial ones. Plus a **transfer** button, so a bad call is always fixable.

---

## Party Items — the differentiator

Items that only exist because there are four of you:

- **Bloodbond** — damage is split across everyone still alive
- **Chain Lightning Tether** — a visible arc between the two nearest players damages anything crossing it
- **Ironbound Pact** — stand close to an ally, both get armor
- **The Long Rope** — the two players *farthest apart* both hit harder

Note the last two contradict each other on purpose. Which one you find changes how the whole party moves for the rest of the run.

---

## Score

Two currencies, kept apart. **Gold** buys things and resets each run. **Score** buys nothing and is the permanent record — kills, rooms, secrets, boss times, deaths, flawless bonuses. The arcade number in the corner going up is its own reward, and it means something on a leaderboard because you can't buy it.

---

## Scope

**Prototype — prove the core.**
Two classes (Warrior, Archer), one act, one boss, 15 items, local four-player. Ugly on purpose.

*It exists to answer four questions:* Is a shared camera survivable with four players? Does the loot rule create fun arguments or real resentment? Is a full room readable with four players' effects on screen? Does a binary upgrade choice feel meaningful or like a stat point?

**Vertical slice.** Four classes, two acts, four bosses, two weapons each, full loot tiers.

**v1.0.** Eight floors, four classes, ~150 room templates, ~12 bosses, full item pool, unlockable Necromancer.

---

## The Big Unknowns

| | Why it matters |
|---|---|
| **Online or local?** | Four-player real-time netcode with hundreds of entities likely costs more than all the content combined. Local-first is a legitimate strategy — Isaac shipped that way for years. |
| **Combat feel** | Pure twin-stick, or twin-stick with a dodge-roll and stamina? Changes every class. |
| **Engine and platform** | Drives the networking answer and the art pipeline. |
| **Title** | Still needed. |

---

## Why This Could Work

The roguelike genre is crowded and the co-op roguelike genre is nearly empty. Isaac, Hades, Dead Cells, and Gungeon are all single-player games at heart. Nobody has built a real design language for **items that only make sense with a party**, or for **death as a shared tactical resource**, or for **loot rules that make the group argument the fun part instead of the friction.**

That's the space. It's small, it's underexplored, and it's defensible.

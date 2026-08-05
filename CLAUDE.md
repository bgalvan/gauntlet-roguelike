# CLAUDE.md

## Project

A 4-player co-op roguelike — Gauntlet-style party action with Binding of Isaac-style procedural floors. Web build (desktop-first), mouse+keyboard and gamepad.

## Design documents

- `docs/DESIGN-MANUAL.md` — **canonical source of truth.** Long. Do not load it wholesale every session. Read the relevant section when working on that system, and read §0 (maintenance protocol) before editing it.
- `docs/GAME-BRIEF.md` — human-readable summary. Keep in sync when major decisions change, but the manual leads.

Design elements carry status tags: `[LOCKED]` (decided by Bobby — do not relitigate), `[DEFAULT]` (standing proposal, safe to build on), `[OPEN]` (unresolved — flag it), `[CUT]` (rejected, with reason — do not re-propose).

When a design decision is made in a session, update the manual and add a changelog entry in the final section. Bump the version.

## Stack

- **Engine:** Phaser (2D, WebGL) — chosen for mobile-web portability later
- **Language:** TypeScript
- **Target:** browser, desktop-first
- **Networking (later phases):** WebRTC DataChannel, deterministic lockstep, signaling via Cloudflare Workers + Durable Object

## Hard constraints — violating these causes rewrites, not bugs

1. **Input abstraction is mandatory.** Game code never reads a key, mouse, or gamepad directly. It reads an abstract input state (`moveVector`, `targetOverride`, `ability[0..3]`, `contextAction`). Backends for M+K and gamepad feed that state. A touch backend is added later without touching game code.

2. **Four-input budget.** Three combat abilities plus one context button. Do not add a fifth binding even though keyboard and gamepad have room — the budget is what keeps a mobile port viable. See manual §3.3.

3. **Determinism.** Lockstep netcode requires it later, and retrofitting is a rewrite.
   - Fixed timestep simulation, decoupled from render.
   - **All randomness comes from a single seeded PRNG.** Never `Math.random()`. Ever.
   - Deterministic entity iteration order — no reliance on object key order or set iteration.
   - Be deliberate about float accumulation.

4. **Mobile-scale performance budget.** Cap entity counts, particles, and draw calls at numbers a mid-range phone could sustain — even though we ship desktop first. Building to desktop's budget and cutting later means gutting balanced content.

5. **Resolution-independent UI.** No hardcoded pixel positions.

6. **Auto-target, not manual aim.** Basic attacks auto-target. The mouse/right-stick provides *target override* — choosing a different enemy — not aiming precision. Manual aim granting bonus damage is `[CUT]`; see manual §16.5b.

## Conventions

- Seeded runs from the start — every run reproducible from a seed.
- Room templates are hand-authored data, not procedurally generated geometry. The *layout graph* is random; the *rooms* are designed.
- Bot players are testing infrastructure, not a stretch goal. Build them early — co-op cannot be tested solo without them.

## Current phase

**Phase 0 — prototype skeleton. DONE.** Fixed-timestep loop · input abstraction with M+K and gamepad backends · seeded PRNG · one room with movement and auto-attack. Determinism harness and bot party added on top.

**Phase 1 — combat foundation. DONE.** Collision, an Act I melee enemy with a telegraphed wind-up, waves with §2 party scaling, and the §8 death system (stages 1–2).

**Phase 2 — classes, abilities and feel. DONE.** Four launch classes as data (§3.1), all twelve abilities, per-class resources, projectiles, knockback and stagger, a class-select screen, and the presentation layer — silhouettes, particles, screen shake, damage numbers, synthesized audio.

**Phase 3 — floors, doors and the shared camera. DONE.** Hand-authored room templates, a seeded layout graph with a critical path plus branches, doors that lock during combat, room transitions, the §2 shared camera, and the soft leash.

Still absent, in rough dependency order: items and the upgrade axes (§4) · weapon sidegrades (§5) · an actual boss entity (§11 — the arena exists, it currently holds an oversized wave) · the shop and score economy (§10) · treasure and secret rooms · act 2+ templates and hazards · the Necromancer (post-launch unlock per §3.1).

**Ask before expanding scope past the current milestone.**

## Commands

| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `npm run dev` | Vite dev server with HMR — http://localhost:5173 |
| — | In dev, `window.__game` exposes the Phaser game for console inspection (`__game.scene.getScene('game').world`). Stripped from production builds. |
| `npm test` | Determinism harness — headless, no browser |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm run build` | Typecheck, then production bundle to `dist/` |
| `npm run preview` | Serve the built `dist/` locally |

No linter yet — TypeScript is in strict mode with `noUnusedLocals`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`, which covers most of what a linter would catch at this size. Add ESLint when it starts earning its keep.

**Toolchain:** Vite 8 · TypeScript 7 · Phaser 4.

## Layout

```
src/
  core/        constants · rng · fixed-loop · checksum      — engine-agnostic
  input/       input-state · input-manager · backends/{keyboard-mouse,gamepad}
  game/        world · classes · abilities · targeting · collision
               controller · bot · life-state · events
               rooms/{templates,floor}                     — §2 generation
               entities/{entity,player,enemy,projectile}   — no Phaser, no DOM
  render/      silhouette · particles · audio · camera     — render-only helpers
  scenes/      select-scene · game-scene                   — Phaser-aware
test/
  determinism.ts                                           — run with `npm test`
```

**The rule that keeps constraints #1 and #3 honest:** `src/game/` and `src/core/` import no Phaser and read no DOM. The simulation runs headless; the scenes render it. Input crosses the boundary only as `InputState`. If an `import Phaser` ever appears under `game/`, something has gone wrong.

## Classes and abilities (§3)

Class definitions are **data**, in `src/game/classes.ts` — §3.1 asks that adding a class be content work, not engineering. A `ClassDef` carries the §3.2 levers (HP, move speed, attack cadence, range, attack style, resource) plus exactly three `AbilityDef`s. The tuple is fixed-length by type, which is how constraint #2's four-input budget is enforced at compile time.

Ability *behaviour* is keyed by id in `src/game/abilities.ts`. A new class reusing existing ability kinds touches only `classes.ts`.

| | Warrior | Archer | Sorcerer | Valkyrie |
|---|---|---|---|---|
| Resource | Rage (on hit) | none | Mana (regen) | Stamina (drains) |
| 1 Traversal | Charge | Dash | Blink | Shield Plow |
| 2 Signature | Whirlwind | Charged Shot | Heavy Blast | Block *(held)* |
| 3 Payoff | Shockwave | Volley | Deep Freeze | Shield Slam |

**Known contradiction, flagged not resolved:** §3.2 gives the Archer no resource ("pure skill"), but §3.3 says slot 3 is resource-gated. The Archer's payoff runs on a long cooldown instead. Bobby's call.

Bots use all twelve. `checkAllAbilitiesFire` asserts it — three of four classes would otherwise be untested, and untested is where every bug so far has lived. Bots also **hold their resource when the room already warrants the payoff**; without that rule the signature drained the pool on cooldown and Deep Freeze and Shield Slam literally never fired.

## Floors, rooms and doors (§2)

`generateFloor` builds a node graph on a grid: a critical path of 8–12 rooms plus 2–3 branches, then a boss arena at the end. Each node draws a **hand-authored template** from `rooms/templates.ts` — the layout is random, the rooms are designed. Templates declare door positions, spawn anchors with a budget cost, a safe pocket, and hazard slots (declared but unimplemented; the schema is the point).

**Doors lock during combat** and open on clear. Rooms remember `cleared`, so backtracking through a finished room doesn't respawn it.

Three rules the generator has to keep, each of which broke once:

1. **The entry's first step must go east.** The entry template has a single east door; letting the path leave in any direction meant the exit got stripped by the template-agreement pass and the entire floor was severed from its own entrance — 12 of 13 rooms unreachable.
2. **The boss attaches to its host's east side.** The arena has one door, on its west wall. If no path room has a free eastern neighbour, the generator walks back along the path rather than orphaning the boss.
3. **Party placement must clear the doorway trigger by more than the spread radius.** The party lands in a 58-unit ring; with only 86 units of clearance one member spawned *inside* the door they just used and instantly transitioned back. A dead-end room traded the party back and forth every 22 ticks.

**Navigation is a breadth-first search** to the nearest unvisited room, falling back to the boss. A local "not the door I came in by" heuristic is not enough — on a dead end the only door *is* the arrival door.

**Bots gather at the exit but do not step through it while a human is in the party.** §2 locks doors so nobody gets dragged ahead; a bot triggering the transition would do exactly that from the other side. With an all-bot party there is nobody to wait for, so bots lead — which is also what lets the harness play a floor end to end. Bots also never leave while an ally is downed.

## Camera and leash (§2)

Two cameras: a **world camera** that zooms to fit the party and scrolls, and a **HUD camera** at zoom 1 so the interface doesn't shrink when the party spreads out.

The zoom floor (`CAMERA.MIN_ZOOM`) is load-bearing. §16.5 and Pillar 3 both say a camera zoomed to fit four scattered players makes each one a few pixels tall — so it stops pulling back, and the leash takes over.

**The leash is defined in world units from the party centroid, never as "off the rendered frame."** Frame size depends on the window, and a rule that depends on the window is not something two lockstep peers can agree on. The camera and the leash read the same `World.centroid`, so what you see and what the rules do cannot disagree.

## Juice, and the line it must not cross

**Knockback and stagger are simulation.** They move bodies, so they are deterministic, checksummed, and identical on every peer.

**Screen shake, particles, damage numbers and audio are render-only.** They are driven by a one-way `EventBuffer` the sim fills each tick and the renderer drains. Nothing in `src/render/` or the scenes ever writes back into the world.

That split is the whole design. A cosmetic effect that fed back into the sim would desync two peers whose windows are different sizes — and it would do so invisibly.

Hit-stop is per-body (`Entity.staggerTicks`) rather than a global freeze. A global freeze feels better but has to be identical on every peer, which fits lockstep badly.

`Particles` uses its own seeded `Rng` rather than `Math.random`, so replays look identical and `Math.random` stays absent from the whole codebase — which is what keeps the harness's trap check meaningful. `audio.ts` is the one exception, and it is commented as such.

## Party and controllers

The world always has `PARTY_SIZE` (4) slots. `new World(seed, humanSlots)` decides how many are driven from outside; the rest are bots. Default is 1 human + 3 bots.

**A controller produces an `InputState` — it never moves an entity.** A bot goes through the same `Player.step` a human does, so anything a bot demonstrates about movement or targeting is a fact about the real game, not about a parallel AI path. The same seam takes a remote peer's input frame or a replay log later; the simulation can't tell the three apart.

Bot decisions are a pure function of world state plus a forked PRNG, so **lockstep peers derive identical bot behaviour independently — bot inputs never go over the wire.**

`World.step` runs controllers in two passes: every controller decides against the same start-of-tick state, so a bot's choice can't depend on its index in the array.

**Two rules learned the hard way, both from a real bug report:**

1. **The world clears each slot's `InputState` before the controller writes it.** Controllers only write the fields they care about, so without the clear a button stays held forever after one press. Currently only the context action is bound, so it was nearly invisible — it would silently break every ability slot the moment §3.3 lands.
2. **A bot that commits to reviving stays committed.** Re-electing a rescuer each tick is the obvious design and it does not work: channelling means standing still, standing still means taking hits, and taking hits disqualified the current rescuer — handing the job to a healthy bot across the room and restarting the 3s channel from zero. Any per-tick "pick the best agent for this job" election has this failure mode.

Bots also never defer to a human for a revive — a human may simply never press the button, and the victim bleeds out while the party waits. That is what `Player.botControlled` is for.

Bots hold a standoff band at ~72% of **their own class's** attack range and steer apart from allies. Per-class matters: an Archer at 330 range and a Warrior at 116 want completely different spacing, and one shared number made every class fight like a Warrior.

Escape abilities (Dash, Blink) trigger on an **absolute** distance, not a fraction of attack range. The Archer's standoff is 238 and 70% of its range is 231, so a range-relative threshold could never fire — the bot was always already further away than its own escape condition required.

## Combat and death (§8)

Players run a three-stage life machine, not an `alive` boolean:

**Alive → Downed → Wraith.** Downed players crawl, can't attack, bleed out over 20s, and are **still a body in the world** — allies reach them. Any Alive ally revives with an unbroken 3s channel on the context action (slot 4). Interrupting resets the channel to zero rather than decaying it, so the 3s is a real commitment. Wraiths can't be hurt, don't collide, and slow nearby enemies — still playing, weakly. Total party wipe ends the run (`[LOCKED]`).

**Stage 3 (resurrection at a boss / shop shrine / revive item) is not built** — it needs bosses and shops.

Two rules the code follows that are easy to break by accident:

- **Enemies ignore Downed players.** §8's design rule is that anything piling on when the party is already losing is a death spiral. It also makes reviving a real option rather than a trap.
- **Wave size scales with party *size*, never living players** — same reason.

`WAVE.CLEAR_HEAL` is **sandbox scaffolding, not balance.** Nothing heals yet (no pickups, shop, or items), so continuous waves guarantee an attrition wipe. Delete it when §2's room-clear rewards exist.

## Determinism

`World.checksum()` hashes every field the simulation reads — positions by exact IEEE-754 bits, plus the RNG state. This is not test scaffolding: lockstep peers exchange it periodically to catch desync on the tick it happens (§16.3, §16.7).

**When you add a field that affects future behaviour, add it to that entity's `writeChecksum`.** A field the checksum ignores reports agreement while peers silently diverge — worse than having no checksum.

`npm test` covers: same seed + same inputs → identical 1800-tick trace · framerate independence across 60/144/30/stuttering frame patterns · seeds actually differ · `Math.random` is trapped and never called during a sim run · PRNG reproducibility, state round-trip, fork independence · the checksum notices a one-ULP drift · the bot party replays identically and is framerate-independent · bots actually engage and stay separated.

These have been mutation-tested — injecting `Math.random` into world generation, leaking real frame time into the sim `dt`, and zeroing bot separation each fail the suite. The `dt` mutation notably still *passes* at 60fps and only fails at 144fps.

Combat adds: collision keeps bodies apart (sampled every tick, not just the last one) · nothing escapes the room · the §8 stage transitions · revive needs an unbroken channel · bots revive a downed ally · a party wipe ends the run.

Classes add: **every one of the twelve abilities actually fires** · the §3.2 levers each separate all four classes · a dash hits each body exactly once.

Floors add: generation is seeded and reproducible, and across 40 seeds every room is reachable, every door reciprocal, and no room offers a door its template cannot draw · doors lock during combat and no transition starts mid-fight · the party makes real floor progress rather than oscillating · the leash grants its grace period and then bites gently.

Checks that need a fight call `advanceToCombat` first — floors open in an enemy-free entry room, so anything about combat, collision or abilities would otherwise be measuring an empty room.

Checks that isolate a mechanic call `suppressEnemies` — otherwise a rescuer standing still for a 3s channel gets beaten down and the check fails for reasons unrelated to what it tests.

Several checks are deliberately non-vacuous: the bot replay check asserts bots *left the spawn ring* (a party of statues satisfies every determinism check ever written), the separation check asserts enemies are taking damage, and the ability check enumerates ids from the class table rather than a hardcoded list, so a new class cannot be silently untested.

The dash check counts **hit events carrying the dash's damage**, not the victim's total HP loss — the first version failed because the Warrior's basic attacks land on the same body mid-dash (14 dash + 13 + 13 basic = 40).

## Working rules

- Ask before adding dependencies.
- Small commits with clear messages.
- When a task touches a design decision that is `[OPEN]` in the manual, surface it rather than picking silently.

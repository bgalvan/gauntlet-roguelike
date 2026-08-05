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

**Phase 0 — prototype skeleton.** Goal is the smallest thing that proves the foundation:

- Fixed-timestep game loop
- Input abstraction layer with M+K and gamepad backends
- Seeded PRNG
- One room, one player, movement, auto-attack against a dummy

Nothing else. No procedural generation, no items, no classes beyond a placeholder.

Phase 0 exists to answer manual §13's questions. Do not expand scope past the skeleton without asking.

## Commands

| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `npm run dev` | Vite dev server with HMR — http://localhost:5173 |
| `npm test` | Determinism harness — headless, no browser |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm run build` | Typecheck, then production bundle to `dist/` |
| `npm run preview` | Serve the built `dist/` locally |

No linter yet — TypeScript is in strict mode with `noUnusedLocals`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`, which covers most of what a linter would catch at this size. Add ESLint when it starts earning its keep.

**Toolchain:** Vite 8 · TypeScript 7 · Phaser 4.

## Layout

```
src/
  core/        constants · rng · fixed-loop · checksum   — engine-agnostic
  input/       input-state · input-manager · backends/{keyboard-mouse,gamepad}
  game/        world · targeting · controller · bot · entities/{entity,player,dummy}
  scenes/      game-scene.ts                             — the only Phaser-aware file besides main.ts
test/
  determinism.ts                                         — run with `npm test`
```

**The rule that keeps constraints #1 and #3 honest:** `src/game/` and `src/core/` import no Phaser and read no DOM. The simulation runs headless; the scene renders it. Input crosses the boundary only as `InputState`. If a `import Phaser` ever appears under `game/`, something has gone wrong.

## Party and controllers

The world always has `PARTY_SIZE` (4) slots. `new World(seed, humanSlots)` decides how many are driven from outside; the rest are bots. Default is 1 human + 3 bots.

**A controller produces an `InputState` — it never moves an entity.** A bot goes through the same `Player.step` a human does, so anything a bot demonstrates about movement or targeting is a fact about the real game, not about a parallel AI path. The same seam takes a remote peer's input frame or a replay log later; the simulation can't tell the three apart.

Bot decisions are a pure function of world state plus a forked PRNG, so **lockstep peers derive identical bot behaviour independently — bot inputs never go over the wire.**

`World.step` runs controllers in two passes: every controller decides against the same start-of-tick state, so a bot's choice can't depend on its index in the array.

Bots hold a standoff band at ~72% of attack range and steer apart from allies. That separation is standing in for collision, which arrives in Phase 1 — without it four bodies occupy one pixel and §13's readability question can't be asked.

## Determinism

`World.checksum()` hashes every field the simulation reads — positions by exact IEEE-754 bits, plus the RNG state. This is not test scaffolding: lockstep peers exchange it periodically to catch desync on the tick it happens (§16.3, §16.7).

**When you add a field that affects future behaviour, add it to that entity's `writeChecksum`.** A field the checksum ignores reports agreement while peers silently diverge — worse than having no checksum.

`npm test` covers: same seed + same inputs → identical 1800-tick trace · framerate independence across 60/144/30/stuttering frame patterns · seeds actually differ · `Math.random` is trapped and never called during a sim run · PRNG reproducibility, state round-trip, fork independence · the checksum notices a one-ULP drift · the bot party replays identically and is framerate-independent · bots actually engage and stay separated.

These have been mutation-tested — injecting `Math.random` into world generation, leaking real frame time into the sim `dt`, and zeroing bot separation each fail the suite. The `dt` mutation notably still *passes* at 60fps and only fails at 144fps.

Two checks are deliberately non-vacuous: the bot replay check also asserts bots *left the spawn ring* (a party of statues would satisfy every determinism check ever written), and the separation check asserts dummies are taking damage.

## Working rules

- Ask before adding dependencies.
- Small commits with clear messages.
- When a task touches a design decision that is `[OPEN]` in the manual, surface it rather than picking silently.

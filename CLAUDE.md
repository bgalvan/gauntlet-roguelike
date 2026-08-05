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
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm run build` | Typecheck, then production bundle to `dist/` |
| `npm run preview` | Serve the built `dist/` locally |

No linter yet — TypeScript is in strict mode with `noUnusedLocals`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`, which covers most of what a linter would catch at this size. Add ESLint when it starts earning its keep.

**Toolchain:** Vite 8 · TypeScript 7 · Phaser 4.

## Layout

```
src/
  core/        constants · rng · fixed-loop      — engine-agnostic
  input/       input-state · input-manager · backends/{keyboard-mouse,gamepad}
  game/        world · targeting · entities/{entity,player,dummy}
  scenes/      game-scene.ts                     — the only Phaser-aware file besides main.ts
```

**The rule that keeps constraints #1 and #3 honest:** `src/game/` and `src/core/` import no Phaser and read no DOM. The simulation runs headless; the scene renders it. Input crosses the boundary only as `InputState`. If a `import Phaser` ever appears under `game/`, something has gone wrong.

## Working rules

- Ask before adding dependencies.
- Small commits with clear messages.
- When a task touches a design decision that is `[OPEN]` in the manual, surface it rather than picking silently.

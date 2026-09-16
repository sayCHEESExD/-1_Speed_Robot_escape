# +1 Speed Robot Escape

A browser multiplayer obby where you pilot a **Gundam-style mech** through a
dark industrial facility. The robot walks, the robot jumps, and you ride it
from an open cockpit in its chest — head and shoulders above the canopy rim,
three times your own height off the deck. The frames have no head, because the
hollow where one would be is the cockpit you are sitting in.

**Speed goes up while you walk.** That is the "+1" in the title: the mech you
are riding pays you its rate for every second you are actually moving forward -
across the hangar, down a stage, or running a treadmill belt. Stand still and
you earn nothing, so the game is the walking. Speed raises your **Level**, Level makes you
permanently faster, and finishing a stage banks **Wins** you spend on a better
mech or a trail. Hit the level cap and **Rebirth** for a permanent multiplier.
Thirty stages, and dying on any of them puts you straight back at the hangar.

Three.js + Colyseus + TypeScript. No game engine, four audio files, four HUD
icons, one character model, and a browser build of about **3.1 MB** against a
12 MB budget.

---

## Running it

```bash
npm install
npm run dev
```

Then open <http://localhost:5179>.

`npm run dev` starts both halves: the authoritative Colyseus server on **2573**
and the Vite client on **5179**.

> These are deliberately not the default ports. The earlier games in this
> series use 2567–2572 and 5173–5178, so every project can run side by side on
> one machine.

### Controls

| Input              | Action                                        |
| ------------------ | --------------------------------------------- |
| **W A S D**        | Walk, relative to the camera                  |
| **Space**          | **JUMP.** One press, one leap. Holding it does nothing more |
| **Mouse**          | Aim the camera                                |
| **R** / **B** / **T** | Rebirth / Mechs / Trails                   |
| **M**              | Mute                                          |
| **Esc**            | Free the cursor; click to play on             |
| Touch stick / JUMP | The same, on a phone or tablet                |

There is exactly one airborne mechanic and it is the jump. No meter, no hold,
no double jump — every gap and every step in thirty stages is authored against
the arc one press produces.

---

## The loop

1. **Walk forward.** Hold W and the mech earns its rate for every second it is
   actually under way. Standing still earns nothing at all, and neither does
   holding W against a wall - the machine has to be going somewhere.
2. **The rate is fixed**, and it is three things multiplied:
   `mech Speed/s × rebirth multiplier × trail multiplier`. Nothing else changes
   it - not your level, not how fast you happen to be going, and never a random
   roll. A better mech is a bigger number, which is the whole reason to buy one.
3. **Or run a treadmill.** Three identical belts on the right of the hangar. A
   belt pays **exactly** what walking pays - same rate, no multiplier, no tier -
   and only while you are actually running on it.
4. **Level up.** Speed crosses a threshold and you are permanently faster. The
   curve is 100, 110, 121, 133, 146 … — geometric, from two constants.
5. **Run a stage.** Cross the **win pad** on your left at the far end to bank
   its Wins and be returned to the hangar. The **return pad** opposite it sends
   you back and pays nothing, for when you have already banked that one.
6. **Spend.** Walk onto a plinth in the Mech Bay for a better frame, or open
   **T** for a trail. Trails multiply how fast you actually move.
7. **Rebirth.** At the cap, trade the level curve for a permanent Speed
   multiplier and a higher ceiling. Wins, mechs and trails are kept.

Dying — lava, a beam, a fall — costs no progress and returns you to the
hangar, which is where the mechs, the treadmills and the boards are. There are
no checkpoints, and there must not be any.

### The mechs

Twelve frames, and the ladder is the `Speed/s` column. The first ten stand on
the two-storey display deck down the player's left; the last two are bought
from the **Mechs** panel on the rail, which is the same purchase going through
the same server authority.

| Wins to unlock | Speed/s | Mech             | Where          |
| -------------: | ------: | ---------------- | -------------- |
|           free |      +1 | Scrap Walker     | Bay 1, lower   |
|              3 |      +2 | Bolt Runner      | Bay 2, lower   |
|             15 |      +5 | Neon Lancer      | Bay 3, lower   |
|            100 |     +25 | Magma Frame      | Bay 4, lower   |
|            500 |     +50 | Volt Crusher     | Bay 5, lower   |
|          1,000 |     +75 | Iron Sentinel    | Bay 6, upper   |
|          2,000 |    +100 | Storm Caster     | Bay 7, upper   |
|         10,000 |    +250 | Phantom Strider  | Bay 8, upper   |
|         25,000 |    +500 | Titan Breaker    | Bay 9, upper   |
|         35,000 |    +750 | Nova Paragon     | Bay 10, upper  |
|         50,000 |  +1,000 | Omega Warden     | Mechs panel    |
|        100,000 |  +2,000 | Void Colossus    | Mechs panel    |

Income runs away by a factor of two thousand across the roster. Movement speed
does not: `moveBonus` climbs from 1.0 to 2.15, because the obby has to stay
readable at the far end of the ladder and income does not.

### The trails

| Wins   | Multiplier | Trail   |
| -----: | ---------: | ------- |
|     50 |      x1.5  | Green   |
|    150 |      x2    | Blue    |
|    500 |      x3    | Yellow  |
|  2,500 |      x4    | Red     |
| 10,000 |      x5    | Rainbow |

A trail multiplies **actual movement speed**, through the one shared movement
formula and never a calculation of its own. The mech owns Speed-per-second; the
two axes never cross.

### Rebirth

| Rebirths | Speed multiplier | Level cap |
| -------: | ---------------: | --------: |
|        0 |             x1   |        50 |
|        1 |             x1.5 |        75 |
|        2 |             x2   |       100 |
|        3 |             x2.5 |       125 |
|        … |          +0.5 ea |   +25 ea  |

The cap is not a constant — it is whatever the next rebirth requires, so
reaching the cap and unlocking the rebirth are the same moment.

---

## The course

Thirty stages, each authored, each with one idea, and each visually distinct.

|  # | Section                    | The idea                                        |    Wins |
| -: | -------------------------- | ----------------------------------------------- | ------: |
|  1 | **Mech Hangar Escape**     | Floating blocks over glowing coolant             |       5 |
|  2 | Reactor Platform           | Huge blocks falling slowly, wide gaps to walk    |       3 |
|  3 | Falling Machinery          | Platforms that drop away, one always up          |       8 |
|  4 | Industrial Maze            | Lit walls on a grid, one route through           |      15 |
|  5 | Energy Bridge              | One narrow catwalk, no hazards, all width        |      25 |
|  6 | Reactor Core               | A wide hall with a derelict heavy mech that hunts|      40 |
|  7 | Moving Cargo Platforms     | Moving decks and sweepers across the lanes       |      60 |
|  8 | Laser Grid Facility        | Thin fast lances at ankle, waist and shoulder    |      90 |
|  9 | Mechanical Crusher Hall    | Slow presses in a corridor with no way round     |     130 |
| 10 | Suspended Factory          | Small platforms on cables over nothing           |     180 |
| 11 | Vertical Reactor Shaft     | A climb with almost no Z to help                 |     250 |
| 12 | Collapsing Platforms       | Alternating safe tiles on a diagonal rhythm      |     350 |
| 13 | Giant Gear Facility        | Two enormous discs with arms sweeping over them  |     500 |
| 14 | Energy Conveyor            | Belted plating that pushes in the air too        |     700 |
| 15 | Mech Testing Chamber       | Rotating beams over solid floor — learn the timing|   1,000 |
| 16 | Industrial Tunnel          | A roof too low to jump. Dodge sideways           |   1,400 |
| 17 | Reactor Cooling Zone       | Timed shutters. The answer is to go *slower*     |   2,000 |
| 18 | Moving Wall Facility       | Moving walls with a travelling gap               |   2,800 |
| 19 | Multi-Level Factory        | Three decks stacked, crossed in alternate ways   |   4,000 |
| 20 | Gravity Platform Section   | Launch pads. The only stage a leap cannot clear  |   5,600 |
| 21 | Energy Core Maze           | The maze again, with beams in the junctions      |   8,000 |
| 22 | Giant Machinery Room       | A corkscrew winding around a rising core         |  12,000 |
| 23 | Mech Assembly Facility     | Lifts you have to be standing on when they go    |  18,000 |
| 24 | Reactor Bridge             | Hard left, hard right, all the way across        |  27,000 |
| 25 | Vertical Hangar            | Steps down a shaft, each drop longer than the last| 40,000 |
| 26 | Mechanical Gauntlet        | One cycle, one beat apart, all the way across    |  60,000 |
| 27 | Collapsing Factory         | Four enormous gaps and nothing else              |  90,000 |
| 28 | Core Defense Facility      | Short and guarded, or long and open. Three times | 140,000 |
| 29 | Final Reactor              | Every hazard at once over a climbing chain       | 220,000 |
| 30 | **MECH ESCAPE**            | Shutters, beams, pulse tiles, and one last leap  | 350,000 |

Each section is LIT IN ITS OWN COLOUR — lime through the hangar and the
assembly halls, cyan across the coolant sections, amber in the foundries,
violet in the deep machine spaces, and magenta closing the run at the reactor.
The architecture is deliberately the same building all the way down; the light
is what tells you which part of it you are in.

Stage 1 pays more than stage 2 on purpose: the first clear is a welcome bonus,
fat enough to put a new player straight onto the second mech. From stage 2 the
ladder only climbs.

Each stage is announced by **floating text and nothing else** - "STAGE 4"
hanging over the mouth of it, with no panel, frame or billboard between you and
the run. Only stage 1 says **ESCAPE**, because a word that appears on all thirty
is a word nobody reads.

---

## How it is put together

```
shared/     the single source of truth for both halves
  config/robots.ts     the roster - shape, palette, price, Speed/s
  config/course.ts     THE WORLD, as data. Every solid, hazard and pool
  config/movement.ts   the ONE movement evaluator
  config/speed.ts      the level curve and the Speed rules
  sim/PlayerSim.ts     THE physics step, run by the server AND the client
  sim/WorldCollision.ts the collision model both sides query

server/     Colyseus. Authoritative over everything that is earned
  rooms/CourseRoom.ts  the room, the tick, the messages
  movement/            runs PlayerSim and replicates the result
  progression/         Speed, Wins, levels, rebirth, mechs, trails
  world/               the sentinel, the one hazard that is not a formula

client/     Three.js. Predicts, renders, and asks
  robot/               ONE mech builder, twelve data entries
  animation/           the walk cycle and the jump, procedural
  world/               the renderer for the shared course data
  net/                 the only place that touches colyseus.js
  ui/                  the HUD, the rail and the panels
  bloxity/             the portal: login, avatars, settings, Bux
```

The rule the whole thing hangs on: **the server decides, the client asks.**
A client sends input and requests. It never sends a position, a reward, a
price, or a level, and there is no message it could forge into a Win, a level
or a mech.

---

## Verification

```bash
npm run typecheck     # all three workspaces
npm run verify        # the course, the barrier and the server's authority
npm run verify:assets # the supplied files are byte-for-byte as supplied
npm run size:client   # the browser build against the 12 MB budget
```

- `verify:course` walks the generated world and fails on overlapping stages,
  holes in the floor, a gap wider or a step higher than one jump at that
  stage, hazards that sweep through a wall, a sinking rank with no platform up,
  a stage that pokes through its own roof, and the hangar layout — the ten
  plinths, the two storeys, the walkable stair and the three identical belts.
- `verify:progression` exercises the real services and the real simulation,
  including the **rejection** paths: claiming a stage from across the map,
  banking the same stage twice, buying a mech you cannot afford, claiming the
  mech on the deck above you, equipping a trail you do not own, and holding
  the jump key in mid-air.
- `verify:barrier` charges the end of the world at a thousand units a second
  and checks nothing gets past it.
- `verify:capacity` needs a **running server**, which is why it is not part of
  `verify`. It connects more clients than one room may hold and asserts both
  halves of the limit: no room over capacity, and the overflow routed rather
  than turned away.

Browser behaviour has to be checked in a real browser.

---

## Multiplayer

A room holds fifteen players. The matchmaker locks a full room and opens
another, so the sixteenth player is **routed** rather than refused.

Every player in the room is tracked and synchronised on every patch — position,
progression, avatar, mech, trail, death. Only the **two closest to you** are
drawn, which is a rendering limit and nothing else: a mech is two dozen meshes
carrying a dressed Bloxity avatar and a trail ribbon, and fifteen of those is
most of a phone's frame budget spent on players too far away to make out. A
player who walks into view is already up to date, so they appear in the right
place doing the right thing on the frame they become visible.

Other players are **ghosted**, and that word means exactly one thing: they do
not collide, so they can never block another player's run. They render
completely normally.

---

## Deployment

Two hosts, and the split is not negotiable: Netlify serves static files and
cannot run a WebSocket server, so the client is deployed there and the Colyseus
server runs as a long-lived Node process somewhere else.

```
Netlify   ──  @robot/client      static files, built by Vite
Node host ──  @robot/server      Colyseus, one long-lived process
```

```bash
npm run build
npm start --workspace @robot/server
```

| Variable          | Where  | What it does                                                       |
| ----------------- | ------ | ------------------------------------------------------------------ |
| `VITE_SERVER_URL` | client | **Required in production.** Where the Colyseus server is, over `wss://`. Baked in at build time, so changing it means rebuilding. |
| `PORT`            | server | Listen port. Defaults to 2573.                                     |
| `ROBOT_DATA_DIR`  | server | Where profiles are written. Defaults to `data/` beside the server.  |
| `BLOXITY_WEBHOOK_SECRET` | server | Verifies the Bux webhook when set.                       |

On an ephemeral filesystem a redeploy wipes every player's progression unless
`ROBOT_DATA_DIR` points at a mounted volume.

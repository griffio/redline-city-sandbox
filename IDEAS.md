# Redline City: game ideas

Game modes that can be built on the handling sandbox. Each idea lists the code it builds on and what is still missing.

**Size** is relative: **S** reuses what exists, **M** adds one new system, **L** needs several. *In the game* marks ideas you can already play (see the README's *Generated tracks*); *prototyped* marks ideas only the course lab runs so far.

## Contents

- [The course lab](#the-course-lab)
- [What the engine already gives you](#what-the-engine-already-gives-you)
- [A. Generated courses](#a-generated-courses)
- [B. Skill tests and driving school](#b-skill-tests-and-driving-school)
- [C. Rubber as gameplay](#c-rubber-as-gameplay)
- [D. Physics toys and party games](#d-physics-toys-and-party-games)
- [E. Rivals](#e-rivals)
- [F. Redline City missions](#f-redline-city-missions)
- [G. World modifiers](#g-world-modifiers)
- [Building blocks](#building-blocks)
- [Suggested order](#suggested-order)

## The course lab

A working prototype of the generated courses runs in the [Redline City Playbook](https://claude.ai/artifact/Lb3oHM3apnsk5aMTSLWjf2) page. The link is private. The page embeds `src/physics/car.js` and `src/physics/world.js` from commit 2817b3c with only their `export` keywords removed. A bot drives them at 240 Hz, as the game does. The generators, racing line, lap sim and bot have since moved into the game as `src/courses/`. The lab still has the drift-zone overlay, the preset comparison and the co-driver voice.

### Pipeline

1. **Generate.**
   * **Circuits:** a closed loop whose radius follows a few random harmonics. Because the radius is a function of angle, the loop can't cross itself.
   * **Stages:** a self-avoiding walk on a 40 m grid, jittered by up to 9 m and rounded off with a spline.
   * **Gymkhanas:** a walk over a 4×4 grid of 90 m cells, with one element per cell.
   * **Seeds:** the same seed always gives the same course (mulberry32 PRNG). A text seed is hashed with FNV-1a.
2. **Clean up.**
   * **Corners:** the tightest ones are eased open until none is under 15 m radius (circuit) or 11 m (stage).
   * **Clearance:** a course is rejected and regenerated if two parts of the road are closer than the track width plus 12–14 m.
3. **Racing line.** This is a minimum-curvature line inside the track edges. It runs gradient descent on Σ|second difference|², projected onto each point's normal and clamped to the edges.
   * **Coarse to fine:** it is solved on an 8 m sampling first, because long corners converge slowly at fine spacing, and then refined at 2 m.
4. **Lap simulation.** A quasi-steady-state lap sim gives the speed profile and the par time.
   * **Corner speeds:** `v = √(μg/|κ|)`, where μ is the lower of `gripFront` and `gripRear`.
   * **Forward pass:** acceleration is the smallest of three limits: the grip left over in the friction circle, the car's own torque curve and gears minus drag and rolling resistance, and traction at the driven wheels.
   * **Backward pass:** braking uses `brakeForce`, also limited by the friction circle.
   * **Two profiles:** a standing start gives the par time, and a periodic solve (three laps, keep the middle one) gives the bot's speed targets.
5. **Verify.** The unmodified `Car` and `World` drive the course.
   * **Walls:** both edges become walls with `addWall()`, 1.2 m outside the painted edge.
   * **Collision checks:** each step only tests the walls in the car's cell of a 16 m grid.

### The bot

* **Steering:** pure pursuit toward a point on the racing line. The point is measured in the **direction of travel**, not the nose, so a slide doesn't fool it. Lookahead is `5 + 0.42·v` m, clamped to 7–34 m.
* **Wheel angle:** `atan(κ·wheelbase) + 0.12·(κ·v − yawRate) + β·(1 − assist)`, where β is body slip. The car adds its own countersteer assist (`countersteer × β`) on top of `steerAngle`, so the bot leaves that share out.
* **Speed:** the target is 94% of the lap-sim speed (the *pace* factor). It takes the lowest target within the next `0.35·v + 4` m, so braking starts on time. Throttle is cut to 40% while body slip is over 0.2 rad.
* **Commands:** the bot sends `{throttle, brake, steer, steerAngle}`, the same object the control schemes produce. It refreshes them every 4th physics step, like the game's frame loop. The run is deterministic, so a live replay matches a headless run step for step.
* **Rescue:** if the car is stuck for 2.5 s, or off the line by more than 1.5 track widths, it is put back on the line with a 5 s penalty.

### Results

A check of 150 runs (30 courses × all 5 presets) in Node on the dev Mac mini:

* **Completion:** every run finished, with 8 light wall contacts and 1 rescue in total.
* **Pace:** the bot's median time was 11.5% slower than par (range 5–26%).
* **Cost:** a whole bot lap, collisions included, takes about 50 ms (90th percentile 105 ms). The car alone runs 100,000 steps in 99 ms.

**Medals** come from those two times: **Gold** is par × 1.05, **Silver** is the bot's time ("beat the bot") and **Bronze** is the bot's time × 1.15.

### Pace notes

Notes come from the centreline curvature, smoothed over ±6 m. A corner is a run of curvature above 1/160 m⁻¹ that turns more than 14°.

| Call | Rule |
|---|---|
| Hairpin | radius under 13 m, or over 140° with radius under 22 m |
| Square | radius under 22 m and 70–110° |
| 1 / 2 / 3 / 4 / 5 / 6 | radius under 20 / 30 / 45 / 65 / 95 m / anything wider |

* **Modifiers:**
  * `long` for over 120°.
  * `tightens` or `opens` when exit curvature differs from entry curvature by more than ×1.45.
  * `Caution` for a grade 1, 2, Square or Hairpin after more than 110 m of straight.
* **Links:**
  * `into` for a gap under 16 m, `and` under 32 m.
  * Otherwise the distance, rounded to 10 m up to 100 and to 50 m up to 300.
* **Vocabulary:** the notes only ever use 29 words, so each can be voiced once at build time. Left, Right, Hairpin, Square, 1–6, long, tightens, opens, into, and, Caution, Finish, 30, 40, 50, 60, 70, 80, 90, 100, 150, 200, 250, 300.

### Feel benchmark

The lab's *Compare presets* runs every preset on a course, or over 20 seeds. It reports two measures of how hard the bot had to work:

* **Time at the limit:** the share of the run with front or rear grip use over 90%.
* **Steering reversals per km:** direction changes of the road-wheel angle bigger than a 1° gap. Steering reversal rate is a standard measure of driver workload.

Circuit seed 412, as an example:

| Car | Par | Bot | vs par | At limit | Max slip | Reversals/km |
|---|---|---|---|---|---|---|
| Balanced | 0:40.5 | 0:45.5 | +12.3% | 43% | 12° | 25 |
| Grip / Sim | 0:38.3 | 0:42.9 | +11.8% | 26% | 8° | 15 |
| Drift Car | 0:42.9 | 0:48.1 | +12.0% | 54% | 23° | 38 |
| Arcade Grip | 0:35.7 | 0:39.6 | +10.9% | 18% | 3° | 36 |
| Ice / Rally | 0:54.0 | 0:59.9 | +10.9% | 27% | 4° | 21 |

Pasting the panel's *Copy tuning JSON* into the lab makes the bot drive that exact tuning.

### Co-driver voice

The lab's *Co-driver voice* button gets Claude to write the co-driver's lines for the current course, then reads them out as the bot reaches each corner.

* **Styles:** Classic, Hype or Dry wit.
* **Script:** one Claude call per course and style (the `sample` capability, quick tier). It returns a line for every note, plus short reactions for the start, wall hits, big slides and the finish.
  * **Cost:** the call runs on the viewer's own Claude account and asks for consent first.
  * **Caching:** answers are cached for 24 hours, so replaying a course costs nothing.
* **Safety check:** a line must still contain every vocabulary word of its plain note (direction, grade, modifiers, link), in order. Otherwise the plain note is read instead, so flavour can't change a call.
* **Voice:** the browser's built-in speech engine (`speechSynthesis`), because the page can't reach ElevenLabs or Workers AI.
  * **Priority:** notes cut off an older note but wait behind a reaction, and reactions never interrupt.
  * **Speed:** the voice runs at 1× and 2× playback and pauses at 4×.

## What the engine already gives you

* **Headless physics:** `car.js` and `world.js` import nothing, so bots, course checks, par times and ghosts can run in a Web Worker at about a million steps a second.
* **The ground keeps every slide:** skid marks build up in a 4096² texture covering 440 m, about 9 texels a metre (`SKID_RES` in `src/gpu/renderer.js`). It can be scored, not just looked at.
* **Any line can become a wall:** `addWall()` (`src/physics/world.js:20`) cuts any segment into 4 m boxes with SAT collision, so a generated layout is collidable the moment it exists.
* **Props keep score:** cones and tyre stacks have mass, spin and restitution. A cone hit above 3 m/s sets `down` (`world.js:243`), which is already a penalty counter or a bowling scoreboard.
* **Car-to-car contact is half written:** `obbVsObb(car, b)` (`world.js:252`) only reads `x, y, rot, hl, hw`, so a second car can be passed in as a barrier. Only `impulse()` (`world.js:160`) needs to push both cars.
* **Jumps are already drawn:** the drift hop scales the car sprite and moves its shadow (`src/main.js:497–518`). A ramp that sets an airborne timer gets top-down jumps with no new rendering.
* **One car sprite, any number of colours:** every sprite instance carries an RGBA multiply (`renderer.sprite()`). Paint one white car into the atlas and tint it per rival.
* **Telemetry that can judge anything:** body slip, slide per wheel, grip use per axle, lateral and longitudinal g, lockups and wheelspin (`car.js:115–124`, `bodySlip`). Drift scoring uses three of them.
* **Callouts are one line of JSON each:** add a line to `tools/voice/lines.json`, regenerate at build time and call `audio.say()`.
* **The one real gap is the ground shader.** It paints the sandbox's features from WGSL constants (`renderer.js:41–127`). Courses need it to read the layout from data, for example a baked texture holding the distance to the track edge.

## A. Generated courses

### Seeded circuits (M, *in the game*)

Type a seed and get a flowing loop with a racing line, kerbs at the apexes and medal times the bot has shown to be possible. Share the seed and everyone races the same track.

* **Uses:** `addWall()` for both edges, and the lab's generator, line and bot.
* **Built:** the data-driven ground pass, checkpoints, a lap timer, medals, the bot's ghost and best times.
* **Still to do:** a shared leaderboard.

### Rally stages with a co-driver (M, *in the game*: on-screen notes)

Point-to-point stages read out by a co-driver. The notes come from the curvature, with the rules and the 29-word vocabulary listed [above](#pace-notes). Each word is voiced once at build time and the words are joined up while you drive.

* **Uses:** `tools/voice/announcer.mjs`, `lines.json` and `audio.say()`.
* **Needs:**
  * a second premade voice for the co-driver (Liam was the strongest male voice in the announcer trials);
  * a clip queue that plays words back to back;
  * call timing: the lab calls about 3.5 s ahead.
* **An AI-written co-driver** (prototyped in the lab, see [Co-driver voice](#co-driver-voice)). An LLM rewrites the notes in a style once per stage, when the stage is generated, so there is no wait while you drive. In the game that leaves two choices:
  * **Build-time:** keep the baked ElevenLabs words for the calls and use the LLM only for a few prebaked reaction lines.
  * **Runtime:** synthesise the whole script with a TTS model during the countdown. That brings back the runtime TTS the announcer moved away from on 2026-10-20.

### Gymkhana grids (S, *in the game*)

A walk over 90 m cells:

* straight-through cells become a slalom (5–6 cones at 13–16 m) or a gate chicane;
* turning cells become a 450° loop round a tyre stack, or a turn round a cone box;
* the run ends parked in a cone garage.

Autocross rules apply: 2 seconds per cone down.

* **Uses:** `addCone()`, `addTyres()` and `p.down`.
* **Built:** the garage stop (within 3.5 m of the end, under 1 m/s).
* **Still to do:** a heading check for the garage stop.

### Drift zones and clipping points (S, *prototyped*)

Zones go on corners of 16–75 m radius that turn more than 55°. Each has a clipping point on the inside apex and one on the outside at 80% of the way through. Inside a zone the existing drift score gets a multiplier, plus a bonus for passing a clip within 1.5 m.

* **Uses:** `updateScore()`, which already scores angle × speed × time.
* **Needs:** zone and clip triggers, and a zone result banner.

### Daily course (S)

The date is the seed, so everyone drives the same course today and a new one tomorrow. Start with a local best time, then add a shared leaderboard.

* **Uses:** the generators, and `save()`, which already keeps bests.
* **Needs:** later, a Worker route with D1 or KV for a shared board and ghost uploads.

### Draw your own track (M)

Draw a loop with a finger on the iPad or with the mouse. The same corner easing and clearance check that clean up generated tracks make it drivable, and the bot posts a par time in under a second.

* **Uses:** the `touch.js` pointer handling and the lab pipeline.
* **Needs:** a drawing screen.

### Drive your street (L)

Fetch the roads around an address from OpenStreetMap (Overpass API), convert them to metres and turn them into asphalt and walls. Your commute becomes a time trial. OSM data is ODbL, so the game has to credit it on screen.

* **Uses:** `addWall()`, and the corner easing to clean up junctions.
* **Needs:** a cached fetch through the Worker, and bigger worlds (the skid texture covers ±220 m).

### Endless stage (L)

The road is generated ahead of the car and dropped behind it. Checkpoints add time and the corners tighten as the distance grows, like OutRun on a rally road.

* **Needs:** chunked barriers and a ring-buffered skid texture.

## B. Skill tests and driving school

The tyre model is close enough to the real thing to teach real technique. These modes also work well as feel-tuning tools.

### Licence tests (M)

Short graded exercises that teach the physics the car really has:

* threshold braking with ABS off;
* lift-off oversteer;
* a Scandinavian flick;
* a handbrake 180;
* a J-turn.

Each one is graded from telemetry.

* **Uses:** `t.abs`, `car.locked`, `bodySlip`, `yawRate` and the presets.
* **Needs:** an exercise format (setup, goal, grading function).

### Moose test (S)

The ISO 3888-2 lane-change layout in cones, with lane widths worked out from the car's 1.9 m width. The throttle is released at the entry gate. Each clean pass raises the entry speed by 2 km/h, so you find out which preset gets through fastest.

* **Uses:** `addCone()` and `p.down`.
* **Needs:** an entry speed gate.

### Handbrake parking (S)

Slide into a box between cones and stop. The score is position and heading error once the car is below 0.2 m/s.

* **Uses:** the start box painted at the origin, and the handbrake's rear lock.

### Skidpad g-meter (S)

Hold the skidpad circle for a lap. The score is the sustained lateral g. It is the fairest way to compare two setups, and the rings are already painted.

* **Uses:** `WORLD.skidpad` and `car.accelLat`.

### Setup puzzles (M)

The car turns up badly set up, for example brake bias 0.3, slide falloff 1.9 and countersteer off. You fix it in the tuning panel to beat a target time. The panel built for tuning becomes part of the game.

* **Uses:** the `ui.js` sliders, `applyPreset()` and `PRESETS`.

## C. Rubber as gameplay

Few driving games keep the marks you leave. This one does, so these modes are particular to Redline City.

### Tyre graffiti (M)

A faint stencil on the asphalt, such as a star, a 77 or a heart, that you fill with rubber. Coverage is measured from the skid texture itself: one compute pass multiplies it by the stencil and adds it up.

* **Uses:** the skid texture.
* **Needs:** a compute pass and a readback, both cheap in WebGPU.

### Donut judge (S)

Donuts scored on how round they are, how many rings you lay and how much smoke you make. All of it comes from yaw rate, body slip and how far the centre wanders.

* **Uses:** `yawRate`, `bodySlip` and the particle count.

### Turf war (L)

Paper.io with rubber: close a loop of skid marks to claim the ground inside it, while bots try to cut across your trail.

* **Needs:** loop detection on a coarse grid, and more than one car.

### Coaching overlay (M)

After a run, colour the rubber by cause: locked brakes red, power slides amber, wheelspin white. Then show where you lost time against the bot.

* **Uses:** `wheelSlide`, `locked` and `wheelspin`.
* **Needs:** a second channel in the skid texture (r8 to rg8).

## D. Physics toys and party games

These are quick to build on the sandbox as it is, and good for showing people what the handling can do.

### Cone bowling (S)

Ten cones racked at the end of the drag strip, two rolls a frame, strikes and spares. The `down` flag already counts the pins.

* **Uses:** `WORLD.dragStrip`, `addCone()` and `p.down`.

### Handbrake curling (S)

Slide to a stop on a set of rings. The car nearest the centre scores. Tyre stacks are stones you can knock out of the way.

* **Uses:** the skidpad's ring paint, and momentum transfer between props.

### Car soccer (M)

A heavy ball and two goals built with `addWall()`, played one against one with the bot or a friend.

* **Needs:** a bouncier "ball" prop, and more than one car.

### Sumo (M)

Push the other car out of a ring. Mass, grip and which wheels are driven suddenly matter.

* **Needs:** car-to-car contact.

### Shared-screen elimination (M)

The Micro Machines rule: one north-up camera, and whoever drops off the screen loses the round. Two to four players on one screen.

* **Uses:** the north camera and the retro model.
* **Needs:** one input per pad (`input.js` reads only the first pad), and more than one car.

### Pass the iPad (S)

Same seed for everyone. Players take turns with tilt steering, and the earlier players' ghosts are on track.

* **Uses:** `touch.js`, seeded courses and ghosts.

## E. Rivals

The lab's bot is already a rival: it drives the same car with the same commands a player sends.

### Bot racing (M)

Rivals use the same `Car` class and the lab's controller. Difficulty is one number, the pace factor (the lab uses 0.94), plus a little noise on the line.

* **Uses:** `Car` and sprite tinting.
* **Needs:** car-to-car contact.

### Ghost duels (S)

Record x, y and heading 30 times a second and race your best run. That is about 21 KB a minute as float32.

Input recordings are smaller, but they only replay exactly on the same JS engine, because `Math.sin` and `Math.atan2` can differ between browsers. Store positions for ghosts you share.

* **Uses:** car state and sprite alpha.

### Tandem drift (M)

Follow a lead car through a drift. The score is how close you stay and how well your angle matches, the way Formula Drift judges lead and chase. Then swap.

* **Uses:** the kart drift layer, which is already a controller that holds a target slip angle (`car.js:367–379`).

### Figure-8 racing (M)

Generated circuits that cross themselves on the flat. The crossing is where races go wrong, which is the point of the format.

* **Uses:** the circuit generator, with the clearance check relaxed at one crossing.

### Demolition derby (M)

Damage comes from the impulse each hit already produces. The last car still moving wins.

* **Uses:** `impulse()`, which already returns `j`.
* **Needs:** a damage model (lost power, bent steering), and car-to-car contact.

## F. Redline City missions

These need a generated city first. After that, each one is mostly scoring rules.

### Generated city (L)

Blocks are split recursively into streets, alleys and plazas. Buildings are barrier boxes. Their roofs are drawn offset away from the camera centre in proportion to their height, which gives GTA 2's sense of height without any 3D.

* **Uses:** `addWall()`, instanced sprites and the camera.

### Getaway (L)

Police bots chase you with the pursuit controller and try PIT manoeuvres. Heat rises with damage. Breaking line of sight round a block lets you escape: that check is a ray tested against the barrier boxes.

* **Needs:** the city, more than one car, and a chase controller.

### Fragile cargo (S, once there is a city)

Deliver a wedding cake. Sustained g in any direction costs you, and so does every impact. It turns drift scoring upside down using the same telemetry.

* **Uses:** `accelLat`, `accelLong` and the world's impact value.

### Taxi rush (M)

Pick up, drop off, and earn tips for drifts and for near misses: passing a wall within a metre at speed.

* **Uses:** `bodySlip` and barrier distances.

### Night run (M)

Dark ground, with headlight cones drawn using the additive glow sprite. You see only what your lights reach. It suits the getaway too.

* **Uses:** the glow sprite with the additive flag, and the brake-light code in `draw()`.

## G. World modifiers

These aren't modes. They are rules that can be added to any mode above.

### Surfaces (M)

Gravel, ice, puddles and oil as grip multipliers, read under each axle. `car.js` already works out grip per axle, so one lookup per axle is enough. Today the Ice / Rally preset is the everything-is-ice version.

* **Uses:** `axles[i].mu` in `car.step()`.
* **Needs:** a surface map, and ground paint for it.

### Jumps (S)

A ramp sets an airborne timer: no tyre forces, a bigger sprite and a shadow that moves away. The existing hop code already draws all of that.

* **Uses:** the `drift.hop` rendering in `draw()`.

### Rain (M)

Less grip, darker and glossier asphalt, fainter skid marks, and spray thrown up by the wheels that are sliding.

* **Uses:** `wheelSlide`, particles and the ground shader.

## Building blocks

Most of these ideas are scoring rules on top of a few shared systems. Build the systems once and the modes come cheaply.

● needed by most ideas in the family · ○ needed by some

| Building block | A | B | C | D | E | F | G |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| **Course format and data-driven ground:** walls, props, paint and start from data, not WGSL constants | ● | ● | ● | ● | ● | ● | ● |
| **Generators and the bot:** the lab's code, moved into a Web Worker | ● | | ○ | ○ | ● | ● | |
| **Timing, triggers and callouts:** checkpoints, gates, zones, results, new voice lines | ● | ● | ● | ● | ● | ● | |
| **More than one car:** two-body impulse, tinted sprites, one input per pad | | | ○ | ○ | ● | ● | |
| **Bigger worlds:** chunked barriers, a skid texture that follows the car | ○ | | | | | ● | |

## Suggested order

The handling feel is still being chosen, so the first step is the one that also helps with that.

1. **Courses.**
   * **Build:** the course format and ground pass, the three generators, the bot in a Worker, a timer, medals and a local daily seed.
   * **Feel benchmark:** every preset over 20 seeds, judged on time at the limit and steering reversals as well as lap time.
   * **New lines:** "Three", "Two", "One", "Go!", "Checkpoint!", "New record!", "Gold!", "Final lap!" and the 29 co-driver words.
2. **Toys and tests.**
   * **Build:** cone bowling, handbrake parking, the moose test, the skidpad g-meter and licence tests. All of them fit in the current sandbox, and each one stresses the handling in a different way.
   * **New lines:** "Strike!", "Spare!", "Clean pass!", "Cone down!", "Licence passed!"
3. **Rivals.**
   * **Build:** the two-body car impulse, ghosts, bot racing and tandem drift. After this, sumo, soccer and the derby are mostly rules.
   * **New lines:** "Overtake!", "Photo finish!", "Goal!", "Perfect tandem!"
4. **The city.**
   * **Build:** generated blocks with roof parallax, then missions on top: getaway, taxi rush, fragile cargo and night runs.
   * **New lines:** "Busted!", "Escaped!", "Delivered!", "Big tip!"

Every new line goes through `tools/voice/announcer.mjs` at build time with the premade voices the ElevenLabs Free plan allows. Nothing changes at runtime.

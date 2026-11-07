# LaLi-Sisi-Controller

A web interface for controlling stepper-motor machines over a serial connection. Motors can be controlled with on-screen buttons, arrow keys, or voice commands (e.g. "move right 15 millimeters").

The same app drives several machines. Pick the machine with the selector at the top of the page. It decides how the board is set up and which controls are shown:

| Selector option | Board / firmware | What it does | Extra controls |
| --- | --- | --- | --- |
| **Microscope Controller** | BTT SKR (Marlin) | Moves a camera/sample platform on X and Y | Cooling fan |
| **SiSi Controller** | Arduino (GRBL) | Sweeps a nozzle across a tank with a water pump | Pump, sweep presets |
| **LaLi Controller** (`lali-grbl`) | Arduino Uno + CNC shield (GRBL) | Dispenses prepolymer from two syringes onto tiles, then carries them through a UV curing tunnel on a conveyor | Drawn syringe and tile strip, start-volume presets, Set Home, Prime, Reset Syringes / Reset Conveyor, UV light, automated "Go!" routine |
| *LaLi (Marlin)* (`lali-marlin`, hidden) | RUMBA (Marlin) | The same LaLi line on a RUMBA board | B/C syringe axes, Dispense, UV light, Go! |

LaLi (Marlin) is still supported by the server, but its selector button is commented out in `templates/index.html`. Un-comment it to bring it back.

The browser tab's title follows the selected machine (e.g. "LaLi Controller").

## Building & Running

The app can be run by simply running `./run.sh` from the root folder. This will handle installing dependencies and creating a virtual environment. URLs to access the webapp will be printed to the console.

To build the standalone app, run `./build.sh`. This will first compile the Flask app and its associated static assets into a binary, then this binary is copied into the Electron app's dist folder, where the Electron app is then built with the Flask binary as a bundle resource. The final product ends up in the root build folder as a standalone app which when opened will spin up the Flask server, check for a serial connection with the controller board, and get the urls for opening the web app, displaying them in the main window.

## How it works

```
Browser page                      Flask server                   Controller board
(templates/index.html,   ──HTTP──▶  (app.py, port 5050)  ──USB serial──▶  (SKR / Arduino / RUMBA)
 static/script.js)                  one shared connection
```

The page never talks to the board directly. Every button, arrow key, voice command and routine step builds G-code in the browser and sends it to the Flask server. The server writes it to the board over USB serial, one line at a time.

### The Flask server (`app.py`)

The server listens on `0.0.0.0:5050`, so the page can be opened on this computer (`localhost`) or from another device on the same network. It keeps a single serial connection (`ser`), opened on the first `/initialize` and reused for every request after that.

| Route | Called by | What it does |
| --- | --- | --- |
| `GET /` | Browser | Serves the control page |
| `GET /initialize?machine=…` | Control page on load and when you pick a machine, Electron launcher | Finds the board, opens the serial port at 115200 baud and runs the startup sequence for the chosen machine (or the detected one if `machine` is left out). Returns `machine`, `detected_machine`, `firmware`, `port`, `has_bc_axes` and the full `machines` list. If already set up for that machine, it just returns the current details; if a different machine is asked for, it shuts the board down and sets it up again. |
| `POST /send_gcode` | Every control | Sends G-code to the board. Body: `{"gcode": "G1 X5 F500\nG4 P0"}` |
| `POST /stop` | 🛑 Stop! | Emergency stop, written straight to the port so it doesn't wait behind other commands: feed hold `!` + soft reset `Ctrl-X` on GRBL (which also switches the spindle/UV and coolant off), `M410` + `M107` (fan/UV off) on Marlin. Any request still waiting on the board (e.g. a Go! step) is cancelled with "Stopped by user". |
| `GET /connection` | Control page, every second (and while it reports no board, the page retries `/initialize` every 2 s) | How long the board has been connected (`{"state": "connected", "duration": "12:04"}`), or how long it lasted before its USB device disappeared (`"state": "dropped"`). A background thread (`watch_connection()`) checks the port once a second without sending anything to the board. These polls are kept out of the terminal log. |
| `GET /available-urls` | Electron launcher | Returns the local and network URLs for the page |
| `GET /cleanup` | Electron on quit, and `app.py` on exit | Turns off the coolant output (GRBL) or FAN0 (Marlin), releases the motors and closes the port |

**Startup sequences:**

- **GRBL:** wake the board, `$X` (clear alarm), `$20=0` / `$21=0` (soft and hard limits off), `G91` (relative moves).
- **Marlin:** `M106 S255` (fan on, Microscope controller only), `M84 S0` (keep motors powered), `M211 S0` (software endstops off), `G91` (relative moves).

All moves are **relative** (`G91`). `G1 X5` means "move 5 mm in +X from wherever you are", not "go to X = 5".

**What happens on each `/send_gcode`:**

1. Clear any leftover serial data and send `$X` (GRBL's alarm unlock; Marlin ignores it).
2. GRBL only: re-send `G91` (this also restores relative mode after an emergency stop's soft reset).
3. Send each non-empty line (lines starting with `;` are skipped) and wait up to 30 s for the board's `ok` before sending the next one.
4. Reply `200` once every line got an `ok`. If the board answers `error` or `ALARM`, or doesn't answer in time, stop, try to recover (clear the buffers and send `$X`), and reply `500` with `{"error": "..."}`.

> **`ok` doesn't mean "finished".** Boards reply `ok` as soon as they've *queued* a move, before the motors have actually moved. The exceptions are pauses (`G4`) and sync commands (`M400` on Marlin, `G4 P0` on GRBL): the board only replies to those once all queued motion has finished. The page relies on this to know when the machine has physically stopped.

### The frontend (`static/script.js`)

Plain JavaScript with no build step. On load the page calls `/initialize`, passing the machine you last picked (remembered in the browser), if any:

- **Success:** the controls appear. Machine-specific controls carry a `data-machines` attribute listing the machines they belong to (e.g. `data-machines="lali-marlin lali-grbl"`), and are hidden on all other machines.
- **Failure:** a "Not Connected" message is shown instead. The machine selector stays visible, so you can pick a different machine, or fix the connection and reload.

There are two ways the page sends G-code:

| Function | Waits for the reply? | Used by |
| --- | --- | --- |
| `sendGCode(gcode)` | No (fire and forget; errors are only logged) | Arrows, keyboard, voice, most buttons |
| `sendGCodeOrThrow(gcode)` | Yes; throws if the server returns an error | 💧 Prime, Start Volume, Reset Syringes / Reset Conveyor, 💉 Dispense and ▶ Go! |

These end each request with a sync command, so the request only returns once the machine has stopped moving. That's what keeps the "Dispensing..." label and the Go! progress bar in step with the real machine. Go! sends one request per step, so a failure stops the routine at that step.

G-code that differs between firmware is built by helpers that use the `firmware` value returned by `/initialize`:

- `dwellGCode(seconds)`: pause (`G4 P<ms>` on Marlin, `G4 P<s>` on GRBL)
- `syncGCode()`: wait for all moves to finish (`M400` on Marlin, `G4 P0` on GRBL)
- `lightLevelGCode(level)` / `lightGCode(on)`: LaLi UV light at a brightness from 0 to 1 (`M106 P0 S0–255` / `M107 P0` on Marlin, `M3 S0–1000` / `M5` on GRBL)

**Voice control** uses the browser's built-in Web Speech API (Chrome / Electron). Each recognised phrase is matched against the commands in [Voice commands](#voice-commands) and turned into G-code.

### The Electron app

The standalone build (`./build.sh`) wraps the server in a desktop app. On launch it:

1. Starts the compiled Flask binary.
2. Waits until port 5050 responds.
3. Shows a small launcher window listing the URLs from `/available-urls`. The control page itself is opened in a browser at one of those URLs.

On quit it calls `/cleanup` and then stops the server.

### Things to be aware of

- **One board at a time:** the server connects to the first matching board it finds.
- **No command queue on the server:** requests are handled as they arrive, so pressing other controls while Go! is running can interleave their commands with the routine's. Leave the page alone until the routine finishes.
- **Unplugging and re-plugging the board:** no restart needed. When the background watcher sees the USB device disappear, it logs how long the connection lasted, closes the dead port and forgets it. `/connection` then reports `"dropped"`, the 🔌 icon shows, and the page logs "USB connection lost after m:ss" to the console. While no board is connected, the page asks `/initialize` again every 2 s for the machine it's showing. Those attempts carry `auto=1` and are kept out of the terminal log. As soon as the board is back it's set up again, the icon disappears, and the UV / pump / fan buttons show off, since the board restarted.
  - **LaLi (GRBL) needs Set Home again:** plugging an Arduino in resets it, so GRBL forgets Set Home's coordinates and the drawings no longer match the machine. The same applies when a board is first plugged in while the page is in preview mode. Until you press 🏡 Set Home, Go! is greyed out ("The board reconnected: press Set Home…"), and so is everything that moves to a position on those coordinates: the Start Volume buttons, Reset Syringes / Reset Conveyor, and dragging the syringe. The preset and primed distance are cleared too, so the full setup is Set Home, then pick a Start Volume. The arrows, keys and Prime move relatively, so they still work for lining things up first.

## Choosing the machine

Each machine is an entry in `MACHINES` in `app.py`. The selector at the top of the page shows three of them:

| Option | Key | Firmware | Syringe axes | UV light |
| --- | --- | --- | --- | --- |
| Microscope Controller | `microscope` | Marlin | — | — |
| SiSi Controller | `sisi` | GRBL | — | — |
| LaLi Controller | `lali-grbl` | GRBL | Y (both motors in parallel) | Spindle PWM (`M3 S…` / `M5`) |
| *(hidden)* LaLi (Marlin) | `lali-marlin` | Marlin | B and C (separate) | FAN0 (`M106 P0` / `M107 P0`) |

**How the machine is chosen:**

1. **Your pick wins:** clicking an option saves it in the browser, and the page asks for that machine every time it loads.
2. **Otherwise, auto-pick:** with nothing saved, the server pre-selects a machine from the board it finds (`detect_device()` and `DEVICE_PROFILES` in `app.py`):

   | Board | USB ID | Pre-selects |
   | --- | --- | --- |
   | BTT SKR | `1D50:6029` | Microscope Controller |
   | Arduino Uno | `2341:0043` | SiSi Controller |
   | RUMBA (reports as an Arduino Mega 2560) | `2341:0042` | LaLi (Marlin) |
   | Anything else on a `usbmodem` / `usbserial` port | — | SiSi Controller |

**Switching machines** shuts the board down (outputs off, motors released), closes the port, and sets it up again with the new machine's startup sequence. The selector is ignored while Go! or Dispense is running. If setup fails, for example because you picked a Marlin machine for a GRBL board, the port is closed again and you can pick another option.

The firmware matters for a few commands. For example, `G4 P` (pause) means seconds on GRBL but milliseconds on Marlin. Routine pauses go through `dwellGCode(seconds)`, which writes the right form for the selected machine's firmware.

> **Preview mode:** `PREVIEW_WITHOUT_BOARD` at the top of `static/script.js` shows the selected machine's controls even with no board connected (or `PREVIEW_DEFAULT_MACHINE` if none is selected), which is useful for working on the UI. Commands fail quietly, but the drawn syringe and tiles still animate. Set it to `false` for normal use.

## Controls on every machine

- **Movement speed / distance:** use the sliders, or click the bold number and type an exact value (e.g. `0.05` mm). Typed values can be finer than the slider steps. Movement distance starts at 5 mm, or 14.2 mm on LaLi (`DEFAULT_MOVEMENT_DISTANCE_MM` in `static/script.js`), and resets to that when you switch machines.
- **Arrow buttons / keyboard arrows:** move X and Y by the current distance at the current speed. Pressing an arrow key briefly lights up the matching on-screen arrow in its own colour. Keyboard arrows are ignored while you're typing in a box. Arrows a machine can't use are greyed out (e.g. the stage ▲/▼ on machines without a vertical stage axis); on LaLi they're hidden instead (see [Larvae Linker](#larvae-linker-lali-)).
- **⌨️ Keys On / Keys Off:** turns keyboard arrow control on or off. Remembered in this browser.
- **Custom G-code:** sits just below the sliders. Type any G-code and press Send. Send is greyed out while the box is empty.
- **🎤 Listen:** toggles voice control (see [Voice commands](#voice-commands)).
- **🏠 Home:** homes the X axis (`G28 X`). *Currently commented out in `templates/index.html`. On LaLi its place is taken by Set Home.*
- **🛑 Stop!:** emergency stop. Halts motion immediately, cancels anything still queued, and switches the UV light, pump and fan off. A running Go!, Prime or Dispense stops where it is and nothing from it continues (Go! skips its remaining steps). Nothing stays locked: the next command works normally. On GRBL the reset loses the syringe coordinate, so press Set Home again before dragging the drawn syringe.

Every command sent is printed to the browser's developer console (`Sending G-code: …`) and to the terminal running `app.py` (`Sending: …`). (The status line showing how long the board has been connected over USB is commented out in `templates/index.html` for now.) While no board is connected, a small crossed-out plug 🔌 shows in the top-left corner, just right of the window buttons. Hover over it for the reason: no board, connection lost (restart to reconnect), or the app not responding. It's driven by the same `/connection` check, once a second, so it disappears as soon as a board connects.

## Microscope platform 🐚🔬

Selector option: **Microscope controller**. A two-axis X/Y platform driven by an SKR board running Marlin.

**Extra controls:**

- **Fan On / Fan Off:** toggles the cooling fan (`M106` / `M107`). The fan is also switched on at startup. The label follows the fan's state however it was changed (click, voice, startup, Stop).
- **💃 Dance!:** traces a square the size of the current movement distance.

### Parts List

- BTT SKR Ender3 2.0 Control Board
- 24v, 6a (or more) power supply
- 2020 Aluminim Extrusions
- 2 NEMA11 Stepper Motors with lead screw and rail
- Angle brackets
- Project box
- 24v DC cooling fan
- USB Cable

## Coral Cleaner ("CC" or "SiSi") 🪸🚿

Selector option: **SiSi Controller**. A GRBL-controlled gantry with a water pump attached, used to sweep a spray nozzle across a tank. The pump is switched with GRBL's coolant commands.

**Extra controls:**

- **Pump On / Pump Off:** toggles the pump on (`M8`) and off (`M9`). The icon animates while the pump is on, and the label follows its state.
- **💃 Dance!:** traces a square the size of the current movement distance.
- **🧹 Sweep presets (10 s / 15 s / 20 s):** start the pump, sweep 2 inches along Y in the chosen time, move clear, then stop the pump. *These buttons are currently commented out in `templates/index.html`. Un-comment the `preset-buttons` block to bring them back.*
- **Voice:** "pump on/off" (or nozzle / sprayer / jet / water), and "pump pulse" for a short burst. These are ignored on other machines.

When the app closes it turns the pump off and releases the motors.

## Larvae Linker ("LaLi") 💉🔦

A dispensing and UV-curing line. Two syringes deposit prepolymer onto a row of 12 tiles (14.2 mm each), and a conveyor carries the tiles through a UV curing tunnel. It normally runs on an Arduino Uno + CNC shield with GRBL 0.9 (selector option **LaLi Controller**, key `lali-grbl`), with the second syringe motor on the shield's A slot cloned from Y. It can also run on a RUMBA board with Marlin (`lali-marlin`, hidden from the selector):

| Axis / output | LaLi (Marlin) | LaLi (GRBL) |
| --- | --- | --- |
| **Syringe plungers** | **B** and **C**, one motor each | **Y**, both motors wired in parallel |
| **Conveyor** | **X** | **X** |
| **UV light** | FAN0 | Spindle PWM pin (D11) via MOSFET |

The rest of this section describes LaLi (GRBL) unless it says otherwise.

For B and C, positive = plunge down and negative = pull up. On LaLi (GRBL) the syringes are on Y (`GRBL_SYRINGE_AXIS`), where positive = plunge down, like B and C. The direction is set by `AXIS_DIRECTION` in `static/script.js`. Since Y is the syringe axis there, the stage ▲/▼ arrows are hidden, the keyboard ↑/↓ keys move the syringes instead (like the syringe ▲/▼ buttons), and directional voice commands don't move Y. The conveyor is set by `CONVEYOR_AXIS`, and the Go! routine advances it in the positive direction (`CONVEYOR_DIRECTION`; this only affects Go!, not the arrows). All of the syringe G-code goes through `syringeMoveGCode()` in `static/script.js`, which picks B + C or Y for the selected machine.

### Controls

The layout puts the conveyor's ◀ ▶ over the waiting tiles, the drawn syringe in the middle with its needle over tile 1, and the syringe ▲/▼ to its right. The tiles coming out of the UV tunnel have room on the right.

- **◀ ▶ while the conveyor moves (LaLi):** **Conveyor moving...** shows above the conveyor arrows whenever the conveyor is moving (by the page's estimate, plus 0.2 s). Presses and ←/→ keys still queue up behind it as usual. The arrows are only greyed out (and the keys ignored) while a tile drag or Reset Conveyor is moving the conveyor, and for the whole of a Go! run.
- **Plunger Speed / Plunger Distance:** a second row of sliders, shown only on LaLi. They set the speed and step size for the syringe arrows and ↑/↓ keys, and the speed of drag-to-position moves on the syringe. Like the Movement sliders, you can click the bold number to type an exact value. On LaLi (GRBL), an **mm / µL** switch next to Plunger Distance sets its unit: it starts in µL at 40 µL (`DEFAULT_PLUNGER_UL`, about 0.66 mm). µL goes 10–1000 µL (up to 1 mL) in 10 µL steps; mm goes 0.25–10 mm in 0.01 mm steps, per syringe, converted with the syringe calibration (1000 µL ≈ 16.48 mm). Switching keeps the same physical distance, rounded to whole µL and capped at the new unit's maximum (e.g. 1000 µL becomes 10 mm). The arrows and ↑/↓ keys always move by that distance. The Movement sliders still drive the conveyor (◀ ▶, ←/→ keys, voice). Prime and Go! use their own fixed settings (`PRIME_GCODE`, `SYRINGE_PRESS_MM`, `SYRINGE_PRESS_FEEDRATE`, …).
- **Syringe arrows:** one pair of ▲/▼ arrows moves Y, which drives both syringes at once. The keyboard ↑/↓ keys do the same.
  - *LaLi (Marlin):* B and C arrows (pink and black) move each syringe on its own. The **🔓/🔒 Lock** between them makes any B or C arrow move **both** syringes together in a single command; amber lines join the arrows while locked.
- **Syringe calibration:** Y0 is Set Home, where the syringes hold **2.77 mL** (`SYRINGE_HOME_ML`) with their holder plate backed up against the stepper. Y44 (`SYRINGE_TRAVEL_MM`) is full travel, at **0.1 mL** (`SYRINGE_END_ML`). In between it's linear, about 16.48 mm per mL.
  - **Travel limits:** any syringe move that would take the plunger above Y0 or past Y44 is refused, with a console warning. That covers the ▲/▼ arrows, the ↑/↓ keys, dragging (it stops at either end), Prime, voice extrude commands and Dispense. Go! is refused if its 12 presses wouldn't fit before Y44. The limits use the page's running total, so they're only as good as Set Home.
- **Drawn syringe:** the barrel has a **0–3 mL** scale (`SYRINGE_CAPACITY_ML`) read at the stopper, like a real syringe. The plunger can only reach the part of it between 2.77 mL and 0.1 mL. Grab anywhere on the syringe and drag; the plunger follows the pointer from where you grabbed it, and releasing moves the syringes there in absolute mode (`G90`, `G1 Y…`, `G91`). The plunger stays where you dropped it (it isn't animated there). Drag past Y0 or Y44 and the plunger waits at that end, faded; letting go there cancels: it snaps back to where it was and nothing is sent. Until the syringes would have arrived, the syringe ▲/▼ and ↑/↓ keys are greyed out and ignored, with **Syringes moving...** above them, and the syringe can't be dragged again. 🛑 Stop ends that wait. The number riding just above the plunger is Y, in mm below Set Home.
  - **Starting level:** when LaLi is selected, the page assumes the syringes are at Set Home (2.77 mL), sets the board's coordinates to match (`G92 X0 Y0`, which doesn't move anything) and selects no preset. Press Set Home to confirm it.
  - The arrows, keys, Prime and Go! move relatively, and the drawing follows them. It's the page's running total: it doesn't see custom G-code or an emergency stop. Drag and preset moves are always exact, because they use the board's coordinates.
- **Start Volume (2.5 mL / 1.5 mL):** a small selector just below the syringe ▲/▼ (`SYRINGE_PRESETS_ML`). After Set Home, picking one moves the syringes down to that volume in absolute mode, at the Plunger Speed: 2.5 mL is Y4.45 and 1.5 mL is Y20.93. Picking the other one later moves there instead, up or down. It doesn't mark a tile, since it's setup rather than dispensing. It also resets the primed distance, so prime after picking. Reset Syringes comes back to the picked preset. Set Home clears the selection. Ignored while Go! or a reset runs.
- **Tile strip:** a side view of the 12 tiles under the needle. Tile 1 (the rightmost) starts under the needle; each 14.2 mm conveyor advance slides the row right so the next tile is centred, and on into the UV tunnel, which is drawn long enough to hold all 12 tiles at once. The tunnel starts one tile to the right of the needle (`UV_TUNNEL_START_MM`), so a tile goes in on the second advance after it's dispensed. It's lined up under the drawn needle automatically, whatever the window size.
  - **Dragging the tiles:** hovering over the row shows a ↔ cursor. Drag it to slide the tray, and releasing moves the conveyor there in absolute mode (`G90`, `G1 X…`, `G91`) at the Movement Speed. The drag stops at Set Home (X0) and at where a full Go! run leaves the tray (`CONVEYOR_DRAG_MAX_MM`, 12 cycles + 11 UV advances = 326.6 mm). Drag past either limit and the row waits there, faded; letting go there cancels: the row snaps back to where it was and nothing is sent. The row stays where you dropped it (it isn't animated there), and counts as moving until the conveyor would have arrived. UV timers for tiles dropped into the tunnel start counting straight away, so they run a little ahead during that move. It isn't available until Set Home after a reconnect, or while the conveyor is moving or Go!, a reset or a Start Volume move is running.
  - **Conveyor speed:** the row moves the way GRBL actually runs the conveyor: it speeds up, cruises at the Movement Speed (capped at `$110` = 500 mm/min) and slows down at `$120` = 10 mm/s². Several ◀/▶ clicks in a row run as one continuous move without slowing down between them, like GRBL's planner; a click the other way waits for the conveyor to stop first.
  - **Dispensed tiles:** a tile turns purple (with a pink resin layer) when the syringes plunge while it's under the needle. The resin's size follows how much was dispensed onto it (per syringe, from the calibration): 40 µL draws 8 mm wide at 1 mm tall (`RESIN_MM2_PER_UL`), and more spreads it wider, adding up over several dispenses. Once it covers the whole tile top it gets taller instead, up to 3 mm (`RESIN_MAX_HEIGHT`, about 213 µL), then stays that size. It lands where the needle was across the tile (averaged by volume over several dispenses), not necessarily the centre, but never past the tile's edges. Prime and Start Volume moves don't count: they happen before the tray is put in place.
  - **UV timers:** a dispensed tile in the tunnel counts up its UV time in m:ss above it, only while the UV light is on. The timer appears once the tile has had some UV, and stays (paused) after it leaves the tunnel. Tiles with no material never get a timer.
  - The tunnel glows while the UV light is on.
  - **Plunges are blocked while the conveyor moves:** the syringe ▼, ↓ key, dragging the syringe down, Prime and voice extrude commands are ignored (with a console warning) while the page thinks the conveyor is still moving, plus 0.2 s. Go! is already sequenced, so it isn't affected.
  - Like the syringe, the strip is the page's estimate from the moves it sends. Stop freezes it wherever the drawing was.
- **🏡 Set Home:** set the syringes to 2.77 mL with their holder plate against the stepper and put tile 1 under the needle, then press this. It sends `G92 X0 Y0`, so **nothing moves**. The drawn syringe and tiles go back to home, the tile marks, timers and primed distance are cleared, and no preset is selected. Then pick a Start Volume.
- **💉 Reset Syringes:** moves the syringes back to the picked Start Volume (e.g. Y4.45 in 2.5 mL mode), or to Set Home (Y0) if none is picked, at `SYRINGE_RETRACT_FEEDRATE` (capped at `$111` = 500 mm/min). It also resets the primed distance. Greyed out while the syringes are already there.
- **↩️ Reset Conveyor:** runs the conveyor back to Set Home (X0, tile 1 under the needle) at the Movement Speed. Once it's back, the tile marks and timers are cleared. Greyed out while the conveyor is home and no tile has material on it.
  - **Both at once:** GRBL runs one move at a time, so two separate requests can't overlap. Instead, each press waits `RESET_PAIR_WINDOW_S` (0.6 s) before sending anything. Press the other button within that time and both go out as one `G1 X0 Y…` line, so they start and finish together. The feed is set so the part with further to go runs at its own speed and the other is slowed to match. Pressed later, while the first is already moving, the second runs straight after it. Both labels read "Resetting..." meanwhile.
  - Both move in absolute mode on the board's coordinates, and the drawings move at the same speed as the real machine.
  - With no board (or no reply), the drawings still go back at the same pace they would with the board (no jump), with a console warning that the hardware may not have moved. If Stop is pressed partway (or during the 0.6 s wait), the drawings stay where they got to and nothing queued is sent.
  - Ignored while Go! runs.
- **💧 Prime:** primes the syringes before a run with fixed G-code (`PRIME_GCODE`): `G1 Y1 F500`, `G4 P0`, i.e. one `PRIME_TOTAL_MM` (1 mm) plunge; the G-code is built from `PRIME_TOTAL_MM`, so the drawing and the travel limits always match it. The label reads "Priming..." until it has finished. Pressing it more than once adds up. It doesn't mark the tile under the needle, since the tray isn't in place yet when priming. Ignored while Go! runs.
  - **Priming isn't required by Go!:** Go! works without a Prime; its checklist asks you to confirm the syringes are primed instead. Prime adds to the primed distance, which Go!'s position check allows for (the syringes may sit that far below their Start Volume). At the end of a run, finished or stopped, the primed distance resets. Any manual pull-up of the syringes (▲, ↑, dragging up, Reset Syringes) or a Start Volume pick also resets it. Plunging down doesn't change it, and neither does custom G-code, which the page doesn't track.
- **💉 Dispense:** one plunge of both syringes (`SYRINGE_PRESS_MM`). The label reads "Dispensing..." until the plunge has physically finished. *Currently commented out in `templates/index.html`.*
- **☢️ UV Light:** toggles the UV strip (`M3 S1000` / `M5` on GRBL, `M106 P0 S255` / `M107 P0` on Marlin). Voice: "light on/off", "UV light on/off".
- **▶ Go!:** greyed out on LaLi until a Start Volume is picked. Prime isn't required. As a safety check it's also greyed out unless everything is where you set it: the tray at tile 1 (Set Home's X0) and the syringes exactly at their Start Volume plus what Prime pushed. So any other plunge or pull-up (▲/▼, keys, dragging, voice) disables it until you press Reset Syringes (and Prime again, if you want), and moving the conveyor disables it until Reset Conveyor. It's also greyed out while a reset or Start Volume move is running. Hover over it to see what's missing. These use the page's running totals, like the drawings. It asks first in a frosted-glass "Start Crosslinking" dialog with a checklist: **Syringes loaded**, **Syringes primed**, **Tray at tile position 1** and **UV Light On**. The items start unticked every time, and **Confirm** (the blue Snow Leopard default button, or Return) stays greyed out until all four are ticked. Then it starts the run; **Cancel**, Esc or a click outside the dialog doesn't. While it's open, the arrow keys don't move the machine. Then it runs the full dispense-and-cure routine below, with a progress bar. It puts the tile strip back to home when it starts, and animates the presses and advances as they happen.

### The Go! routine

Each row is one step on the progress bar. Every step ends by waiting until all moves have physically finished (`G4 P0` on GRBL, `M400` on Marlin). That keeps the progress bar honest and makes each pause start after the motion before it has stopped.

| # | Step | What happens |
| --- | --- | --- |
| 1–12 | Cycles 1–12 | **UV on** (cycle 1 only). Then: 0.5 s settle, plunge 0.67 mm, wait 0.1 s, conveyor advances 14.2 mm |
| 13–23 | UV tunnel advances 1–11 | Wait 1.4 s, conveyor advances 14.2 mm, until the last row is through the tunnel |
| 24 | UV lights off | **UV off**, once the last advance has finished |

The syringes aren't pulled back up at the end: they stay where the run left them (e.g. 12 × 0.67 + 1 = 9.04 mm below the Start Volume after one Prime). Press 💉 Reset Syringes to bring them back.

**Motor hold:** on GRBL, Go! keeps the motors powered for the whole run, so the syringe pressure can't push the plungers back between presses. It sets GRBL's step idle delay to `$1=255` (never switch off) before cycle 1, and puts back `$1=25` (switch off 25 ms after each move) at the start of the last move, so the motors switch off as soon as the run's last move ends. After 🛑 Stop the page sets `$1=25` and soft resets the board once more, which switches them off straight away. After a failed step it sets `$1=25`, and they switch off after the next move. The app also sets `$1=25` every time it connects, so a run that never finished can't leave them powered. GRBL saves `$` settings to EEPROM, so this is two EEPROM writes per run (it's rated for about 100,000).

Before pressing Go!: Set Home, pick a Start Volume, prime the syringes (💧 Prime; Go!'s checklist asks, but doesn't check) and put tile 1 under the needle (Set Home marks that spot). Go! starts pressing right away. From 1.5 mL, one Prime plus a run reaches Y40.13, inside the 44 mm limit.

The timing aims for **~45 s of UV per row**. The tunnel is 6" (152.4 mm), so a row's center stops 11 times inside it, and each cycle should take about 45 ÷ 11 ≈ 4.1 s. With X/Y acceleration at 10 mm/s² (`$120`/`$121`) and the conveyor at 500 mm/min (the Movement Speed slider), a press takes ~0.8 s, an advance ~2.5 s and the app adds ~0.2 s per step, so the waits make up the rest. The tunnel steps match a cycle's length so the last rows get the same dose. If the acceleration, speeds or tunnel change, re-time a few cycles and adjust `SYRINGE_WAIT_TIME` and `UV_ADVANCE_INTERVAL_S`.

Over a full run the conveyor travels 23 × 14.2 = **326.6 mm**. Make sure X has that much room from where you start it.

When every step has finished, the page rings a bell (`static/sounds/bell.mp3`). If a step fails (e.g. the board disconnects or reports an error), it plays an alert instead (`static/sounds/alert.mp3`). Pressing 🛑 Stop plays neither.

While the routine runs, the "Go!" button glows and further clicks are ignored. If a step fails (e.g. the board disconnects), the routine stops there and the progress bar turns red and shows which step failed. In that case the remaining steps **do not** run: if it stops during the cycles the syringes stay pressed, and at any point before the last step the UV light stays on.

### Routine settings

All in `static/script.js`:

| Constant | Default | Meaning |
| --- | --- | --- |
| `SYRINGE_PRESS_MM` | 0.67 | Plunge distance per press (mm) |
| `PRIME_GCODE` / `PRIME_TOTAL_MM` | `G1 Y1 F500` | What Prime sends, and how far it plunges in total (mm) |
| `SYRINGE_TRAVEL_MM` | 44 | Y travel limit below Set Home (mm); moves past 0 or this are refused |
| `SYRINGE_HOME_ML` | 2.77 | What the syringes hold at Set Home, Y0 (mL) |
| `SYRINGE_END_ML` | 0.1 | What they hold at full travel, Y44 (mL) |
| `SYRINGE_CAPACITY_ML` | 3 | Top of the drawn syringe's scale (display only) |
| `SYRINGE_PRESETS_ML` | 2.5, 1.5 | Start Volume buttons (mL) |
| `SYRINGE_PRESS_FEEDRATE` | 200 | Plunge speed (mm/min) |
| `SYRINGE_RETRACT_FEEDRATE` | 600 | Reset Syringes speed (mm/min; GRBL caps it at `$111` = 500) |
| `RESET_PAIR_WINDOW_S` | 0.6 | How long a reset waits for the other reset button, so both can move together (s) |
| `SEQUENCE_REPEATS` | 12 | Number of plunge cycles |
| `PRE_PLUNGE_PAUSE_S` | 0.5 | Settle time before each plunge (s) |
| `SYRINGE_WAIT_TIME` | 0.1 | Wait after each plunge before the conveyor moves (s) |
| `SEQUENCE_X_STEP_MM` | 14.2 | Conveyor advance per cycle and per UV tunnel step (mm) |
| `UV_ADVANCE_STEPS` | 11 | Extra advances after the last cycle so the last row passes through the UV tunnel. At 0, UV goes off and the syringes pull back up right after the last cycle |
| `UV_ADVANCE_INTERVAL_S` | 1.4 | Wait before each UV tunnel advance (s); set so a tunnel step lasts as long as a cycle |
| `STEPPER_HOLD_IDLE` / `STEPPER_RELEASE_IDLE_MS` | 255 / 25 | GRBL `$1` during a Go! run (motors held) and after it (ms after each move before they switch off); `app.py` sets 25 on connect |
| `CONVEYOR_AXIS` | `'X'` | Axis that drives the conveyor |
| `CONVEYOR_DIRECTION` | 1 | Direction Go! advances the conveyor (1 = positive, -1 = negative) |

The conveyor moves use the current **Movement Speed** slider. The syringe moves use their own fixed feed rates.

The drawn syringe and tile strip time their movement from a copy of the board's motion settings, also in `static/script.js`. Update these if the GRBL settings change:

| Constant | Default | GRBL setting |
| --- | --- | --- |
| `CONVEYOR_MAX_FEED` | 500 | `$110`, X max rate (mm/min) |
| `CONVEYOR_ACCEL` | 10 | `$120`, X acceleration (mm/s²) |
| `SYRINGE_MAX_FEED` | 500 | `$111`, Y max rate (mm/min) |
| `SYRINGE_ACCEL` | 10 | `$121`, Y acceleration (mm/s²) |
| `REQUEST_OVERHEAD_S` | 0.15 | Delay before each request's G-code starts running (the server's `$X` and pause) |

## Voice commands

Click 🎤 to start listening, and click again or say "stop listening" to stop.

| Say | Does |
| --- | --- |
| "move/go/slide/shift up/down/left/right *N* mm/inches/microns" | Move Y (up/down) or X (left/right) by that amount |
| "move up/down/left/right" | Move 10 mm |
| "draw/make a *N* mm square" | Trace a square |
| "stop" | Release the motors (`M84`) |
| "pump on/off", "nozzle/sprayer/jet/water on/off", "pump pulse" | SiSi pump (ignored on other machines) |
| "fan on/off" | Microscope fan (ignored on other machines) |
| "light on/off", "UV light on/off" | LaLi UV light (ignored on other machines) |
| "depress syringe(s)", "deposit/extrude/pipette prepolymer" | One LaLi syringe plunge |
| "dispense *N* mL", e.g. "dispense 0.2 mL", "extrude point five milliliters", "deposit half a milliliter", "push 250 microliters" | LaLi (GRBL): plunge both syringes by that volume each (see below) |
| "dance", "say yes", "say no", "do the cha cha slide", "run test" | Demo moves |

**Dispensing by volume** (LaLi GRBL only): the verb can be dispense, extrude, deposit, pipette, push, plunge, inject or squirt, optionally followed by "out". The unit can be mL / milliliters / cc or µL / microliters, optionally followed by "of prepolymer/resin/liquid". The amount can be digits ("0.25", ".5"), number words up to ten, "point" decimals ("one point five", "point two five"), or "half", "a quarter" and "three quarters". The volume is per syringe (both move together) and is converted with the calibration, 44 mm per 2.67 mL (about 16.48 mm per mL), then plunged at the Plunger Speed. It works like ▼: the travel limit applies (an amount that would go past 0.1 mL is refused, and the console says how much is left), it's blocked while the conveyor moves, and it marks the tile under the needle. It's ignored while Go!, a reset or a Start Volume move is running. Each heard command and its mm are logged to the console.

## Known issues

- **Auto-pick and Arduino Megas:** the RUMBA shares the generic Arduino Mega USB ID (`2341:0042`), so any Mega pre-selects LaLi (Marlin). Pick the right option in the selector if that's wrong; your choice is remembered.
- **🏠 Home on GRBL** (if the Home button is brought back): `G28 X` homes on Marlin, but on GRBL `G28` means "go to the stored G28 position", not homing (that's `$H`, which needs limit switches). LaLi uses Set Home / Reset Syringes / Reset Conveyor instead.
- **Drawn syringe and tiles are estimates:** they're worked out from the commands the page sends, not read back from the board. Custom G-code, moving things by hand, and very long runs of stacked conveyor clicks can leave them out of step. Set Home lines everything up again.
- **Hand-written pauses:** the "pump pulse", "run test" and "cha cha slide" voice commands contain fixed `G4 P…` values in milliseconds. That's correct on Marlin, but GRBL reads them as seconds.

## Images

<img height="525" alt="Screenshot 2025-03-16 at 7 22 38 PM" src="https://github.com/user-attachments/assets/658c916f-6e12-439e-a176-e953ea95c08f" />

<img height="525" alt="Screenshot 2025-03-16 at 7 22 38 PM" src="https://github.com/user-attachments/assets/32dad650-8c02-45df-b3a2-e2f008e339c5" />

<img height="400" alt="Screenshot 2025-03-24 at 5 38 48 PM" src="https://github.com/user-attachments/assets/6b1ab9a8-afb6-4f28-8e35-ccb6ed528440" />

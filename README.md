# LaLi-Sisi-Controller

A web interface for controlling stepper-motor machines over a serial connection. Motors can be controlled with on-screen buttons, arrow keys, or voice commands (e.g. "move right 15 millimeters").

The same app drives several machines. Pick the machine with the selector at the top of the page. It decides how the board is set up and which controls are shown:

| Selector option | Board / firmware | What it does | Extra controls |
| --- | --- | --- | --- |
| **Microscope controller** | BTT SKR (Marlin) | Moves a camera/sample platform on X and Y | Cooling fan |
| **SiSi Controller** | Arduino (GRBL) | Sweeps a nozzle across a tank with a water pump | Pump, sweep presets |
| **LaLi (Marlin)** | RUMBA (Marlin) | Dispenses prepolymer from two syringes onto a tray, then carries the tray through a UV curing tunnel on a conveyor | B/C syringe axes, Dispense, UV light, automated "Go!" routine |
| **LaLi (GRBL)** | Arduino (GRBL) | Same LaLi gantry, on a GRBL board with both syringe motors on Y | Syringe arrows, Dispense, UV light, automated "Go!" routine |

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
| `sendGCodeOrThrow(gcode)` | Yes; throws if the server returns an error | 💉 Dispense and ▶ Go! |

Dispense and Go! end each request with a sync command, so the request only returns once the machine has stopped moving. That's what keeps the "Dispensing..." label and the Go! progress bar in step with the real machine. Go! sends one request per step, so a failure stops the routine at that step.

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
- **Reconnecting needs a restart:** if the board is unplugged, the server still holds the old connection and `/initialize` keeps reporting "Already initialized". Restart the server (or the Electron app) after reconnecting the board.

## Choosing the machine

The selector at the top of the page has four options. Each one is an entry in `MACHINES` in `app.py`:

| Option | Key | Firmware | Syringe axes | UV light |
| --- | --- | --- | --- | --- |
| Microscope controller | `microscope` | Marlin | — | — |
| SiSi Controller | `sisi` | GRBL | — | — |
| LaLi (Marlin) | `lali-marlin` | Marlin | B and C (separate) | FAN0 (`M106 P0` / `M107 P0`) |
| LaLi (GRBL) | `lali-grbl` | GRBL | Y (both motors in parallel) | Spindle PWM (`M3 S…` / `M5`) |

**How the machine is chosen:**

1. **Your pick wins:** clicking an option saves it in the browser, and the page asks for that machine every time it loads.
2. **Otherwise, auto-pick:** with nothing saved, the server pre-selects a machine from the board it finds (`detect_device()` and `DEVICE_PROFILES` in `app.py`):

   | Board | USB ID | Pre-selects |
   | --- | --- | --- |
   | BTT SKR | `1D50:6029` | Microscope controller |
   | Arduino Uno | `2341:0043` | SiSi Controller |
   | RUMBA (reports as an Arduino Mega 2560) | `2341:0042` | LaLi (Marlin) |
   | Anything else on a `usbmodem` / `usbserial` port | — | SiSi Controller |

**Switching machines** shuts the board down (outputs off, motors released), closes the port, and sets it up again with the new machine's startup sequence. The selector is ignored while Go! or Dispense is running. If setup fails, for example because you picked a Marlin machine for a GRBL board, the port is closed again and you can pick another option.

The firmware matters for a few commands. For example, `G4 P` (pause) means seconds on GRBL but milliseconds on Marlin. Routine pauses go through `dwellGCode(seconds)`, which writes the right form for the selected machine's firmware.

> **Preview mode:** `PREVIEW_WITHOUT_BOARD` at the top of `static/script.js` shows the selected machine's controls even with no board connected (or `PREVIEW_DEFAULT_MACHINE` if none is selected), which is useful for working on the UI. Set it to `false` for normal use.

## Controls on every machine

- **Movement speed / distance:** use the sliders, or click the bold number and type an exact value (e.g. `0.05` mm). Typed values can be finer than the slider steps. Movement distance starts at 5 mm, or 14.2 mm on LaLi (`DEFAULT_MOVEMENT_DISTANCE_MM` in `static/script.js`), and resets to that when you switch machines.
- **Arrow buttons / keyboard arrows:** move X and Y by the current distance at the current speed. Keyboard arrows are ignored while you're typing in a box.
- **Custom G-code:** type any G-code and press Send.
- **🎤 Listen:** toggles voice control (see [Voice commands](#voice-commands)).
- **🏠 Home:** homes the X axis (`G28 X`).
- **🛑 Stop!:** emergency stop. Halts motion immediately, cancels anything still queued, and switches the UV light, pump and fan off. A running Go!, Prime or Dispense stops where it is and nothing from it continues (Go! skips its remaining steps, including the syringe pull-up). Nothing stays locked: the next command works normally. On GRBL the reset loses the syringe coordinate, so press Set Home again before dragging the drawn syringe.

Every command sent is printed to the browser's developer console (`Sending G-code: …`) and to the terminal running `app.py` (`Sending: …`).

## Microscope platform 🐚🔬

Selector option: **Microscope controller**. A two-axis X/Y platform driven by an SKR board running Marlin.

**Extra control:** the fan button, which toggles the cooling fan (`M106` / `M107`). The fan is also switched on at startup.

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

- **Pump button:** toggles the pump on (`M8`) and off (`M9`). The icon animates while the pump is on.
- **💃 Dance:** traces a square the size of the current movement distance.
- **🧹 Sweep presets (10 s / 15 s / 20 s):** start the pump, sweep 2 inches along Y in the chosen time, move clear, then stop the pump. *These buttons are currently commented out in `templates/index.html`. Un-comment the `preset-buttons` block to bring them back.*
- **Voice:** "pump on/off" (or nozzle / sprayer / jet / water), and "pump pulse" for a short burst. These are ignored on other machines.

When the app closes it turns the pump off and releases the motors.

## Larvae Linker ("LaLi") 💉🔦

A dispensing and UV-curing line. It can run on either a RUMBA board with Marlin (selector option **LaLi (Marlin)**) or a GRBL board (selector option **LaLi (GRBL)**):

| Axis / output | LaLi (Marlin) | LaLi (GRBL) |
| --- | --- | --- |
| **Syringe plungers** | **B** and **C**, one motor each | **Y**, both motors wired in parallel |
| **Conveyor** | **X** | **X** |
| **UV light** | FAN0 | Spindle PWM pin (D11) via MOSFET |

For B and C, positive = plunge down and negative = pull up. On LaLi (GRBL) the syringes are on Y (`GRBL_SYRINGE_AXIS`), where positive = plunge down, like B and C. The direction is set by `AXIS_DIRECTION` in `static/script.js`. Since Y is the syringe axis there, the stage ▲/▼ arrows are hidden and the keyboard and directional voice commands don't move Y. The conveyor is set by `CONVEYOR_AXIS`, and the Go! routine advances it in the positive direction (`CONVEYOR_DIRECTION`; this only affects Go!, not the arrows). All of the syringe G-code goes through `syringeMoveGCode()` in `static/script.js`, which picks B + C or Y for the selected machine.

### Controls

- **Plunger Speed / Plunger Distance:** a second row of sliders, shown only on LaLi. They set the speed and step size for the syringe arrows (B/C on Marlin, Y on GRBL) and the speed of drag-to-position moves on the syringe. Like the Movement sliders, you can click the bold number to type an exact value. The Movement sliders still drive X/Y, the keyboard, voice and the conveyor. Dispense and Go! use their own fixed settings (`SYRINGE_PRESS_MM`, `SYRINGE_PRESS_FEEDRATE`, …).
- **Syringe arrows:**
  - **LaLi (Marlin):** B and C arrows (pink and black) move each syringe on its own by the current distance. The **🔓/🔒 Lock** between them makes any B or C arrow move **both** syringes together in a single command; amber lines join the arrows while locked.
  - **LaLi (GRBL):** one pair of ▲/▼ arrows under a 💉 label moves Y, which drives both syringes at once. There's no lock, since the motors are wired together.
- **Syringe position slider (LaLi (GRBL)):** a drawn syringe next to the syringe arrows. Its plunger runs from home (top, 0 mm) to full travel (bottom, `SYRINGE_TRAVEL_MM` = 40 mm). Grab anywhere on the syringe and drag; the plunger follows the pointer from where you grabbed it. The barrel has a volume scale (`SYRINGE_CAPACITY_ML` = 2.5 mL, assuming full travel empties the syringe) read at the stopper, like a real syringe.
  - **Starting level:** when LaLi (GRBL) is selected, the syringe starts at **1.5 mL** (`SYRINGE_START_ML`), i.e. 16 mm below home, and the board's Y coordinate is set to match (`G92 Y16`, which doesn't move anything). Load the syringes to 1.5 mL, or adjust the setting.
  - **Set Home** marks the current position as 1.5 mL (`SYRINGE_START_ML`): it sends `G92 Y16`, so the board and the drawn syringe agree. Nothing moves. The number above the syringe counts mm plunged from there, so it reads 0 mm at home (negative above it).
  - Releasing the drag moves the syringes to that position in absolute mode (`G90`, `G1 Y…`, `G91`), so the move is exact relative to home.
  - The arrows, Dispense and Go! still move relatively, and the slider follows them. The slider's readout is the page's running total: it doesn't see custom G-code or an emergency stop, and it starts at 1.5 mL (16 mm) when LaLi (GRBL) is selected. The slider moves themselves are always exact, because they use the board's coordinates.
- **💧 Prime (LaLi GRBL only):** primes the syringes before a run with fixed G-code (`PRIME_GCODE`): `G1 Y2 F500`, `G4 P1`, `G1 Y2 F500`, `G4 P0`, i.e. 2 plunges of 2 mm, 1 s apart. The label reads "Priming..." until the last plunge has finished. Pressing it more than once adds up (4 mm each). Ignored while Go! runs.
  - **Go! needs priming first (LaLi GRBL):** Go! is greyed out until Prime has been pressed. At the end of a run, finished or stopped, the primed distance resets and Go! is greyed out again. Any manual pull-up of the syringes (▲, or dragging the drawn syringe up) also resets it. Plunging down (▼, Dispense) doesn't change it, and neither does custom G-code, which the page doesn't track.
- **💉 Dispense:** one plunge of both syringes (down 1.5 mm). The label reads "Dispensing..." until the plunge has physically finished.
- **💡 UV Light:** toggles the UV strip (`M106 P0 S255` / `M107 P0` on Marlin, `M3 S1000` / `M5` on GRBL). Voice: "light on/off", "UV light on/off".
- **▶ Go!:** runs the full dispense-and-cure routine below, with a progress bar.

### The Go! routine

Each row is one step on the progress bar. Every step ends by waiting until all moves have physically finished (`G4 P0` on GRBL, `M400` on Marlin). That keeps the progress bar honest and makes each pause start after the motion before it has stopped.

| # | Step | What happens |
| --- | --- | --- |
| 1–12 | Cycles 1–12 | **UV on** (cycle 1 only). Then: 0.5 s settle, plunge 1.5 mm, wait 0.1 s, conveyor advances 14.2 mm |
| 13–23 | UV tunnel advances 1–11 | Wait 1.4 s, conveyor advances 14.2 mm, until the last row is through the tunnel |
| 24 | UV lights off | **UV off**, once the last advance has finished |
| 25 | Retract | Both syringes pull back up by everything Go! pushed plus everything primed (e.g. 12 × 1.5 + 4 = 22 mm after one Prime, at 600 mm/min), so they end where they were before priming |

Before pressing Go!, prime the syringes (💧 Prime; Go! stays greyed out until you do) and put the first row under them: Go! starts pressing right away.

The timing aims for **~45 s of UV per row**. The tunnel is 6" (152.4 mm), so a row's center stops 11 times inside it, and each cycle should take about 45 ÷ 11 ≈ 4.1 s. With X/Y acceleration at 10 mm/s² (`$120`/`$121`) and the conveyor at 500 mm/min (the Movement Speed slider), a press takes ~0.8 s, an advance ~2.5 s and the app adds ~0.2 s per step, so the waits make up the rest. The tunnel steps match a cycle's length so the last rows get the same dose. If the acceleration, speeds or tunnel change, re-time a few cycles and adjust `SYRINGE_WAIT_TIME` and `UV_ADVANCE_INTERVAL_S`. The syringe pull-up happens after the UV is off, so it doesn't affect the dose.

Over a full run the conveyor travels 23 × 14.2 = **326.6 mm**. Make sure X has that much room from where you start it.

While the routine runs, the "Go!" button glows and further clicks are ignored. If a step fails (e.g. the board disconnects), the routine stops there and the progress bar turns red and shows which step failed. In that case the remaining steps **do not** run: if it stops during the cycles the syringes stay pressed, and at any point before the last step the UV light stays on.

### Routine settings

All in `static/script.js`:

| Constant | Default | Meaning |
| --- | --- | --- |
| `SYRINGE_PRESS_MM` | 1.5 | Plunge distance per press (mm) |
| `SYRINGE_TRAVEL_MM` | 40 | Syringe slider range below home (mm) |
| `SYRINGE_CAPACITY_ML` | 2.5 | Volume the drawn syringe's scale shows over full travel (display only) |
| `SYRINGE_PRESS_FEEDRATE` | 200 | Plunge speed (mm/min) |
| `SYRINGE_RETRACT_FEEDRATE` | 600 | Pull-up speed at the end (mm/min) |
| `SEQUENCE_REPEATS` | 12 | Number of plunge cycles |
| `PRE_PLUNGE_PAUSE_S` | 0.5 | Settle time before each plunge (s) |
| `SYRINGE_WAIT_TIME` | 0.1 | Wait after each plunge before the conveyor moves (s) |
| `SEQUENCE_X_STEP_MM` | 14.2 | Conveyor advance per cycle and per UV tunnel step (mm) |
| `UV_ADVANCE_STEPS` | 11 | Extra advances after the last cycle so the last row passes through the UV tunnel. At 0, UV goes off and the syringes pull back up right after the last cycle |
| `UV_ADVANCE_INTERVAL_S` | 1.4 | Wait before each UV tunnel advance (s); set so a tunnel step lasts as long as a cycle |
| `CONVEYOR_AXIS` | `'X'` | Axis that drives the conveyor |
| `CONVEYOR_DIRECTION` | 1 | Direction Go! advances the conveyor (1 = positive, -1 = negative) |

The conveyor moves use the current **Movement Speed** slider. The syringe moves use their own fixed feed rates.

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
| "dance", "say yes", "say no", "do the cha cha slide", "run test" | Demo moves |

## Known issues

- **Auto-pick and Arduino Megas:** the RUMBA shares the generic Arduino Mega USB ID (`2341:0042`), so any Mega pre-selects LaLi (Marlin). Pick the right option in the selector if that's wrong; your choice is remembered.
- **🏠 Home on GRBL:** `G28 X` homes on Marlin, but on GRBL `G28` means "go to the stored G28 position", not homing (that's `$H`, which needs limit switches).
- **Hand-written pauses:** the "pump pulse", "run test" and "cha cha slide" voice commands contain fixed `G4 P…` values in milliseconds. That's correct on Marlin, but GRBL reads them as seconds.

## Images

<img height="525" alt="Screenshot 2025-03-16 at 7 22 38 PM" src="https://github.com/user-attachments/assets/658c916f-6e12-439e-a176-e953ea95c08f" />

<img height="525" alt="Screenshot 2025-03-16 at 7 22 38 PM" src="https://github.com/user-attachments/assets/32dad650-8c02-45df-b3a2-e2f008e339c5" />

<img height="400" alt="Screenshot 2025-03-24 at 5 38 48 PM" src="https://github.com/user-attachments/assets/6b1ab9a8-afb6-4f28-8e35-ccb6ed528440" />

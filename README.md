# LaLi-Sisi-Controller

A web interface for controlling stepper-motor machines over a serial connection. Motors can be controlled with on-screen buttons, arrow keys, or voice commands (e.g. "move right 15 millimeters").

The same app drives three different machines. It detects which board is plugged in and shows the controls for that machine:

| Machine | Board | What it does | Extra controls |
| --- | --- | --- | --- |
| **Microscope platform** | BTT SKR (Marlin) | Moves a camera/sample platform on X and Y | Cooling fan |
| **Tank cleaner** | Arduino running GRBL | Sweeps a nozzle across a tank with a water pump | Pump, sweep presets |
| **LaLi** | RUMBA (Marlin) | Dispenses prepolymer from two syringes onto a tray, then carries the tray through a UV curing tunnel on a conveyor | B/C syringe axes, Dispense, UV light, automated "Go!" routine |

## Building & Running

The app can be run by simply running `./run.sh` from the root folder. This will handle installing dependencies and creating a virtual environment. URLs to access the webapp will be printed to the console.

To build the standalone app, run `./build.sh`. This will first compile the Flask app and its associated static assets into a binary, then this binary is copied into the Electron app's dist folder, where the Electron app is then built with the Flask binary as a bundle resource. The final product ends up in the root build folder as a standalone app which when opened will spin up the Flask server, check for a serial connection with the controller board, and get the urls for opening the web app, displaying them in the main window.

## How the board is detected

On page load the app calls `/initialize`, which looks for a board in this order (`detect_device()` in `app.py`):

1. **Known USB IDs** in `DEVICE_PROFILES`:

   | Profile | USB ID | Firmware | Machine |
   | --- | --- | --- | --- |
   | `skr` | `1D50:6029` | Marlin | Microscope platform |
   | `grbl` | `2341:0043` (Arduino Uno) | GRBL | Tank cleaner |
   | `rumba` | `2341:0042` (reports as an Arduino Mega 2560) | Marlin | LaLi |

2. **Fallback:** any other `usbmodem`/`usbserial` port is treated as GRBL.

Each profile's `firmware` setting decides how the board is initialized and which G-code dialect the page uses. The `rumba` profile also has `bc_axes: True`, which shows the LaLi controls and hides the fan, pump and dance buttons. Ports listed in `MULTI_AXIS_PORT_IDS` in `app.py` (currently `usbmodem1101`) also get the LaLi controls, as a fallback.

On the RUMBA, FAN0 is the UV light, so unlike the SKR it is **not** switched on at startup. It starts off.

> **Preview mode:** `PREVIEW_BC_MACHINE` at the top of `static/script.js` forces the LaLi layout even with no board connected, which is useful for working on the UI. Set it to `false` for normal use.

The firmware matters for a few commands. For example, `G4 P` (pause) means seconds on GRBL but milliseconds on Marlin. Routine pauses go through `dwellGCode(seconds)`, which writes the right form for the detected firmware.

## Controls on every machine

- **Movement speed / distance:** use the sliders, or click the bold number and type an exact value (e.g. `0.05` mm). Typed values can be finer than the slider steps.
- **Arrow buttons / keyboard arrows:** move X and Y by the current distance at the current speed. Keyboard arrows are ignored while you're typing in a box.
- **Custom G-code:** type any G-code and press Send.
- **🎤 Listen:** toggles voice control (see [Voice commands](#voice-commands)).
- **🏠 Home:** homes the X axis (`G28 X`).
- **🛑 Stop!:** emergency stop (`M410`).

Every command sent is printed to the browser's developer console (`Sending G-code: …`) and to the terminal running `app.py` (`Sending: …`).

## Microscope platform

A two-axis X/Y platform driven by an SKR board running Marlin.

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

## Coral Cleaner ("CC" or "SiSi")

A GRBL-controlled gantry with a water pump attached, used to sweep a spray nozzle across a tank. The pump is switched with GRBL's coolant commands.

**Extra controls:**

- **Pump button:** toggles the pump on (`M8`) and off (`M9`). The icon animates while the pump is on.
- **💃 Dance:** traces a square the size of the current movement distance.
- **🧹 Sweep presets (10 s / 15 s / 20 s):** start the pump, sweep 2 inches along Y in the chosen time, move clear, then stop the pump. *These buttons are currently commented out in `templates/index.html`. Un-comment the `preset-buttons` block to bring them back.*
- **Voice:** "pump on/off" (or nozzle / sprayer / jet / water), and "pump pulse" for a short burst.

When the app closes it turns the pump off and releases the motors.

## Larvae Linker ("LaLi")

A dispensing and UV-curing line driven by a RUMBA board running Marlin:

| Axis / output | What's connected |
| --- | --- |
| **B** and **C** | The two syringe plungers. Positive = plunge down, negative = pull up. |
| **X** | The conveyor that carries the tray. The routine advances it in the negative direction. Set by `CONVEYOR_AXIS`. |
| **FAN0** | UV LED strip in the curing tunnel |

### Controls

- **B and C arrows** (pink and black): move each syringe on its own by the current distance.
- **🔓/🔒 Lock** (between B and C): when locked, any B or C arrow moves **both** syringes together in a single command. Amber lines join the arrows while locked.
- **💉 Dispense:** one plunge of both syringes (B and C down 1.5 mm). The label reads "Dispensing..." until the plunge has physically finished.
- **💡 UV Light:** toggles the UV strip (`M106 P0 S255` / `M107 P0`). Voice: "light on/off", "UV light on/off".
- **▶ Go!:** runs the full dispense-and-cure routine below, with a progress bar.

### The Go! routine

Each row is one step on the progress bar. Every step ends by waiting until all moves have physically finished (`G4 P0` on GRBL, `M400` on Marlin). That keeps the progress bar honest and makes each pause start after the motion before it has stopped.

| # | Step | What happens |
| --- | --- | --- |
| 1 | Priming | 2 plunges with 1 s between them, then the conveyor moves 14.5 mm into place |
| 2–13 | Cycles 1–12 | **UV on** (cycle 1 only). Then: 0.5 s settle, plunge 1.5 mm, wait 4 s, conveyor advances 14.5 mm |
| 14–22 | UV tunnel advances 1–9 | Wait 5 s, conveyor advances 14.5 mm, until the tray is fully through the tunnel |
| 23 | Retract | **UV off**, then both syringes pull back up by everything they pushed (14 × 1.5 = 21 mm) |

Over a full run the conveyor travels 22 × 14.5 = **319 mm**. Make sure X has that much room from where you start it.

While the routine runs, the "Go!" button glows and further clicks are ignored. If a step fails (e.g. the board disconnects), the routine stops there and the progress bar turns red and shows which step failed. In that case the retract **does not** run, so the syringes stay pressed and the UV light stays on.

### Routine settings

All in `static/script.js`:

| Constant | Default | Meaning |
| --- | --- | --- |
| `SYRINGE_PRESS_MM` | 1.5 | Plunge distance per press (mm) |
| `SYRINGE_PRESS_FEEDRATE` | 200 | Plunge speed (mm/min) |
| `SYRINGE_RETRACT_FEEDRATE` | 600 | Pull-up speed at the end (mm/min) |
| `PRIMING_PRESSES` | 2 | Plunges during priming |
| `PRIMING_PAUSE_S` | 1 | Pause between priming plunges (s) |
| `PRIMING_X_MOVE_MM` | 14.5 | Conveyor move into place after priming (mm) |
| `SEQUENCE_REPEATS` | 12 | Number of plunge cycles |
| `PRE_PLUNGE_PAUSE_S` | 0.5 | Settle time after a conveyor move, before the next plunge (s) |
| `SYRINGE_WAIT_TIME` | 4 | Wait after each plunge before the conveyor moves (s) |
| `SEQUENCE_X_STEP_MM` | 14.5 | Conveyor advance per cycle and per UV tunnel step (mm) |
| `UV_ADVANCE_STEPS` | 9 | Extra advances after the last cycle to clear the UV tunnel |
| `UV_ADVANCE_INTERVAL_S` | 5 | Wait before each UV tunnel advance (s) |
| `CONVEYOR_AXIS` | `'X'` | Axis that drives the conveyor |

The conveyor moves use the current **Movement Speed** slider. The syringe moves use their own fixed feed rates.

## Voice commands

Click 🎤 to start listening, and click again or say "stop listening" to stop.

| Say | Does |
| --- | --- |
| "move/go/slide/shift up/down/left/right *N* mm/inches/microns" | Move Y (up/down) or X (left/right) by that amount |
| "move up/down/left/right" | Move 10 mm |
| "draw/make a *N* mm square" | Trace a square |
| "stop" | Release the motors (`M84`) |
| "pump on/off", "nozzle/sprayer/jet/water on/off", "pump pulse" | Tank cleaner pump |
| "fan on/off" | Microscope fan (ignored on LaLi) |
| "light on/off", "UV light on/off" | LaLi UV light (ignored on other machines) |
| "depress syringe(s)", "deposit/extrude/pipette prepolymer" | One LaLi syringe plunge |
| "dance", "say yes", "say no", "do the cha cha slide", "run test" | Demo moves |

## Known issues

- **Any Arduino Mega is treated as the RUMBA:** the RUMBA shares the generic Arduino Mega USB ID (`2341:0042`), so any Mega plugged in is set up as LaLi with Marlin. If the RUMBA is ever reflashed with GRBL, change its `firmware` to `'grbl'` in `DEVICE_PROFILES`.
- **Stop! on GRBL:** `M410` is a Marlin command. GRBL boards reject it.
- **Hand-written pauses:** the "pump pulse", "run test" and "cha cha slide" voice commands contain fixed `G4 P…` values in milliseconds. That's correct on Marlin, but GRBL reads them as seconds.

## Images

<img height="525" alt="Screenshot 2025-03-16 at 7 22 38 PM" src="https://github.com/user-attachments/assets/658c916f-6e12-439e-a176-e953ea95c08f" />

<img height="525" alt="Screenshot 2025-03-16 at 7 22 38 PM" src="https://github.com/user-attachments/assets/32dad650-8c02-45df-b3a2-e2f008e339c5" />

<img height="400" alt="Screenshot 2025-03-24 at 5 38 48 PM" src="https://github.com/user-attachments/assets/6b1ab9a8-afb6-4f28-8e35-ccb6ed528440" />

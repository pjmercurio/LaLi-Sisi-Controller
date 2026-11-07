const fanSpeed = 255;
const INCH_TO_MM = 25.4;
let feedRate = 400;          // Movement Speed: X/Y, keyboard, voice, conveyor
let distance = 50;           // Movement Distance
let plungerFeedRate = 200;   // Plunger Speed: syringe arrows and the drag-to-position syringe (LaLi)
let plungerDistance = 0.67;   // Plunger Distance: syringe arrows (LaLi), always in mm; the slider can show it in µL
const DEFAULT_PLUNGER_UL = 40; // Plunger Distance on LaLi (GRBL), which starts in µL
let plungerUnit = 'mm';        // the Plunger Amount unit ('mm' or 'ul'); the readout above the syringe uses it too

// TEMPORARY: show the selected machine's controls even when no board is connected (for UI work).
// Set back to false once testing with the real machine.
const PREVIEW_WITHOUT_BOARD = true;
const PREVIEW_DEFAULT_MACHINE = 'lali-grbl'; // shown in preview mode if no machine has been chosen yet

const SYRINGE_PRESS_MM = 0.67;
// Syringe calibration (LaLi GRBL). Y0 is Set Home: syringes at SYRINGE_HOME_ML with their holder plate
// against the stepper. Plunging SYRINGE_TRAVEL_MM takes them to SYRINGE_END_ML. Syringe moves that would
// go above Y0 or past SYRINGE_TRAVEL_MM are refused.
const SYRINGE_TRAVEL_MM = 44;
const SYRINGE_HOME_ML = 2.77; // at Y0
const SYRINGE_END_ML = 0.1;   // at Y = SYRINGE_TRAVEL_MM
const SYRINGE_CAPACITY_ML = 3; // the drawn syringe's scale (its barrel goes 0 to this)
// Start-volume presets: after Set Home, picking one plunges the syringes down to it. Reset comes back to it.
const SYRINGE_PRESETS_ML = [2.5, 1.5];
// Per-machine axis direction flips (-1 = inverted). Applied to the arrows, keyboard,
// directional voice commands and syringe moves. On LaLi (GRBL), plunging down is positive Y.
const AXIS_DIRECTION = {
    'lali-grbl': { Y: 1 },
};
// LaLi (GRBL): both syringe motors are wired in parallel on this axis. The stage controls
// (▲/▼ arrows, keyboard, voice) don't move it there, so they can't plunge the syringes.
const GRBL_SYRINGE_AXIS = 'Y';
// Movement Distance each machine starts with (mm); others use the page's default.
// Applied when switching to the machine, so a value you set stays while you use it.
const DEFAULT_MOVEMENT_DISTANCE_MM = {
    'lali-marlin': 14.2,
    'lali-grbl': 14.2,
};
const SYRINGE_PRESS_FEEDRATE = 200;
const SYRINGE_RETRACT_FEEDRATE = 600;
// Timing is set for ~45 s of UV per row: a row's center stops 11 times in the 6" (152.4 mm) tunnel,
// so each cycle should take ~4.1 s. At X/Y acceleration 10 mm/s² and the conveyor at F500, the
// press takes ~0.8 s, the advance ~2.5 s and the app ~0.2 s per request; these waits make up the rest.
// Re-time a run if the acceleration, speeds or tunnel change.
const SYRINGE_WAIT_TIME = 0.1; // seconds to wait after a syringe press before the conveyor moves
const PRE_PLUNGE_PAUSE_S = 0.5; // settle time before each plunge
const SEQUENCE_REPEATS = 12;
const PRIME_TOTAL_MM = 1;
const PRIME_GCODE = `
G1 Y${PRIME_TOTAL_MM} F500
G4 P0
`;
const CONVEYOR_AXIS = 'X';
// Direction the Go! routine advances the conveyor (1 = positive, -1 = negative). Only affects Go!.
const CONVEYOR_DIRECTION = 1;
const SEQUENCE_X_STEP_MM = 14.2;
// After the last syringe cycle, keep advancing the conveyor until the last row is through the UV tunnel.
// 11 steps take the last row past all 11 stops. At 0, UV off follows the last cycle.
const UV_ADVANCE_STEPS = 11;
// Wait before each tunnel advance. 1.4 s + the advance + overhead ≈ one cycle (~4.1 s),
// so the last rows get the same UV time as the rest
const UV_ADVANCE_INTERVAL_S = 1.4;
// LaLi (GRBL) drives the UV MOSFET from the spindle PWM pin (D11). Full brightness = S at
// GRBL 0.9's SPINDLE_MAX_RPM (config.h, default 1000; on GRBL 1.1 it's the $30 setting).
const UV_SPINDLE_MAX_S = 1000;
// GRBL's step idle delay ($1): Go! keeps the motors powered for the whole run (255 = never switch off), then puts
// back the usual delay (ms after each move before they switch off). app.py also sets the usual delay on connect.
const STEPPER_HOLD_IDLE = 255;
const STEPPER_RELEASE_IDLE_MS = 25;

let currentMachine = null;  // 'microscope', 'sisi', 'lali-marlin' or 'lali-grbl', from /initialize
let currentFirmware = null; // 'grbl' or 'marlin', from /initialize

function sendGCode(gcode) {
    // Log each non-empty, non-comment line exactly as the server will send it
    const lines = gcode.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith(';'));
    console.log('Sending G-code:\n' + lines.join('\n'));

    return fetch('/send_gcode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gcode: gcode })
    })
    .then(response => response.json())
    .then(data => {
        console.log('G-code sent:', data.message);
    })
    .catch(error => {
        console.error('Error sending G-code:', error);
    });
}

// Like sendGCode, but rejects if the server reports an error, so a sequence can stop
async function sendGCodeOrThrow(gcode) {
    console.log('Sending G-code:\n' + gcode);
    const response = await fetch('/send_gcode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gcode: gcode })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
}

function axisDirection(axis) {
    return AXIS_DIRECTION[currentMachine]?.[axis] ?? 1;
}

function move(axis, distance) {
    if (currentMachine === 'lali-grbl' && axis === GRBL_SYRINGE_AXIS) {
        console.log(`Ignoring ${axis} move: that's the syringe axis on LaLi (GRBL)`);
        return;
    }
    if (currentMachine?.startsWith('lali') && axis === CONVEYOR_AXIS && conveyorArrowsBlocked()) {
        console.warn('Conveyor move ignored: a drag or Reset Conveyor is moving it, or Go! is running');
        return;
    }
    // After Set Home, a conveyor move that would take the tray past Set Home or past where a full Go! run
    // leaves it does nothing (same limits as dragging the tiles)
    const conveyorDelta = distance * axisDirection(axis) * CONVEYOR_DIRECTION;
    if (currentMachine === 'lali-grbl' && axis === CONVEYOR_AXIS && homeSet) {
        const to = conveyorMm + conveyorDelta;
        if (to < -1e-3 || to > CONVEYOR_DRAG_MAX_MM + 1e-3) {
            console.warn(`Conveyor move refused: it would take the tray to ${to.toFixed(2)} mm, outside 0–${CONVEYOR_DRAG_MAX_MM} mm`);
            return;
        }
    }
    const gcode = `G1 ${axis}${distance * axisDirection(axis)} F${feedRate}`;
    sendGCode(gcode);
    if (currentMachine?.startsWith('lali') && axis === CONVEYOR_AXIS) {
        noteConveyorMove(conveyorDelta);
    }
}

// Goes to its own route, which writes straight to the board instead of queueing behind other commands:
// GRBL gets feed hold + soft reset, Marlin gets M410. Anything waiting on the board (e.g. Go!) is cancelled.
// Each press bumps stopCount, so a routine (Go!) stops before its next step instead of carrying on.
// Nothing stays locked: the next command after Stop works normally.
let stopCount = 0;

function emergencyStop() {
    console.warn('Emergency stop');
    stopCount++;
    freezeTiles();
    stopSyringeDragMove();
    conveyorDragMoveEnd = 0;
    // The board switches its outputs off (see /stop), so show them off
    ['light-button', 'pump-button', 'fan-button'].forEach(id => document.getElementById(id)?.classList.remove('active'));
    fetch('/stop', { method: 'POST' })
        .then(response => response.json())
        .then(data => console.log('Stop:', data.message || data.error))
        .catch(error => console.error('Error sending stop:', error));
}

// Always pass seconds. G4 P means milliseconds on Marlin but seconds on GRBL,
// so this converts for Marlin. Use it for every routine pause rather than writing G4 by hand.
function dwellGCode(seconds) {
    if (currentFirmware === 'marlin') {
        return `G4 P${Math.round(seconds * 1000)}`;
    }
    if (!currentFirmware) {
        console.warn(`Firmware unknown; assuming GRBL for a ${seconds} s pause (G4 P${seconds})`);
    }
    return `G4 P${seconds}`;
}

// Wait until all queued moves have physically finished
function syncGCode() {
    return currentFirmware === 'marlin' ? 'M400' : 'G4 P0';
}

// Moves both syringes by mm (positive = down, matching the ▼ buttons).
// LaLi (GRBL) drives both syringe motors in parallel from GRBL_SYRINGE_AXIS; LaLi (Marlin) uses B and C.
function syringeMoveGCode(mm, feed) {
    if (currentMachine === 'lali-grbl') return `G1 ${syringeAxesWords(mm)} F${feed}`;
    return `G1 B${mm} C${mm} F${feed}`;
}

function conveyorAdvanceGCode(mm) {
    return `G1 ${CONVEYOR_AXIS}${mm * CONVEYOR_DIRECTION} F${feedRate}`;
}

function syringePressGCode() {
    return syringeMoveGCode(SYRINGE_PRESS_MM, SYRINGE_PRESS_FEEDRATE);
}

// --- Syringe position slider (LaLi GRBL) ---
// Position = Y in mm below Set Home (positive = down), 0 to SYRINGE_TRAVEL_MM. The board keeps the real
// coordinate: Set Home sets it to Y0 with G92, and the slider and presets move in absolute mode, so those
// moves are exact. syringePosMm is only the page's running total for drawing the slider and checking the
// limits, updated by every syringe move it sends; it doesn't see custom G-code or an emergency stop. It
// starts at 0 when LaLi (GRBL) is selected, and the board's coordinate is set to match.
let syringePosMm = 0;
let syringePresetMl = null; // the start volume picked since Set Home; null = none (Reset goes to Y0)

// mm below Set Home at which the syringes hold this many mL
function syringeMmForMl(ml) {
    return Number(((SYRINGE_HOME_ML - ml) / (SYRINGE_HOME_ML - SYRINGE_END_ML) * SYRINGE_TRAVEL_MM).toFixed(4));
}

function syringeMlForMm(mm) {
    return SYRINGE_HOME_ML - mm / SYRINGE_TRAVEL_MM * (SYRINGE_HOME_ML - SYRINGE_END_ML);
}

// Where Reset puts the syringes: the picked preset, or Set Home if none
function syringeStartMm() {
    return syringePresetMl === null ? 0 : syringeMmForMl(syringePresetMl);
}

// Refuses (with a warning) a syringe move that would take the plunger above Set Home or past full travel.
// Only once Set Home has been pressed (homeSet): before that the page doesn't know where the syringes are.
function syringeMoveInRange(toMm) {
    if (currentMachine !== 'lali-grbl' || !homeSet) return true;
    if (toMm >= -1e-3 && toMm <= SYRINGE_TRAVEL_MM + 1e-3) return true;
    console.warn(`Syringe move refused: it would take the plunger to ${toMm.toFixed(2)} mm, outside 0–${SYRINGE_TRAVEL_MM} mm`);
    return false;
}

function syringeAxesWords(mm) {
    if (currentMachine === 'lali-grbl') return `${GRBL_SYRINGE_AXIS}${mm * axisDirection(GRBL_SYRINGE_AXIS)}`;
    return `B${mm} C${mm}`;
}

function noteSyringeMove(mm) {
    syringePosMm = Number((syringePosMm + mm).toFixed(4));
    showSyringePosition(syringePosMm);
    updateResetButton();
}

function showSyringePosition(mm) {
    const slider = document.getElementById('syringe-slider');
    if (!slider) return;
    slider.value = Math.min(Math.max(mm, 0), SYRINGE_TRAVEL_MM); // draws at the end stop if outside the range
    showSyringeReadout(mm);
    fillSyringeSlider(parseFloat(slider.value));
}

// The number above the syringe, in the Plunger Amount's unit: mm plunged below Set Home (Y), so it reads 0
// there, or (µL) the mL each syringe holds, read like the barrel scale. Left alone while it's being typed in.
function showSyringeReadout(mm) {
    const box = document.getElementById('syringe-position');
    const ml = plungerUnit === 'ul';
    document.getElementById('syringe-position-unit').textContent = ml ? '\u00a0mL' : '\u00a0mm';
    if (document.activeElement === box) return;
    const value = Number((ml ? syringeMlForMm(mm) : mm).toFixed(2));
    box.value = value === 0 ? 0 : value;
}

// Moves the drawn plunger to the volume at mm: --pos goes from 0 (SYRINGE_CAPACITY_ML) to 1 (empty)
function fillSyringeSlider(mm) {
    const fraction = 1 - syringeMlForMm(mm) / SYRINGE_CAPACITY_ML;
    document.getElementById('syringe-visual').style.setProperty('--pos', fraction);
}

// --- Priming (LaLi GRBL) ---
// Each Prime adds to primedMm, so Go!'s position check expects the syringes that far below their Start Volume
// (Go! doesn't need a Prime; the confirm checklist asks instead). A manual pull-up (▲, or
// dragging the syringe up), Reset Syringes, a Start Volume pick and the end of a Go! run (finished or stopped)
// reset it.
let primedMm = 0;

function setPrimedMm(mm) {
    primedMm = mm;
    updatePlayButton();
}

// Only LaLi (GRBL) has the presets, so only it waits for one. There, Go! also needs everything
// where you set it, by the page's running totals: the tray at tile 1 (Set Home's X0) and the syringes exactly at
// their Start Volume plus what Prime pushed (so any other plunge or pull-up since disables it), with no reset or
// preset move under way. Called wherever any of those change (also from updateResetButton). Left alone during a run.
function updatePlayButton() {
    const playButton = document.getElementById('play-button');
    if (!playButton || playButton.classList.contains('active')) return;
    playButton.dataset.title ??= playButton.title;
    const lali = currentMachine === 'lali-grbl';
    const reason =
        !lali ? null
        : homeLost ? 'The board reconnected: press 🏡 Set Home and pick a start volume first'
        : syringePresetMl === null ? 'Pick a start volume (2.5 or 1.5 mL) first'
        : resetRunning || syringePresetMoving ? 'Wait for the syringes / conveyor to finish moving'
        : Math.abs(conveyorMm) > 1e-3 ? 'The tray isn’t at tile 1: press ↩️ Reset Conveyor first'
        : Math.abs(syringePosMm - (syringeStartMm() + primedMm)) > 1e-3
            ? `The syringes have moved from their ${syringePresetMl} mL start: press 💉 Reset Syringes`
        : null;
    playButton.disabled = reason !== null;
    playButton.title = reason ?? playButton.dataset.title;
}

function moveSyringes(mm) {
    if (syringeDragMoving()) {
        console.warn('Syringe move ignored: the syringes are still moving to where they were dragged');
        return;
    }
    if (!syringeMoveInRange(syringePosMm + mm)) return;
    if (mm > 0 && plungeBlockedByConveyor()) return;
    sendGCode(syringeMoveGCode(mm, plungerFeedRate));
    noteSyringeMove(mm);
    if (mm < 0) setPrimedMm(0);
    if (mm > 0) markTileUnderNeedle(mm);
}

// Voice "dispense 0.2 mL" (LaLi GRBL): plunges both syringes by that volume each, converted with the
// calibration (SYRINGE_HOME_ML to SYRINGE_END_ML over SYRINGE_TRAVEL_MM), at the Plunger Speed. Goes through
// moveSyringes, so it has the same travel limit and conveyor block, and marks the tile under the needle.
function dispenseMl(ml) {
    if (currentMachine !== 'lali-grbl') { console.log(`Ignoring "dispense ${ml} mL": only LaLi (GRBL) has the mL calibration`); return; }
    if (!(ml > 0)) { console.warn('Dispense ignored: no volume heard'); return; }
    if (document.getElementById('play-button').classList.contains('active') || resetRunning || syringePresetMoving) {
        console.warn(`Dispense ${ml} mL ignored while a routine is moving the syringes`);
        return;
    }
    const mm = Number((ml / (SYRINGE_HOME_ML - SYRINGE_END_ML) * SYRINGE_TRAVEL_MM).toFixed(4));
    if (syringePosMm + mm > SYRINGE_TRAVEL_MM + 1e-3) {
        const left = Math.max(syringeMlForMm(syringePosMm) - SYRINGE_END_ML, 0);
        console.warn(`Can't dispense ${ml} mL: only ${left.toFixed(2)} mL left before the end of travel`);
        return;
    }
    console.log(`Dispensing ${ml} mL from each syringe: ${mm} mm`);
    moveSyringes(mm);
}

// A spoken amount as a number: digits ("0.25", ".5"), number words up to ten, "point" decimals
// ("one point five", "point two five"), and "half", "a quarter", "three quarters". NaN if it isn't one.
const SPOKEN_DIGITS = { zero: 0, oh: 0, o: 0, one: 1, won: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4,
    five: 5, six: 6, seven: 7, eight: 8, ate: 8, nine: 9, ten: 10 };
function parseSpokenAmount(text) {
    text = text.trim().replace(/\s+(?:of\s+)?an?$/, ''); // "half a", "a quarter of a"
    const fractions = { 'half': 0.5, 'a half': 0.5, 'one half': 0.5, 'quarter': 0.25, 'a quarter': 0.25,
        'one quarter': 0.25, 'three quarters': 0.75, 'three quarter': 0.75 };
    if (text in fractions) return fractions[text];
    if (/^\d*\.?\d+$/.test(text)) return parseFloat(text);
    const [whole, decimals] = text.split(/\s*\bpoint\b\s*/);
    const wholeValue = whole === '' ? 0 : (/^\d+$/.test(whole) ? parseInt(whole) : SPOKEN_DIGITS[whole]);
    if (wholeValue === undefined) return NaN;
    if (decimals === undefined) return wholeValue;
    // "point two five" → .25; "point 25" → .25
    const digits = decimals.split(/\s+/).map(word => /^\d+$/.test(word) ? word : SPOKEN_DIGITS[word]);
    if (digits.some(d => d === undefined || d === 10)) return NaN;
    return parseFloat(`${wholeValue}.${digits.join('')}`);
}

function moveSyringesTo(mm) {
    if (refusedWhileHomeLost('Dragging the syringe') || !syringeMoveInRange(mm) || (mm > syringePosMm && plungeBlockedByConveyor())) {
        showSyringePosition(syringePosMm); // put the dragged plunger back
        return;
    }
    if (mm < syringePosMm) setPrimedMm(0);
    if (mm > syringePosMm) markTileUnderNeedle(mm - syringePosMm);
    sendGCode(['G90', `G1 ${syringeAxesWords(mm)} F${plungerFeedRate}`, 'G91'].join('\n'));
    // The plunger stays where it was dropped. ▲/▼ wait until the real one would get there.
    const feed = Math.min(plungerFeedRate, SYRINGE_MAX_FEED);
    showSyringePosition(mm);
    syringeDragMoveEnd = performance.now() + (REQUEST_OVERHEAD_S + moveSeconds(mm - syringePosMm, feed, SYRINGE_ACCEL)) * 1000;
    syringePosMm = mm;
    updateResetButton();
    updateSyringeArrows();
}

// Until when the syringes are moving to where they were dragged (by the page's motion model)
let syringeDragMoveEnd = 0;
function syringeDragMoving() {
    return performance.now() < syringeDragMoveEnd;
}

// Stop during that move: ▲/▼ work again straight away (the drawing stays where it was dropped)
function stopSyringeDragMove() {
    syringeDragMoveEnd = 0;
}

// Greys out the syringe ▲/▼ while the syringes move to where they were dragged, with "Syringes moving..."
// above them. Polled with the conveyor arrows.
function updateSyringeArrows() {
    const moving = syringeDragMoving();
    document.querySelectorAll('.syringe-controller .arrow').forEach(button => { button.disabled = moving; });
    const status = document.getElementById('syringes-moving');
    if (status) status.hidden = !moving;
}

// Set Home: the syringes are at SYRINGE_HOME_ML right now (holder plate against the stepper) and tile 1 is
// under the needle, so Y and the conveyor are both 0 (G92 doesn't move anything). The preset is cleared
// until one is picked again, and the tile strip goes back to home.
function setSyringeHome() {
    setHomeLost(false);
    setHomeSet(true);
    sendGCode(`G92 ${CONVEYOR_AXIS}0 ${syringeAxesWords(0)}`);
    syringePosMm = 0;
    showSyringePosition(0);
    showSyringePreset(null);
    setPrimedMm(0);
    resetTiles(); // updates the Reset button
}

// After the board reconnects (LaLi GRBL): plugging an Arduino in resets it, so GRBL has forgotten Set Home's
// coordinates and the drawings no longer match the machine. Until Set Home is pressed again, Go! and everything
// that moves to a position on those coordinates (Start Volume, Reset Syringes / Reset Conveyor, dragging the
// syringe) are disabled. The arrows, keys and Prime move relatively, so they still work.
let homeLost = false;
// Whether 🏡 Set Home has been pressed since LaLi (GRBL) was picked or the board reconnected. Until then the
// arrows, keys and typed positions have no travel limits (so the syringes and tray can be lined up first).
// Dragging the syringe or tiles (and typing a syringe position) needs it too. body.home-set shows the drag cursors.
let homeSet = false;
function setHomeSet(set) {
    homeSet = set;
    document.body.classList.toggle('home-set', set);
    const label = document.getElementById('set-home-label');
    if (label) label.textContent = set ? 'Re-Set Home' : 'Set Home';
}

// Dragging moves to a position on Set Home's coordinates, so it waits for Set Home
function refusedBeforeHome(what) {
    if (homeSet) return false;
    console.warn(`${what} ignored: press 🏡 Set Home first (until then, use the arrows or keys)`);
    return true;
}

function setHomeLost(lost) {
    homeLost = lost;
    if (lost) setHomeSet(false);
    if (lost) {
        showSyringePreset(null); // the preset and prime were on the old coordinates
        setPrimedMm(0);
    }
    document.querySelectorAll('#syringe-preset [data-ml]').forEach(button => { button.disabled = lost; });
    updateResetButton(); // also updates Go!
}

function refusedWhileHomeLost(what) {
    if (!homeLost) return false;
    console.warn(`${what} ignored: the board reconnected, so press 🏡 Set Home first`);
    return true;
}

// Start-volume preset: plunges (or pulls) the syringes to that volume in absolute mode. Doesn't mark a tile:
// it's setting up, not dispensing onto one. Ignored while anything else is moving the syringes.
let syringePresetMoving = false;
async function pickSyringePreset(ml) {
    if (refusedWhileHomeLost('Start Volume')) return;
    const mm = syringeMmForMl(ml);
    const busy = syringePresetMoving || resetRunning || document.getElementById('play-button').classList.contains('active');
    if (busy || !syringeMoveInRange(mm) || (mm > syringePosMm && plungeBlockedByConveyor())) return;
    syringePresetMoving = true;
    showSyringePreset(ml);
    setPrimedMm(0); // Go!'s pull-up is measured from here now
    const feed = Math.min(plungerFeedRate, SYRINGE_MAX_FEED);
    trackSyringeMove(syringePosMm, mm, feed, REQUEST_OVERHEAD_S);
    try {
        await sendGCodeOrThrow(['G90', `G1 ${syringeAxesWords(mm)} F${plungerFeedRate}`, 'G91', syncGCode()].join('\n'));
    } catch (error) {
        console.warn('Preset: no response from the board, so the syringes may not have moved. Showing them at the preset anyway.', error);
    } finally {
        stopSyringeTrack();
        syringePosMm = mm;
        showSyringePosition(mm);
        syringePresetMoving = false;
        updateResetButton();
    }
}

function showSyringePreset(ml) {
    syringePresetMl = ml;
    document.querySelectorAll('#syringe-preset [data-ml]').forEach(button => {
        const selected = parseFloat(button.dataset.ml) === ml;
        button.classList.toggle('active', selected);
        button.setAttribute('aria-checked', selected);
    });
    updateResetButton();
    updatePlayButton(); // Go! needs a preset
}

// --- Reset Syringes / Reset Conveyor (LaLi GRBL) ---
// Each drives its part back to where you set it: the syringes to the picked Start Volume (or Set Home, Y0, if
// none), the conveyor to Set Home (X0, tile 1 under the needle). GRBL runs one move at a time, so two separate
// requests can't overlap. Instead a press waits RESET_PAIR_WINDOW_S before sending: press the other button in
// that time and both go in one G1 X… Y… line, starting and finishing together. Pressed later, while a reset is
// already moving, it runs straight after.
const RESET_PAIR_WINDOW_S = 0.6;
let resetRunning = false;        // a reset is waiting out its window or moving; other syringe/routine controls wait
let resetParts = new Set();      // what the current reset moves: 'syringes', 'conveyor'
let resetQueued = new Set();     // pressed while a reset was already moving
let resetWindowOpen = false;

function resetBusy(part) {
    return (resetRunning && resetParts.has(part)) || resetQueued.has(part);
}

// Each button has nothing to do while its part is already home (and, for the conveyor, no tile has material on
// it), so it's disabled then. It stays usable while it's running. Called wherever any of those change.
function updateResetButton() {
    const syringeButton = document.getElementById('reset-syringes-button');
    const conveyorButton = document.getElementById('reset-conveyor-button');
    if (!syringeButton || !conveyorButton) return;
    const syringesHome = Math.abs(syringePosMm - syringeStartMm()) < 1e-3;
    const conveyorHome = Math.abs(conveyorMm) < 1e-3 && document.querySelector('#tile-strip .tile.dispensed') === null;
    syringeButton.disabled = homeLost || (!resetBusy('syringes') && syringesHome);
    conveyorButton.disabled = homeLost || (!resetBusy('conveyor') && conveyorHome);
    document.getElementById('reset-syringes-label').textContent = resetBusy('syringes') ? 'Resetting...' : 'Reset\nSyringes';
    document.getElementById('reset-conveyor-label').textContent = resetBusy('conveyor') ? 'Resetting...' : 'Reset\nConveyor';
    updatePlayButton(); // Go! also depends on where the syringes and tray are
}

function pressReset(part) {
    if (refusedWhileHomeLost(part === 'syringes' ? 'Reset Syringes' : 'Reset Conveyor')) return;
    if (resetBusy(part) || syringePresetMoving || document.getElementById('play-button').classList.contains('active')) return;
    if (resetRunning) {
        if (resetWindowOpen) resetParts.add(part); // joins: both move together
        else resetQueued.add(part);                // the other one is already moving: runs straight after
        updateResetButton();
        return;
    }
    resetRunning = true;
    resetParts = new Set([part]);
    resetWindowOpen = true;
    updateResetButton();
    const pressStopCount = stopCount;
    setTimeout(() => {
        resetWindowOpen = false;
        if (stopCount !== pressStopCount) { finishResets(); return; } // Stop pressed while waiting: send nothing
        runReset();
    }, RESET_PAIR_WINDOW_S * 1000);
}

function finishResets() {
    resetRunning = false;
    resetParts = new Set();
    resetQueued = new Set();
    updateResetButton();
}

// Sends one reset in absolute mode on the board's coordinates and draws it at the board's pace. With both parts,
// one line moves X and Y together: its feed makes the slower part go at its own speed and the other finish with it.
async function runReset() {
    const syringes = resetParts.has('syringes'), conveyor = resetParts.has('conveyor');
    const fromMm = syringePosMm, toMm = syringeStartMm();
    const dy = syringes ? Math.abs(toMm - fromMm) : 0;
    const dx = conveyor ? Math.abs(conveyorMm) : 0;
    const vy = Math.min(SYRINGE_RETRACT_FEEDRATE, SYRINGE_MAX_FEED);
    const vx = Math.min(feedRate, CONVEYOR_MAX_FEED);
    const words = [];
    if (dx) words.push(`${CONVEYOR_AXIS}0`);
    if (dy) words.push(syringeAxesWords(toMm));
    let feed;
    let drawnSeconds; // how long the drawings take to get there, from now
    if (dx && dy) {
        const minutes = Math.max(dx / vx, dy / vy);
        const length = Math.hypot(dx, dy);
        feed = length / minutes;
        // GRBL keeps each axis within its acceleration, which limits the move's acceleration along the line
        const accel = Math.min(CONVEYOR_ACCEL * length / dx, SYRINGE_ACCEL * length / dy);
        trackSyringeMove(fromMm, toMm, feed * dy / length, REQUEST_OVERHEAD_S, accel * dy / length);
        rewindTiles(REQUEST_OVERHEAD_S, { feed: feed * dx / length, accel: accel * dx / length });
        drawnSeconds = REQUEST_OVERHEAD_S + moveSeconds(length, feed, accel);
        feed = Number(feed.toFixed(1));
    } else {
        feed = dy ? SYRINGE_RETRACT_FEEDRATE : feedRate;
        if (dy) trackSyringeMove(fromMm, toMm, vy, REQUEST_OVERHEAD_S);
        if (conveyor) rewindTiles(REQUEST_OVERHEAD_S); // also clears the tile marks with the conveyor already home
        drawnSeconds = REQUEST_OVERHEAD_S + Math.max(dy ? moveSeconds(dy, vy, SYRINGE_ACCEL) : 0,
            dx ? moveSeconds(dx, vx, CONVEYOR_ACCEL) : 0);
    }
    const drawnEnd = performance.now() + drawnSeconds * 1000;
    const runStopCount = stopCount;
    let stopped = false;
    try {
        if (words.length) {
            await sendGCodeOrThrow(['G90', `G1 ${words.join(' ')} F${feed}`, 'G91', syncGCode()].join('\n'));
        }
    } catch (error) {
        stopped = stopCount !== runStopCount;
        if (stopped) {
            // Stop pressed partway: the machine is somewhere in between, so leave the drawings where they got to
            stopSyringeTrack();
            if (syringes) syringePosMm = parseFloat(document.getElementById('syringe-slider').value);
            console.error('Reset stopped:', error);
        } else {
            // Still move the drawings back, at the same pace as if the board had answered (they're already on their
            // way), so the page can be put back to home without a board. The tiles clear once the row has stopped.
            console.warn('Reset: no response from the board, so it may not have moved. Moving the drawings back anyway.', error);
            await new Promise(resolve => setTimeout(resolve, Math.max(0, drawnEnd - performance.now()) + 50));
            stopped = stopCount !== runStopCount; // Stop pressed while they were moving: leave them there
            if (stopped) {
                stopSyringeTrack();
                if (syringes) syringePosMm = parseFloat(document.getElementById('syringe-slider').value);
            }
        }
    } finally {
        if (syringes) {
            if (!stopped) {
                stopSyringeTrack();
                syringePosMm = toMm;
                showSyringePosition(toMm);
            }
            setPrimedMm(0); // moved back (or partway), so prime again
        }
        if (stopped) {
            finishResets();
        } else if (resetQueued.size) {
            resetParts = resetQueued;
            resetQueued = new Set();
            runReset();
        } else {
            finishResets();
        }
    }
}


// --- Tile strip (LaLi) ---
// Side view of the SEQUENCE_REPEATS tiles under the drawn syringe's needle. Home = tile 1 (the rightmost) centred under
// the needle; each conveyor advance slides the row right so the next tile is centred, and on into the
// UV tunnel. Like syringePosMm, it's the page's estimate from the moves it sends: it doesn't see custom
// G-code, and Stop freezes it wherever the drawing was. Go! puts it back at home when it starts.
const UV_TUNNEL_MM = SEQUENCE_REPEATS * SEQUENCE_X_STEP_MM; // exactly all 12 tiles
// The tunnel starts one tile past the tile under the needle, so a tile goes in on the second advance after it's dispensed
const UV_TUNNEL_START_MM = 1.5 * SEQUENCE_X_STEP_MM;
const CONVEYOR_MAX_FEED = 500; // $110: GRBL caps faster X moves to this
const CONVEYOR_ACCEL = 10; // $120, mm/s²
const SYRINGE_MAX_FEED = 500; // $111: GRBL caps faster Y (syringe) moves to this
const SYRINGE_ACCEL = 10; // $121, mm/s²
const REQUEST_OVERHEAD_S = 0.15; // /send_gcode's $X and pause before each request's G-code runs
const TILE_STRIP_NEEDLE_Y = 28.6; // where the drawn syringe's needle tip lands in the strip: just above the tiles

let conveyorMm = 0; // where the row ends up once every conveyor move sent so far is done (mm right of home)
let tileTimers = [];
// Each tile's UV time in the tunnel (ms), for tiles with material on them: shows once the drawing has the tile's centre inside the tunnel,
// counts only while the UV light is on, and holds once the tile is through. rewinding pauses it while Reset carries the row back.
let tunnelMs = [];
let rewinding = false;
let lastTunnelTick = performance.now();

// How long a move takes with trapezoidal acceleration
function moveSeconds(mm, feed, accel) {
    const v = feed / 60, d = Math.abs(mm);
    return d >= v * v / accel ? d / v + v / accel : 2 * Math.sqrt(d / accel);
}

// --- Conveyor motion, as GRBL's planner runs it ---
// Queued moves in the same direction run as one continuous motion: GRBL carries full speed from one into
// the next instead of slowing down at each, and only slows down for the last one queued. A move that
// arrives while the conveyor is already slowing down makes it speed back up. So whenever a move joins, the
// motion is re-planned from the conveyor's current position and speed to the new end point. A move the
// other way waits until the conveyor has stopped. The row is drawn from this every animation frame.
let conveyorRestMm = 0;     // where the row sits while nothing is moving
let conveyorMotion = null;  // the current trapezoid: { t0, p0, dir, distance, v0, vPeak, a, ta, tc, td }
let conveyorQueue = [];     // moves (mm) waiting for the conveyor to stop and reverse
let pendingConveyorMoves = 0; // sent, but not yet reached the board
let conveyorStoppedAt = 0;  // performance.now() when the conveyor last came to a stop
let afterConveyorStops = null;
let conveyorFrame = null;

// From speed v0 (mm/s) to a stop, distance mm away: speed up to feed (mm/min, or as fast as there's room
// for) at accel (mm/s²), cruise, slow down
function planMotion(t0, p0, v0, dir, distance, feed, a) {
    const vMax = feed / 60;
    v0 = Math.min(v0, vMax);
    const vPeak = Math.min(Math.max(Math.sqrt(a * distance + v0 * v0 / 2), v0), vMax);
    if (vPeak <= 0) return null;
    const cruise = Math.max(0, distance - (vPeak * vPeak - v0 * v0) / (2 * a) - vPeak * vPeak / (2 * a));
    return { t0, p0, dir, distance, v0, vPeak, a, ta: (vPeak - v0) / a, tc: cruise / vPeak, td: vPeak / a };
}

// profile = { feed, accel } overrides the Movement Speed and $120, for a combined X+Y move (see the resets)
function planConveyorMotion(t0, p0, v0, dir, distance, profile = null) {
    return planMotion(t0, p0, v0, dir, distance, profile?.feed ?? Math.min(feedRate, CONVEYOR_MAX_FEED),
        profile?.accel ?? CONVEYOR_ACCEL);
}

// The drawn syringe following one GRBL move, from mm to mm starting delaySeconds from now: drawn every
// frame from the same motion model (no CSS easing), so it keeps pace with the real plunger
let syringeTrackFrame = null;
function trackSyringeMove(fromMm, toMm, feed, delaySeconds, accel = SYRINGE_ACCEL) {
    stopSyringeTrack();
    const visual = document.getElementById('syringe-visual');
    const motion = planMotion(performance.now() + delaySeconds * 1000, fromMm, 0, Math.sign(toMm - fromMm),
        Math.abs(toMm - fromMm), feed, accel);
    if (!motion || !visual) return;
    visual.classList.add('tracking');
    const step = () => {
        const t = performance.now();
        showSyringePosition(motionAt(motion, t).pos);
        if (t < motionEnd(motion)) syringeTrackFrame = requestAnimationFrame(step);
        else stopSyringeTrack();
    };
    syringeTrackFrame = requestAnimationFrame(step);
}

// Leaves the drawing wherever it got to
function stopSyringeTrack() {
    if (syringeTrackFrame !== null) cancelAnimationFrame(syringeTrackFrame);
    syringeTrackFrame = null;
    document.getElementById('syringe-visual')?.classList.remove('tracking');
}

function motionEnd(m) {
    return m.t0 + (m.ta + m.tc + m.td) * 1000;
}

// Position and speed t ms into the motion
function motionAt(m, t) {
    let s = Math.max(0, (t - m.t0) / 1000);
    let d, v;
    if (s < m.ta) {
        v = m.v0 + m.a * s;
        d = m.v0 * s + m.a * s * s / 2;
    } else {
        d = m.v0 * m.ta + m.a * m.ta * m.ta / 2;
        s -= m.ta;
        if (s < m.tc) {
            v = m.vPeak;
            d += m.vPeak * s;
        } else {
            s = Math.min(s - m.tc, m.td);
            v = m.vPeak - m.a * s;
            d += m.vPeak * m.tc + m.vPeak * s - m.a * s * s / 2;
        }
    }
    return { pos: m.p0 + m.dir * Math.min(d, m.distance), speed: Math.max(v, 0) };
}

function startConveyorMotion(t, mm, profile = null) {
    conveyorMotion = planConveyorMotion(t, conveyorRestMm, 0, Math.sign(mm), Math.abs(mm), profile);
}

// Finish any motion that's over by time t, and start the next queued one at the moment it ended
function settleConveyor(t) {
    while (conveyorMotion && t >= motionEnd(conveyorMotion)) {
        const end = motionEnd(conveyorMotion);
        conveyorRestMm = conveyorMotion.p0 + conveyorMotion.dir * conveyorMotion.distance;
        conveyorMotion = null;
        conveyorStoppedAt = end;
        if (conveyorQueue.length) {
            startConveyorMotion(end, conveyorQueue.shift());
        } else if (afterConveyorStops) {
            setTimeout(afterConveyorStops);
            afterConveyorStops = null;
        }
    }
}

// A move reaching the board at time t. A profile only applies if the conveyor is stopped then.
function addConveyorMove(mm, t, profile = null) {
    settleConveyor(t);
    const dir = Math.sign(mm);
    if (!dir) return;
    const last = conveyorQueue[conveyorQueue.length - 1];
    if (!conveyorMotion) {
        startConveyorMotion(t, mm, profile);
    } else if (last !== undefined) {
        if (Math.sign(last) === dir) conveyorQueue[conveyorQueue.length - 1] += mm;
        else conveyorQueue.push(mm);
    } else if (dir === conveyorMotion.dir) {
        // Joins the current motion: re-plan from here, at the current speed, to the new end point
        const now = motionAt(conveyorMotion, t);
        const end = conveyorMotion.p0 + dir * conveyorMotion.distance + mm;
        conveyorMotion = planConveyorMotion(t, now.pos, now.speed, dir, Math.abs(end - now.pos));
    } else {
        conveyorQueue.push(mm);
    }
    animateConveyor();
}

// Draw the row every frame while it's moving
function animateConveyor() {
    if (conveyorFrame) return;
    const step = () => {
        const row = document.getElementById('tile-row');
        if (row) row.style.transform = `translateX(${drawnConveyorMm()}px)`;
        conveyorFrame = conveyorMotion ? requestAnimationFrame(step) : null;
    };
    conveyorFrame = requestAnimationFrame(step);
}

// Put the row at mm straight away, with nothing moving or queued
function placeConveyor(mm) {
    conveyorMotion = null;
    conveyorQueue = [];
    conveyorRestMm = conveyorMm = mm;
    const row = document.getElementById('tile-row');
    if (row) row.style.transform = `translateX(${mm}px)`;
    updateResetButton();
}

function conveyorMoving() {
    const now = performance.now();
    settleConveyor(now);
    return pendingConveyorMoves > 0 || conveyorMotion !== null || now < conveyorStoppedAt + PLUNGE_CONVEYOR_MARGIN_MS;
}

// Dragging the row goes no further than Set Home (0) and where a full Go! run leaves the tray
const CONVEYOR_DRAG_MAX_MM = (SEQUENCE_REPEATS + UV_ADVANCE_STEPS) * SEQUENCE_X_STEP_MM;

// On LaLi, ◀ ▶ (and ←/→) are blocked while a drag or Reset Conveyor is moving the conveyor, and during Go!.
// Otherwise presses queue up behind a moving conveyor, as GRBL runs them.
let conveyorDragMoveEnd = 0; // until when the conveyor is moving to where the tiles were dragged
function conveyorArrowsBlocked() {
    return performance.now() < conveyorDragMoveEnd || resetBusy('conveyor') || rewinding
        || !!document.getElementById('play-button')?.classList.contains('active');
}

// Greys out ◀ ▶ while they're blocked, with "Conveyor moving..." above them whenever it moves (presses
// included). Polled, since the conveyor stops on its own (by the page's motion model)
function updateConveyorArrows() {
    const lali = !!currentMachine?.startsWith('lali');
    const moving = lali && conveyorMoving();
    document.querySelectorAll('#stage-controller .arrow.left, #stage-controller .arrow.right')
        .forEach(button => { button.disabled = lali && conveyorArrowsBlocked(); });
    const status = document.getElementById('conveyor-moving');
    if (status) status.hidden = !moving;
}

// Drag-to-position on the tile row (LaLi GRBL): the row follows the pointer 1:1, and releasing moves the
// conveyor there in absolute mode (X0 = Set Home), at the Movement Speed. The row stays where it was dropped
// (no animating it from where the conveyor was), and counts as moving until the conveyor would get there.
function moveConveyorTo(mm) {
    const delta = Number((mm - conveyorMm).toFixed(4));
    if (!delta) return;
    sendGCode(['G90', `G1 ${CONVEYOR_AXIS}${Number((mm * CONVEYOR_DIRECTION).toFixed(4))} F${feedRate}`, 'G91'].join('\n'));
    const seconds = REQUEST_OVERHEAD_S + moveSeconds(delta, Math.min(feedRate, CONVEYOR_MAX_FEED), CONVEYOR_ACCEL);
    placeConveyor(mm);
    conveyorStoppedAt = conveyorDragMoveEnd = performance.now() + seconds * 1000; // conveyorMoving() until then
}

function setupTileDrag() {
    const strip = document.getElementById('tile-strip');
    if (!strip) return;
    let drag = null;
    const row = () => document.getElementById('tile-row');
    strip.addEventListener('pointerdown', (event) => {
        const tiles = event.target.closest?.('#tile-row');
        if (!tiles || currentMachine !== 'lali-grbl') return;
        if (refusedBeforeHome('Dragging the tiles')) return;
        if (conveyorMoving() || conveyorArrowsBlocked() || resetRunning || syringePresetMoving) {
            console.warn('Tile drag ignored: the conveyor is moving, or a routine is running');
            return;
        }
        // SVG units are mm, so this is the strip's scale on screen right now (any window size or zoom)
        const svg = strip.querySelector('svg');
        const pxPerMm = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
        drag = { startX: event.clientX, startMm: conveyorMm, mm: conveyorMm, pxPerMm };
        try { tiles.setPointerCapture(event.pointerId); } catch { /* keeps working without capture */ }
        strip.classList.add('dragging');
        event.preventDefault();
    });
    strip.addEventListener('pointermove', (event) => {
        if (!drag) return;
        const mm = drag.startMm + (event.clientX - drag.startX) / drag.pxPerMm;
        drag.mm = Number(Math.min(Math.max(mm, 0), CONVEYOR_DRAG_MAX_MM).toFixed(2));
        // Past either limit, the row waits at it, and letting go moves the conveyor to that limit
        row().style.transform = `translateX(${drag.mm}px)`;
    });
    const end = (commit) => {
        if (!drag) return;
        const { mm } = drag;
        drag = null;
        strip.classList.remove('dragging');
        if (commit && mm !== conveyorMm) moveConveyorTo(mm);
        else row().style.transform = `translateX(${drawnConveyorMm()}px)`; // cancelled or not moved: back where it was
        updateConveyorArrows();
    };
    strip.addEventListener('pointerup', () => end(true));
    strip.addEventListener('pointercancel', () => end(false));
}

function buildTileStrip() {
    const strip = document.getElementById('tile-strip');
    if (!strip) return;
    const w = SEQUENCE_X_STEP_MM;
    const tiles = Array.from({ length: SEQUENCE_REPEATS }, (_, i) => {
        const x = -i * w - w / 2;
        // Tile profile: flat top, straight sides for the top half, then chamfered in to a narrower flat bottom
        const body = [[x, 31], [x + w, 31], [x + w, 34.2], [x + w * 0.7, 37], [x + w * 0.3, 37], [x, 34.2]];
        return `<g class="tile" data-tile="${i}">
            <rect class="tile-resin" x="${x + w / 2}" y="${TILE_TOP_Y - RESIN_BASE_HEIGHT}" width="0" height="${RESIN_BASE_HEIGHT}" rx="0.5"/>
            <polygon class="tile-body" points="${body.map(p => p.join(',')).join(' ')}"/>
            <text x="${x + w / 2}" y="35.5">${i + 1}</text>
            <text class="tile-timer" x="${x + w / 2}" y="28"></text>
        </g>`;
    }).join('');
    const tunnelX = UV_TUNNEL_START_MM;
    // Wide enough for the waiting tiles on the left, the whole tunnel, and a few tiles out of it on the right.
    // Starts just above the tunnel's roof (y 21): room for its glow, without reaching up over the syringe controls
    strip.innerHTML = `<svg viewBox="-170 19 430 23" role="img" aria-label="Tiles under the needle">
        <g id="tile-row">${tiles}</g>
        <g class="uv-tunnel">
            <rect class="uv-glow" x="${tunnelX}" y="21" width="${UV_TUNNEL_MM}" height="16"/>
            <path class="uv-hood" d="M${tunnelX} 37 V21 H${tunnelX + UV_TUNNEL_MM} V37"/>
        </g>
    </svg>`;
    // The tunnel glows while the UV light is on, however it was switched
    const lightButton = document.getElementById('light-button');
    const showUv = () => strip.classList.toggle('uv-on', lightButton.classList.contains('active'));
    new MutationObserver(showUv).observe(lightButton, { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('resize', alignTileStrip);
    // Also whenever the controls above change size (a CSS change, fonts loading, labels changing), so the
    // needle stays over tile 1 without needing a window resize
    const controls = new ResizeObserver(alignTileStrip);
    document.querySelectorAll('.controllers, .syringe-group').forEach(el => controls.observe(el));
    setInterval(tickTunnelTimers, 250);
    placeConveyor(conveyorMm);
}

// Where the row is right now, partway through a move included
function drawnConveyorMm(t = performance.now()) {
    settleConveyor(t);
    return conveyorMotion ? motionAt(conveyorMotion, t).pos : conveyorRestMm;
}

function tickTunnelTimers() {
    const now = performance.now();
    const elapsed = now - lastTunnelTick;
    lastTunnelTick = now;
    if (rewinding) return;
    const w = SEQUENCE_X_STEP_MM;
    const offset = drawnConveyorMm();
    const uvOn = document.getElementById('light-button').classList.contains('active');
    document.querySelectorAll('#tile-strip .tile').forEach((tile, i) => {
        if (!tile.classList.contains('dispensed')) return; // no material, so no timer
        const centre = offset - i * w;
        if (centre > UV_TUNNEL_START_MM && centre < UV_TUNNEL_START_MM + UV_TUNNEL_MM) tunnelMs[i] = (tunnelMs[i] ?? 0) + (uvOn ? elapsed : 0);
        if (!tunnelMs[i]) return; // no UV on it yet (not in the tunnel, or the light's been off), so no timer
        const seconds = Math.floor(tunnelMs[i] / 1000);
        tile.querySelector('.tile-timer').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
        tile.classList.add('timed');
    });
}

// Line the strip up under the drawn syringe: its x = 0 under the needle, the needle tip just above the tiles.
// Done with a transform only, so the strip's space in the layout (its margin-top in styles.css) never changes:
// otherwise a shorter needle would shorten the page and, the page being centred, drop the syringe with it.
// The margin sets the height (it's between the controllers and the strip, so it's exact even though the
// page is centred); the transform sets the sideways shift. Only works while both are shown.
function alignTileStrip() {
    const strip = document.getElementById('tile-strip');
    const svg = strip?.querySelector('svg');
    const needle = document.querySelector('.syringe-needle');
    if (!svg || !needle || !strip.offsetParent || !needle.offsetParent) return;
    strip.style.transform = '';
    const tip = needle.getBoundingClientRect();
    const target = new DOMPoint(0, TILE_STRIP_NEEDLE_Y).matrixTransform(svg.getScreenCTM());
    strip.style.transform = `translate(${tip.left + tip.width / 2 - target.x}px, ${tip.bottom - target.y}px)`;
    // ◀ ▶ (taken out of the flow by styles.css on LaLi GRBL) centred over the 12 tiles at home
    const stage = document.getElementById('stage-controller');
    if (getComputedStyle(stage).position === 'absolute') {
        const rowCentre = -(SEQUENCE_REPEATS - 1) / 2 * SEQUENCE_X_STEP_MM;
        const x = new DOMPoint(rowCentre, 0).matrixTransform(svg.getScreenCTM()).x;
        stage.style.left = `${x - stage.offsetParent.getBoundingClientRect().left - stage.offsetWidth / 2}px`;
    }
}

function tileLater(seconds, fn) {
    tileTimers.push(setTimeout(fn, seconds * 1000));
}

// Move the row by mm (positive = right, the way Go! advances), once the board would get the move
function noteConveyorMove(mm, delaySeconds = REQUEST_OVERHEAD_S, profile = null) {
    conveyorMm = Number((conveyorMm + mm).toFixed(4));
    updateResetButton();
    pendingConveyorMoves++;
    tileLater(delaySeconds, () => {
        pendingConveyorMoves--;
        addConveyorMove(mm, performance.now(), profile);
    });
}

// Manual plunges (▼ / ↓, dragging the syringe down, Prime, Dispense, voice) are refused while the conveyor
// is moving, by the page's estimate from the conveyor moves it sent (plus a small margin), so material only
// goes onto a tile that's sitting still under the needle. Go! is already sequenced, so it isn't affected.
const PLUNGE_CONVEYOR_MARGIN_MS = 200;
function plungeBlockedByConveyor() {
    if (conveyorMoving()) {
        console.warn('Syringe plunge ignored: the conveyor is still moving');
        return true;
    }
    return false;
}

// Every extrusion onto a tile (Go! presses, ▼ / ↓, dragging the syringe down, Dispense, voice) marks the tile under
// the needle as having material on it: it turns purple, and only marked tiles get a tunnel timer
// (nothing to crosslink otherwise). "Under" = the needle is within the tile, where the drawing has it now.
// mm is how far the syringes plunged, which sets how much resin is drawn on the tile.
function markTileUnderNeedle(mm) {
    if (!document.getElementById('tile-row')) return;
    const w = SEQUENCE_X_STEP_MM;
    const offset = drawnConveyorMm();
    const i = Math.round(offset / w);
    const tile = document.querySelector(`#tile-strip [data-tile="${i}"]`);
    if (!tile) return;
    tile.classList.add('dispensed');
    // Where the needle is across the tile, from its left edge (0 to the tile width)
    if (mm > 0) addResin(tile, i, i * w + w / 2 - offset, mm / SYRINGE_TRAVEL_MM * (SYRINGE_HOME_ML - SYRINGE_END_ML) * 1000);
    updateResetButton();
}

// Resin drawn on a tile (SVG units are mm): RESIN_MM2_PER_UL of area per µL, so 40 µL is 8 wide at the base
// height. It spreads wider as more lands on the tile, then once it covers the whole top it gets taller, up to
// RESIN_MAX_HEIGHT (then stays that size). It sits where the needle was (weighted by volume, over several
// dispenses), but never past the tile's edges.
const RESIN_MM2_PER_UL = 8 / 40;
const RESIN_BASE_HEIGHT = 1;
const RESIN_MAX_HEIGHT = 3;
const TILE_TOP_Y = 31;
let tileResin = []; // per tile: { ul, at } (at = mm from the tile's left edge)

function addResin(tile, i, at, ul) {
    const r = tileResin[i] ??= { ul: 0, at };
    r.at = (r.at * r.ul + at * ul) / (r.ul + ul);
    r.ul += ul;
    const w = SEQUENCE_X_STEP_MM;
    const area = r.ul * RESIN_MM2_PER_UL;
    const width = Math.min(area / RESIN_BASE_HEIGHT, w);
    const height = Math.min(Math.max(area / w, RESIN_BASE_HEIGHT), RESIN_MAX_HEIGHT);
    const centre = Math.min(Math.max(r.at, width / 2), w - width / 2);
    const rect = tile.querySelector('.tile-resin');
    rect.setAttribute('x', -i * w - w / 2 + centre - width / 2);
    rect.setAttribute('width', width);
    rect.setAttribute('y', TILE_TOP_Y - height);
    rect.setAttribute('height', height);
}

// Drip from the drawn syringe during the press, then mark the tile under the needle
function noteDispense(delaySeconds, pressSeconds, mm) {
    const syringe = document.getElementById('syringe-visual');
    tileLater(delaySeconds, () => syringe.classList.add('dripping'));
    tileLater(delaySeconds + pressSeconds, () => {
        syringe.classList.remove('dripping');
        markTileUnderNeedle(mm);
    });
}

function cancelTileAnimations() {
    tileTimers.forEach(clearTimeout);
    tileTimers = [];
    pendingConveyorMoves = 0;
    afterConveyorStops = null;
    rewinding = false;
    document.getElementById('syringe-visual')?.classList.remove('dripping');
}

// Back to home: tile 1 under the needle, nothing dispensed, no tunnel times
function resetTiles() {
    cancelTileAnimations();
    tunnelMs = [];
    tileResin = [];
    document.querySelectorAll('#tile-strip .tile').forEach(tile => {
        tile.classList.remove('dispensed', 'timed');
        tile.querySelector('.tile-resin').setAttribute('width', 0);
    });
    placeConveyor(0);
}

// Reset Conveyor: after delaySeconds the conveyor drives back to home (after anything still queued), carrying
// the row back with it (no tunnel timing on the way); the row is cleared once it's stopped there
function rewindTiles(delaySeconds, profile = null) {
    cancelTileAnimations();
    rewinding = true;
    if (!conveyorMm) {
        tileLater(delaySeconds, resetTiles);
        return;
    }
    noteConveyorMove(-conveyorMm, delaySeconds, profile);
    afterConveyorStops = resetTiles;
}

// Stop: hold the row where it has got to
function freezeTiles() {
    const mm = drawnConveyorMm();
    cancelTileAnimations();
    conveyorStoppedAt = 0; // the board has stopped
    placeConveyor(mm);
}

// When locked, any B or C arrow moves both axes together in one command
let bcLocked = false;

function moveBC(axis, distance) {
    if (bcLocked) {
        sendGCode(`G1 B${distance} C${distance} F${plungerFeedRate}`);
    } else {
        sendGCode(`G1 ${axis}${distance} F${plungerFeedRate}`);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const speedSlider = document.getElementById('speed-slider');
    const rangeSlider = document.getElementById('range-slider');
    const rangeValueInput = document.getElementById('range-value');
    const speedValueInput = document.getElementById('speed-value');
    const micButton = document.getElementById('mic-button');
    const fanButton = document.getElementById('fan-button');
    const lightButton = document.getElementById('light-button');
    buildTileStrip();
    setupTileDrag();
    setInterval(() => { updateConveyorArrows(); updateSyringeArrows(); }, 100);

    // True if the element (or its label wrapper) isn't hidden for this machine
    function isShown(el) {
        return el.getClientRects().length > 0;
    }
    const pumpButton = document.getElementById('pump-button');
    const danceButton = document.getElementById('dance-button');
    const homeButton = document.getElementById('home-button');
    // Some browsers have no speech API (e.g. Firefox, and Chrome/Firefox on iPhone). Creating it there
    // would throw and stop the rest of setup, so use an inert stand-in and disable the Listen button.
    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = SpeechRecognitionAPI ? new SpeechRecognitionAPI() : { start() {}, stop() {} };
    recognition.continuous = true;
    recognition.lang = 'en-US';
    if (!SpeechRecognitionAPI) {
        micButton.disabled = true;
        micButton.title = "Voice control isn't supported in this browser";
        console.warn('Speech recognition not supported in this browser; voice control disabled');
    }
    let isManuallyStopped = false;

    // --- Machine selection & connection ---
    // The segmented control picks the machine. With nothing chosen yet, the server pre-selects
    // one from the detected board; a manual choice is remembered in this browser and wins next time.
    const machineSelect = document.getElementById('machine-select');
    const machineButtons = machineSelect.querySelectorAll('[data-machine]');

    function savedMachine() {
        try { return localStorage.getItem('machine'); } catch { return null; }
    }

    function saveMachine(machine) {
        try { localStorage.setItem('machine', machine); } catch { /* not remembered, still works */ }
    }

    function highlightMachine(machine) {
        machineButtons.forEach(button => {
            const selected = button.dataset.machine === machine;
            button.classList.toggle('active', selected);
            button.setAttribute('aria-checked', selected);
            // Tab title follows the machine, from its button's name without the emoji ("LaLi Controller")
            if (selected) document.title = button.textContent.replace(/[^\p{L}\p{N}\s()-]/gu, '').replace(/\s+/g, ' ').trim();
        });
    }

    const pageDefaultDistance = parseFloat(rangeValueInput.value);
    let shownMachine = null;

    // Elements tagged data-machines="a b" only show for those machines. Buttons that also have
    // data-unsupported="disable" stay in place but disabled instead, so the layout doesn't change
    // connected: false in preview mode, where there's no board to send to
    function showMachine(machine, connected) {
        if (machine !== shownMachine) {
            distance = DEFAULT_MOVEMENT_DISTANCE_MM[machine] ?? pageDefaultDistance;
            rangeValueInput.value = distance;
            rangeSlider.value = distance; // the slider rounds to its 1 mm steps; the box keeps the exact value
            if (machine === 'lali-grbl') {
                // Assume the syringes are at Set Home (Y0, SYRINGE_HOME_ML) and set the board's coordinate to
                // match (G92 doesn't move anything), so dragging the syringe and the presets move to exact
                // positions. The conveyor's home is wherever it is now. Press Set Home to confirm both.
                syringePosMm = 0;
                setHomeSet(false);
                showSyringePosition(syringePosMm);
                if (connected) sendGCode(`G92 ${CONVEYOR_AXIS}0 ${syringeAxesWords(syringePosMm)}`);
                showSyringePreset(null); // updates the Reset button
                setPlungerUnit('ul', DEFAULT_PLUNGER_UL);
            } else {
                setPlungerUnit('mm'); // LaLi (Marlin) has no mL calibration
            }
            shownMachine = machine;
        }
        document.getElementById('connection-status').style.display = 'none';
        document.getElementById('main-container').style.display = 'contents';
        document.querySelectorAll('[data-machines]').forEach(el => {
            const supported = el.dataset.machines.split(' ').includes(machine);
            if (el.dataset.unsupported === 'disable') el.disabled = !supported;
            else el.style.display = supported ? '' : 'none';
        });
        document.body.dataset.machine = machine; // for machine-specific layout in styles.css
        highlightMachine(machine);
        updatePlayButton(); // Go! needs priming on some machines
        alignTileStrip(); // now that the syringe and strip are shown
    }

    function showDisconnected(machine) {
        document.getElementById('connection-status').style.display = 'block';
        document.getElementById('main-container').style.display = 'none';
        highlightMachine(machine);
    }

    async function connect(machine) {
        machineSelect.classList.add('busy');
        try {
            const url = machine ? `/initialize?machine=${encodeURIComponent(machine)}` : '/initialize';
            const data = await (await fetch(url)).json();
            if (data.status === 200) {
                currentMachine = data.machine;
                currentFirmware = data.firmware;
                showMachine(currentMachine, true);
                console.log('Connected:', data.message, 'on', data.port, `(${data.machine}, ${data.firmware})`);
                return true;
            }
            if (PREVIEW_WITHOUT_BOARD && data.machines) {
                currentMachine = machine || PREVIEW_DEFAULT_MACHINE;
                currentFirmware = data.machines[currentMachine].firmware;
                showMachine(currentMachine, false);
                console.warn(`PREVIEW_WITHOUT_BOARD is on: showing ${currentMachine} (${currentFirmware}) with no board.`, data.message);
                return true;
            }
            currentMachine = null;
            currentFirmware = null;
            showDisconnected(machine);
            console.error('Connection failed:', data.message);
        } catch (error) {
            showDisconnected(machine);
            console.error('Fetch error:', error);
        } finally {
            machineSelect.classList.remove('busy');
        }
        return false;
    }

    machineButtons.forEach(button => {
        button.addEventListener('click', async () => {
            const machine = button.dataset.machine;
            if (machine === currentMachine || machineSelect.classList.contains('busy')) return;
            if (playButton.classList.contains('active') || dispensing) {
                console.warn('Wait for the current routine to finish before switching machines');
                return;
            }
            saveMachine(machine);
            if (await connect(machine)) {
                // Switching shuts the board down and sets it up again, so outputs start from scratch
                lightButton.classList.remove('active');
                pumpButton.classList.remove('active');
                fanButton.classList.toggle('active', machine === 'microscope'); // its setup turns the fan on
            }
        });
    });

    connect(savedMachine());

    // USB connection timer: the server checks the board every second and keeps the times, so
    // this stays right even if the browser slows the polling down in a background tab.
    // #usb-status is commented out in the HTML for now, so only the console message for a lost connection shows.
    const usbStatus = document.getElementById('usb-status') ?? document.createElement('div');
    // The top-left crossed-out plug: shown whenever the board isn't connected, with the reason on hover
    const noBoardIcon = document.getElementById('no-board-icon');
    function showNoBoard(reason) {
        noBoardIcon.hidden = !reason;
        if (reason) noBoardIcon.title = noBoardIcon.ariaLabel = reason;
    }
    // While no board is connected, ask the server to set one up every RECONNECT_INTERVAL_MS, for the machine
    // being shown (or the saved / detected one). So plugging the board in, or back in, needs no restart.
    const RECONNECT_INTERVAL_MS = 2000;
    let lastReconnectAttempt = 0;
    let reconnecting = false;
    async function tryReconnect() {
        if (reconnecting || machineSelect.classList.contains('busy')) return;
        if (performance.now() - lastReconnectAttempt < RECONNECT_INTERVAL_MS) return;
        lastReconnectAttempt = performance.now();
        reconnecting = true;
        try {
            const machine = currentMachine || savedMachine();
            const query = machine ? `machine=${encodeURIComponent(machine)}&auto=1` : 'auto=1';
            const data = await (await fetch(`/initialize?${query}`)).json();
            if (data.status !== 200) return; // still no board
            // The board restarted, so its outputs are off (the microscope's setup turns its fan on)
            lightButton.classList.remove('active');
            pumpButton.classList.remove('active');
            fanButton.classList.toggle('active', data.machine === 'microscope');
            const sameMachine = data.machine === currentMachine;
            currentMachine = data.machine;
            currentFirmware = data.firmware;
            showMachine(currentMachine, true);
            // Already showing this machine (after a drop, or in preview): the drawings are from before, and the
            // board's coordinates restarted from wherever it is, so it needs Set Home again
            if (sameMachine && currentMachine === 'lali-grbl') setHomeLost(true);
            console.log('Board connected:', data.message, 'on', data.port, `(${data.machine}, ${data.firmware})`,
                sameMachine && currentMachine === 'lali-grbl' ? '. Press Set Home before Go!' : '');
        } catch {
            // the app isn't answering; the next poll tries again
        } finally {
            reconnecting = false;
        }
    }

    let reportedDrop = false;
    async function pollConnection() {
        try {
            const data = await (await fetch('/connection')).json();
            showNoBoard(data.state === 'connected' ? null
                : data.state === 'dropped' ? 'Board connection lost: plug it back in and it reconnects by itself'
                : 'No board connected');
            if (data.state !== 'connected') tryReconnect();
            usbStatus.classList.toggle('dropped', data.state === 'dropped');
            if (data.state === 'connected') {
                usbStatus.textContent = `USB connected for ${data.duration}`;
                reportedDrop = false;
            } else if (data.state === 'dropped') {
                usbStatus.textContent = `USB connection lost after ${data.duration}. Plug the board back in to reconnect.`;
                if (!reportedDrop) console.error(`USB connection lost after ${data.duration}`);
                reportedDrop = true;
            } else {
                usbStatus.textContent = '';
            }
        } catch {
            usbStatus.textContent = 'App not responding';
            showNoBoard('No board connected: the app isn’t responding');
        }
    }
    pollConnection();
    setInterval(pollConnection, 1000);

    // Keys that would step a focused slider. Sliders are mouse/touch only, so these never change them.
    const SLIDER_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'];

    // Keyboard button: arrow-key control on/off, remembered in this browser (on if storage is unavailable)
    const keyboardButton = document.getElementById('keyboard-button');
    let keysEnabled = true;
    try { keysEnabled = localStorage.getItem('keysEnabled') !== 'false'; } catch {}
    function showKeysEnabled() {
        keyboardButton.classList.toggle('off', !keysEnabled);
        document.getElementById('keyboard-label').textContent = keysEnabled ? 'Keys On' : 'Keys Off';
    }
    showKeysEnabled();
    keyboardButton.addEventListener('click', () => {
        keysEnabled = !keysEnabled;
        try { localStorage.setItem('keysEnabled', keysEnabled); } catch {}
        showKeysEnabled();
        keyboardButton.blur(); // so Space/Enter don't toggle it again
    });

    // Send is only usable with something typed in the custom G-code box
    const gcodeInput = document.getElementById('gcode-input');
    const sendGcodeButton = document.getElementById('send-gcode-button');
    const updateSendButton = () => { sendGcodeButton.disabled = !gcodeInput.value.trim(); };
    gcodeInput.addEventListener('input', updateSendButton);
    updateSendButton(); // the browser can restore typed text on reload

    // Briefly glow the on-screen arrow a key stands for, so it's obvious what the key did
    const KEY_ARROWS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    function flashArrowForKey(key, plunger) {
        const dir = KEY_ARROWS[key];
        if (!dir) return;
        const group = plunger && (dir === 'up' || dir === 'down') ? '.syringe-controller' : '#stage-controller';
        const button = document.querySelector(`${group} .arrow.${dir}`);
        if (!button || !isShown(button) || button.disabled) return;
        button.classList.remove('key-glow');
        void button.offsetWidth; // restart the animation when a key is pressed again (or held) mid-glow
        button.classList.add('key-glow');
    }
    document.addEventListener('animationend', (event) => {
        if (event.animationName === 'key-glow') event.target.classList.remove('key-glow');
    });

    document.addEventListener('keydown', (event) => {
        // Let arrow keys edit text/number boxes instead of moving the stage
        if (event.target.tagName === 'INPUT' && event.target.type !== 'range') return;
        // A slider keeps focus after it's dragged; stop the key from also nudging it
        if (event.target.type === 'range' && SLIDER_KEYS.includes(event.key)) event.preventDefault();
        if (!keysEnabled) return;
        // On LaLi (GRBL) Y is the syringes, so ↑/↓ work like the syringe ▲/▼ buttons (plunger distance)
        const plunger = currentMachine === 'lali-grbl';
        flashArrowForKey(event.key, plunger);
        switch (event.key) {
            case 'ArrowUp':
                if (plunger) moveSyringes(-plungerDistance);
                else move('Y', distance);
                break;
            case 'ArrowDown':
                if (plunger) moveSyringes(plungerDistance);
                else move('Y', -distance);
                break;
            case 'ArrowLeft':
                move('X', -distance);
                break;
            case 'ArrowRight':
                move('X', distance);
                break;
        }
    });

    micButton.addEventListener('click', () => {
        if (micButton.classList.contains('listening')) {
            isManuallyStopped = true;
            recognition.stop();
        } else {
            recognition.start();
        }
    });

    recognition.onstart = () => {
        micButton.classList.add('listening');
        document.getElementById('mic-label').textContent = 'Listening...';
    };

    recognition.onend = () => {
        // Restart recognition if it was not manually stopped
        if (!isManuallyStopped) {
            recognition.start();
        } else {
            micButton.classList.remove('listening');
            document.getElementById('mic-label').textContent = 'Listen';
            isManuallyStopped = false;
        }
    };

    recognition.onresult = (event) => {
        const transcript = event.results[event.resultIndex][0].transcript.trim().toLowerCase();
        console.log('Recognized speech:', transcript);

        // "dispense 0.2 mL", "extrude point five milliliters", "deposit half a milliliter", "push 250 microliters"
        const dispensePattern = /^(?:dispense|extrude|deposit|pipette|push|plunge|inject|squirt)(?:\s+out)?\s+(.+?)\s*(milliliters?|millilitres?|ml|mls|cc|ccs|microliters?|microlitres?|µl|ul)(?:\s+(?:of\s+)?(?:prepolymer|resin|liquid))?$/i;
        const dispenseMatch = transcript.match(dispensePattern);
        if (dispenseMatch) {
            let ml = parseSpokenAmount(dispenseMatch[1]);
            if (/^(?:micro|µ|u)/.test(dispenseMatch[2])) ml /= 1000;
            if (Number.isNaN(ml)) console.log(`Couldn't read an amount in "${transcript}"`);
            else dispenseMl(Number(ml.toFixed(4)));
            return;
        }

        // Check for specific distance command first
        const pattern = /^(?:go|move|slide|shift)\s(up|down|left|right)\s(\d*\.?\d+|to|too|two|one|won)\s(millimeters?|mm|inch|inches|in|microns?)$/i;
        const match = transcript.match(pattern);

        if (match) {
            const direction = match[1].toLowerCase();
            let distance = match[2];
            distance = distance.replace('one', '1');
            distance = distance.replace('won', '1');
            distance = distance.replace('to', '2');
            distance = distance.replace('too', '2');
            distance = distance.replace('two', '2');
            distance = parseFloat(distance);

            console.log("Parsed distance:", distance);

            // Convert distance to millimeters if necessary
            const unit = match[3] ? match[3].toLowerCase() : 'mm';
            if ("inches".includes(unit)) {
                distance *= INCH_TO_MM;
            }
            if ("microns".includes(unit)) {
                distance /= 1000;
            }

            switch (direction) {
                case 'up':
                    move('Y', distance);
                    break;
                case 'down':
                    move('Y', -distance);
                    break;
                case 'left':
                    move('X', -distance);
                    break;
                case 'right':
                    move('X', distance);
                    break;
            }
            return;
        }

        // Check for draw square command
        const squarePattern = /\b(?:draw|make|create|clean) (a|an) (\d+(?:\.\d+)?)\s*(millimeter|mm|inch|in)\s*(square|box)$/i;
        const squareMatch = transcript.match(squarePattern);

        if (squareMatch) {
            let sideLength = parseFloat(squareMatch[2]);
            const unit = squareMatch[3].toLowerCase();
            if (unit === 'inch' || unit === 'in') {
                sideLength *= INCH_TO_MM;
            }
            const gcode = `
                G1 Y${sideLength} F${feedRate}
                G1 X${sideLength} F${feedRate}
                G1 Y-${sideLength} F${feedRate}
                G1 X-${sideLength} F${feedRate}
            `;
            sendGCode(gcode);
            return;
        }

        // Handle other commands
        switch (transcript) {
            case 'move up':
                move('Y', 10);
                break;
            case 'move down':
                move('Y', -10);
                break;
            case 'move left':
                move('X', -10);
                break;
            case 'move right':
                move('X', 10);
                break;
            case 'basically':
                if (!isShown(pumpButton)) { console.log(`Ignoring "${transcript}": no pump on this machine`); break; }
                pumpButton.classList.add('active');
                sendGCode('M8');
                break;
            case 'say no':
                sendGCode('G1 X15\n G1 X-15\n G1 X15\n G1 X-15');
                break;
            case 'say yes':
                sendGCode('G1 Y15\n G1 Y-15\n G1 Y15\n G1 Y-15');
                break;
            case 'stop':
                sendGCode('M84');
                break;
            case 'dance':
                dance();
                break;
            case 'do the cha cha slide':
                sendGCode(`
                    G1 X15
                    G4 P5
                    G1 X-3
                    G4 P5
                    G1 X-3
                    G4 P750
                    G1 X-15
                    G4 P5
                    G1 X3
                    G4 P5
                    G1 X3
                    G4 P750
                    G1 Y15
                    G4 P5
                    G1 Y-3
                    G4 P5
                    G1 Y-3
                    G4 P750
                    G1 Y-15
                    G4 P5
                    G1 Y3
                    G4 P5
                    G1 Y3
                `);
                break;
            // Fan/light voice commands only work when that button is on screen for this machine
            case 'fan on':
                if (!isShown(fanButton)) { console.log('Ignoring "fan on": no fan on this machine'); break; }
                sendGCode(`M106 S${fanSpeed}`);
                fanButton.classList.add('active');
                break;
            case 'fan off':
                if (!isShown(fanButton)) { console.log('Ignoring "fan off": no fan on this machine'); break; }
                fanButton.classList.remove('active');
                sendGCode('M107');
                break;
            case 'light on':
            case 'lights on':
            case 'uv light on':
            case 'uv lights on':
                if (!isShown(lightButton)) { console.log(`Ignoring "${transcript}": no light on this machine`); break; }
                setLight(true);
                break;
            case 'light off':
            case 'lights off':
            case 'uv light off':
            case 'uv lights off':
                if (!isShown(lightButton)) { console.log(`Ignoring "${transcript}": no light on this machine`); break; }
                setLight(false);
                break;
            case 'run test':
                sendGCode('G1 X10\n G1 X-10\n G4 P200\n G1 Y10\n G1 Y-10');
                break;
            case 'deposit prepolymer':
            case 'extrude prepolymer':
            case 'pipette prepolymer':
            case 'depress syringes':
            case 'depress syringe':
                if (!syringeMoveInRange(syringePosMm + SYRINGE_PRESS_MM) || plungeBlockedByConveyor()) break;
                sendGCode(syringePressGCode());
                noteSyringeMove(SYRINGE_PRESS_MM);
                markTileUnderNeedle(SYRINGE_PRESS_MM);
                break;
            case 'nozzle on':
            case 'sprayer on':
            case 'jet on':
            case 'pump on':
            case 'water on':
                // Only where the pump button shows, so M8 doesn't switch some other machine's coolant output
                if (!isShown(pumpButton)) { console.log(`Ignoring "${transcript}": no pump on this machine`); break; }
                pumpButton.classList.add('active');
                sendGCode('M8');
                break;
            case 'nozzle off':
            case 'sprayer off':
            case 'jet off':
            case 'pump off':
            case 'water off':
                if (!isShown(pumpButton)) { console.log(`Ignoring "${transcript}": no pump on this machine`); break; }
                pumpButton.classList.remove('active');
                sendGCode('M9');
                break;
            case 'pump pulse':
                if (!isShown(pumpButton)) { console.log(`Ignoring "${transcript}": no pump on this machine`); break; }
                sendGCode('M8\n G4 P500\n M9\n');
                break;
            case 'stop listening':
                if (micButton.classList.contains('listening')) {
                    isManuallyStopped = true;
                    recognition.stop();
                }
                break;
            default:
                console.log('Unrecognized command:', transcript);
        }
    };

    recognition.onerror = (event) => {
        console.error('Speech recognition error detected:', event.error);
    };

    // UV light at a brightness from 0 (off) to 1 (full): FAN0 PWM on LaLi (Marlin);
    // the spindle PWM on LaLi (GRBL), which has no fan commands
    function lightLevelGCode(level) {
        if (currentFirmware === 'grbl') return level > 0 ? `M3 S${Math.round(level * UV_SPINDLE_MAX_S)}` : 'M5';
        return level > 0 ? `M106 P0 S${Math.round(level * 255)}` : 'M107 P0';
    }

    function lightGCode(on) {
        return lightLevelGCode(on ? 1 : 0);
    }

    function setLight(on) {
        lightButton.classList.toggle('active', on);
        sendGCode(lightGCode(on));
    }

    lightButton.addEventListener('click', () => {
        setLight(!lightButton.classList.contains('active'));
    });

    fanButton.addEventListener('click', function() {
        this.classList.toggle('active');
        sendGCode(this.classList.contains('active') ? `M106 S${fanSpeed}` : 'M107');
    });

    pumpButton.addEventListener('click', function() {
        this.classList.toggle('active');
        sendGCode(this.classList.contains('active') ? 'M8' : 'M9');
    });

    document.getElementById('bc-lock-button').addEventListener('click', function() {
        bcLocked = !bcLocked;
        this.classList.toggle('active', bcLocked);
        document.querySelector('.bc-group').classList.toggle('locked', bcLocked);
        this.textContent = bcLocked ? '🔒' : '🔓';
        this.title = bcLocked ? 'B and C locked: moving together' : 'Lock B and C so they move together';
        console.log(bcLocked ? 'B/C axes locked together' : 'B/C axes unlocked');
    });

    danceButton.addEventListener('click', function() {
        dance();
    });

    // "Fan On" / "Pump Off" etc. follow the button's state, however it changed (click, voice, connect, Stop)
    [[fanButton, 'fan-label', 'Fan'], [pumpButton, 'pump-label', 'Pump']].forEach(([button, labelId, name]) => {
        const label = document.getElementById(labelId);
        const show = () => { label.textContent = `${name} ${button.classList.contains('active') ? 'On' : 'Off'}`; };
        new MutationObserver(show).observe(button, { attributes: true, attributeFilter: ['class'] });
        show();
    });

    // Home and Dispense may be commented out in the HTML; ?. keeps the rest of setup running without them
    homeButton?.addEventListener('click', function() {
        this.classList.toggle('active');
        sendGCode('G28 X');
    });

    // Sweep buttons are commented out in the HTML; ?. keeps the rest of setup from crashing
    document.getElementById('sweep-10s')?.addEventListener('click', () => runSweep(10));
    document.getElementById('sweep-15s')?.addEventListener('click', () => runSweep(15));
    document.getElementById('sweep-20s')?.addEventListener('click', () => runSweep(20));

    // Prime: sends PRIME_GCODE before a Go! run. Ignored during a run, which resets the primed distance when it ends.
    const primeLabel = document.getElementById('prime-label');
    let priming = false;
    document.getElementById('prime-button').addEventListener('click', async () => {
        if (priming || playButton.classList.contains('active')) return;
        if (!syringeMoveInRange(syringePosMm + PRIME_TOTAL_MM) || plungeBlockedByConveyor()) return;
        priming = true;
        primeLabel.textContent = 'Priming...';
        try {
            await sendGCodeOrThrow(PRIME_GCODE);
            noteSyringeMove(PRIME_TOTAL_MM);
            // No tile mark: priming happens before the tray is put in place, even with the conveyor at tile 1
            setPrimedMm(primedMm + PRIME_TOTAL_MM);
        } catch (error) {
            console.error('Prime failed:', error);
        } finally {
            priming = false;
            primeLabel.textContent = 'Prime';
        }
    });

    document.getElementById('reset-syringes-button').addEventListener('click', () => pressReset('syringes'));
    document.getElementById('reset-conveyor-button').addEventListener('click', () => pressReset('conveyor'));

    // The sync makes the request return only once the press has physically finished,
    // so the label reads "Dispensing..." for exactly as long as the syringes are moving
    const syringeLabel = document.getElementById('syringe-label');
    let dispensing = false;
    document.getElementById('syringe-button')?.addEventListener('click', async () => {
        if (dispensing || !syringeMoveInRange(syringePosMm + SYRINGE_PRESS_MM) || plungeBlockedByConveyor()) return;
        dispensing = true;
        syringeLabel.textContent = 'Dispensing...';
        try {
            await sendGCodeOrThrow([syringePressGCode(), syncGCode()].join('\n'));
            noteSyringeMove(SYRINGE_PRESS_MM);
            markTileUnderNeedle(SYRINGE_PRESS_MM);
        } catch (error) {
            console.error('Dispense failed:', error);
        } finally {
            dispensing = false;
            syringeLabel.textContent = 'Dispense';
        }
    });

    // Prime the syringes and place the first row under them beforehand. UV on, then
    // press/pause/advance x12, advance UV_ADVANCE_STEPS more
    // through the UV tunnel, UV off. The syringes stay where the run left them (Reset Syringes brings them back).
    // Each cycle is its own request ending in a sync, so the request only returns
    // once the cycle has physically finished — that's what drives the progress bar.
    const playButton = document.getElementById('play-button');
    const runProgress = document.getElementById('run-progress');
    const runProgressFill = document.getElementById('run-progress-fill');
    const runProgressLabel = document.getElementById('run-progress-label');
    let hideProgressTimer = null;

    // Go! sounds: the bell when it finishes all its steps, the alert when a step fails (not when 🛑 Stop ends it).
    // Loaded up front so they play on time.
    const doneBell = new Audio('/static/sounds/bell.mp3');
    const failAlert = new Audio('/static/sounds/alert.mp3');
    doneBell.preload = failAlert.preload = 'auto';
    function playSound(sound) {
        sound.currentTime = 0;
        sound.play().catch(error => console.warn(`Could not play ${sound.src}:`, error));
    }

    function setProgress(done, total, label, state = '') {
        runProgress.style.display = '';
        runProgress.className = state;
        runProgressFill.style.width = `${(done / total) * 100}%`;
        runProgressLabel.textContent = label;
    }

    function goBlocked() {
        if (playButton.classList.contains('active') || playButton.disabled) return true;
        if (resetRunning || syringePresetMoving) return true;
        // At tile 1 by the totals, but the drawing still has the tray on its way back
        if (currentMachine === 'lali-grbl' && conveyorMoving()) {
            console.warn('Go! ignored: the conveyor is still moving');
            return true;
        }
        // All 12 presses have to fit before the syringes' end of travel
        return !syringeMoveInRange(syringePosMm + SYRINGE_PRESS_MM * SEQUENCE_REPEATS);
    }

    // Go! asks first, with a checklist that starts unticked every time. Confirm (or Return) is only enabled once
    // every item is ticked, and starts the run; Cancel, Esc or a click outside the card doesn't.
    const goConfirm = document.getElementById('go-confirm');
    const goConfirmButton = document.getElementById('go-confirm-button');
    const goChecks = [...goConfirm.querySelectorAll('.go-check')];
    const updateGoConfirmButton = () => { goConfirmButton.disabled = !goChecks.every(check => check.checked); };
    goChecks.forEach(check => check.addEventListener('change', updateGoConfirmButton));
    let closeGoConfirm = null;
    function askGoConfirm() {
        return new Promise(resolve => {
            const opener = document.activeElement;
            goChecks.forEach(check => { check.checked = false; });
            updateGoConfirmButton();
            goConfirm.hidden = false;
            goChecks[0].focus();
            closeGoConfirm = (confirmed) => {
                goConfirm.hidden = true;
                closeGoConfirm = null;
                document.activeElement?.blur(); // off the hidden buttons, even if there's nothing to go back to
                opener?.focus?.();
                resolve(confirmed);
            };
        });
    }
    goConfirmButton.addEventListener('click', () => closeGoConfirm?.(true));
    document.getElementById('go-cancel').addEventListener('click', () => closeGoConfirm?.(false));
    goConfirm.addEventListener('click', (event) => { if (event.target === goConfirm) closeGoConfirm?.(false); });
    // Capture phase, so while it's open no other key handler (arrow keys, Return on a focused button) sees the key
    window.addEventListener('keydown', (event) => {
        if (!closeGoConfirm) return;
        if (event.key === 'Enter') { if (!goConfirmButton.disabled) closeGoConfirm(true); }
        else if (event.key === 'Escape') closeGoConfirm(false);
        else if (event.key === 'Tab' || event.key === ' ') return; // move between the controls / tick the focused item
        else return void event.stopImmediatePropagation(); // e.g. arrow keys don't move the machine underneath
        event.preventDefault();
        event.stopImmediatePropagation();
    }, true);

    playButton.addEventListener('click', async () => {
        if (goBlocked() || closeGoConfirm) return;
        if (!await askGoConfirm()) return;
        if (goBlocked()) return; // something started while the dialog was open
        clearTimeout(hideProgressTimer);

        // After cycle 1, every cycle follows the previous cycle's conveyor move, and that step
        // ended with a sync, so this pause starts once the conveyor has stopped
        const cycle = [
            dwellGCode(PRE_PLUNGE_PAUSE_S),
            syringePressGCode(),
            dwellGCode(SYRINGE_WAIT_TIME),
            conveyorAdvanceGCode(SEQUENCE_X_STEP_MM),
            syncGCode()
        ].join('\n');
        // Wait, then advance one conveyor step (tray moving through the UV tunnel)
        const uvAdvance = [
            dwellGCode(UV_ADVANCE_INTERVAL_S),
            conveyorAdvanceGCode(SEQUENCE_X_STEP_MM),
            syncGCode()
        ].join('\n');

        // Tile strip timing, from the start of each step's request: the pause, the press, the wait, the advance
        const pressAt = REQUEST_OVERHEAD_S + PRE_PLUNGE_PAUSE_S;
        const pressSeconds = moveSeconds(SYRINGE_PRESS_MM, SYRINGE_PRESS_FEEDRATE, SYRINGE_ACCEL);
        const animateCycle = () => {
            noteDispense(pressAt, pressSeconds, SYRINGE_PRESS_MM);
            noteConveyorMove(SEQUENCE_X_STEP_MM, pressAt + pressSeconds + SYRINGE_WAIT_TIME);
        };
        const animateUvAdvance = () => noteConveyorMove(SEQUENCE_X_STEP_MM, REQUEST_OVERHEAD_S + UV_ADVANCE_INTERVAL_S);

        const steps = [
            // UV lights go on at the start of the first cycle
            ...Array.from({ length: SEQUENCE_REPEATS }, (_, i) => i === 0
                ? {
                    gcode: [lightGCode(true), cycle].join('\n'),
                    label: `Cycle 1 of ${SEQUENCE_REPEATS}`,
                    syringeMm: SYRINGE_PRESS_MM,
                    onStart: () => { lightButton.classList.add('active'); animateCycle(); }
                }
                : { gcode: cycle, label: `Cycle ${i + 1} of ${SEQUENCE_REPEATS}`, syringeMm: SYRINGE_PRESS_MM, onStart: animateCycle }
            ),
            ...Array.from({ length: UV_ADVANCE_STEPS }, (_, i) => (
                { gcode: uvAdvance, label: `UV tunnel: advance ${i + 1} of ${UV_ADVANCE_STEPS}`, onStart: animateUvAdvance }
            )),
            // The last step ended with a sync, so it has finished before the lights go off
            { gcode: lightGCode(false), label: 'UV lights off', onStart: () => lightButton.classList.remove('active') }
        ];
        // GRBL: hold the motors from the first step, and put the usual delay back at the start of the last move
        // (every step before it ends idle, as $ settings need), so they switch off as soon as that move ends.
        // GRBL only applies $1 when a move ends or on a reset.
        const holdMotors = currentFirmware === 'grbl';
        if (holdMotors) {
            steps[0].gcode = [syncGCode(), `$1=${STEPPER_HOLD_IDLE}`, steps[0].gcode].join('\n');
            const lastMove = steps.length - 2; // the step before UV lights off
            steps[lastMove].gcode = [`$1=${STEPPER_RELEASE_IDLE_MS}`, steps[lastMove].gcode].join('\n');
        }

        playButton.classList.add('active');
        resetTiles(); // the first row is placed under the needle before Go!
        let step = 0;
        const runStopCount = stopCount;
        try {
            for (; step < steps.length; step++) {
                // Stop pressed between steps: the board has nothing to cancel, so stop here
                if (stopCount !== runStopCount) throw new Error('Stopped by user');
                setProgress(step, steps.length, steps[step].label);
                steps[step].onStart?.(); // keep the light button in step with the routine
                await sendGCodeOrThrow(steps[step].gcode);
                if (steps[step].syringeMm) noteSyringeMove(steps[step].syringeMm);
            }
            setProgress(steps.length, steps.length, 'Done', 'done');
            playSound(doneBell);
        } catch (error) {
            console.error('Sequence stopped:', error);
            freezeTiles();
            setProgress(step, steps.length, `Stopped during ${steps[step].label.toLowerCase()}: ${error.message}`, 'failed');
            if (stopCount === runStopCount) playSound(failAlert); // a failure, not 🛑 Stop
            if (holdMotors) releaseMotors(stopCount !== runStopCount);
        } finally {
            playButton.classList.remove('active');
            setPrimedMm(0); // finished or stopped: prime again before the next run
            hideProgressTimer = setTimeout(() => { runProgress.style.display = 'none'; }, 5000);
        }
    });

    // After a run that didn't finish: put the usual idle delay back. After 🛑 Stop, also soft reset again, which
    // switches the motors off now (Stop's own reset already cleared the G92 offset). After a failure, they
    // switch off after the next move instead, so the offset is kept.
    async function releaseMotors(stopped) {
        try {
            await sendGCodeOrThrow(`$1=${STEPPER_RELEASE_IDLE_MS}`);
            if (stopped) await fetch('/stop', { method: 'POST' });
        } catch (error) {
            console.warn('Could not release the motors:', error); // the board sets the delay again on connect
        }
    }

    function runSweep(timeInSeconds) {
        // Calculate feed rate based on time
        const tileWidth = INCH_TO_MM * 2; // 2 inches
        const timeInMinutes = timeInSeconds / 60;
        const feedRate = Math.round(tileWidth / timeInMinutes);

        // Start pump, prime pump, move into position, sweep, move out of position, stop pump
        sendGCode(`
            M8
            G4 P5
            G91
            G1 Y${INCH_TO_MM} F500
            G1 Y50.8 F${feedRate}
            G1 Y10 F500
            G1 Y${INCH_TO_MM} F500
            M9
        `);
    }

    function dance() {
        const gcode = `
            G1 Y${distance} F${feedRate}
            G1 X${distance} F${feedRate}
            G1 Y-${distance} F${feedRate}
            G1 X-${distance} F${feedRate}
        `;
        sendGCode(gcode);
    }


    // Each slider is paired with its typed number box. The slider sets values in its own steps; the box
    // takes any positive value (finer than the slider) and moves the slider to the nearest position.
    // If the box is left empty or invalid, it snaps back to the active value when you click away.
    // Sliders are mouse/touch only: not reachable with Tab, and they drop focus once released so the
    // keyboard goes back to moving the stage.
    function bindSliderPair(slider, box, setValue, getValue) {
        slider.tabIndex = -1;
        slider.addEventListener('change', () => slider.blur());
        slider.addEventListener('input', () => {
            setValue(parseFloat(slider.value));
            box.value = slider.value;
        });
        box.addEventListener('input', () => {
            const typed = parseFloat(box.value);
            if (isNaN(typed) || typed <= 0) return;
            setValue(typed);
            slider.value = typed; // browser clamps/rounds to the slider's range
        });
        box.addEventListener('blur', () => { box.value = getValue(); });
        setValue(parseFloat(slider.value));
        box.value = slider.value;
    }

    bindSliderPair(speedSlider, speedValueInput, v => { feedRate = v; }, () => feedRate);
    bindSliderPair(rangeSlider, rangeValueInput, v => { distance = v; }, () => distance);
    bindSliderPair(document.getElementById('plunger-speed-slider'), document.getElementById('plunger-speed-value'),
        v => { plungerFeedRate = v; }, () => plungerFeedRate);
    // Plunger Distance in mm or µL (LaLi GRBL's switch). The moves always use plungerDistance in mm; in µL mode the
    // slider and box show the volume each syringe pushes per click, converted with the syringe calibration.
    const PLUNGER_UNITS = {
        mm: { min: 0.25, max: 10, step: 0.01, decimals: 2, toMm: v => v },
        ul: { min: 10, max: 1000, step: 10, decimals: 0, toMm: v => v / 1000 / (SYRINGE_HOME_ML - SYRINGE_END_ML) * SYRINGE_TRAVEL_MM },
    };
    let plungerDistanceShown = plungerDistance; // in plungerUnit, as typed or slid (so it doesn't drift through conversions)
    const plungerDistanceSlider = document.getElementById('plunger-distance-slider');
    const plungerDistanceBox = document.getElementById('plunger-distance-value');
    bindSliderPair(plungerDistanceSlider, plungerDistanceBox,
        v => { plungerDistanceShown = v; plungerDistance = Number(PLUNGER_UNITS[plungerUnit].toMm(v).toFixed(4)); },
        () => plungerDistanceShown);

    // Switching keeps the same physical distance, capped at the new unit's maximum, unless shown gives the new value
    function setPlungerUnit(unit, shown) {
        if (unit === plungerUnit && shown === undefined) return;
        const to = PLUNGER_UNITS[unit];
        shown ??= Math.min(Math.max(plungerDistance / to.toMm(1), to.min), to.max);
        plungerUnit = unit;
        Object.assign(plungerDistanceSlider, { min: to.min, max: to.max, step: to.step });
        plungerDistanceSlider.value = shown;
        plungerDistanceShown = Number(shown.toFixed(to.decimals));
        plungerDistance = Number(to.toMm(plungerDistanceShown).toFixed(4));
        plungerDistanceBox.value = plungerDistanceShown;
        document.querySelectorAll('#plunger-unit [data-unit]').forEach(button => {
            const selected = button.dataset.unit === unit;
            button.classList.toggle('active', selected);
            button.setAttribute('aria-checked', selected);
        });
        showSyringeReadout(parseFloat(document.getElementById('syringe-slider').value));
    }
    document.querySelectorAll('#plunger-unit [data-unit]').forEach(button =>
        button.addEventListener('click', () => setPlungerUnit(button.dataset.unit)));

    // Syringe slider: drag anywhere on the drawn syringe. The plunger follows the pointer 1:1 from
    // where you grabbed it; releasing moves the syringes there. The hidden range input just holds the value.
    const syringeSlider = document.getElementById('syringe-slider');
    const syringeVisual = document.getElementById('syringe-visual');
    syringeSlider.max = SYRINGE_TRAVEL_MM;
    let syringeDrag = null;

    // Start-volume selector: one button per preset, none selected until one is picked after Set Home
    const presetSelect = document.getElementById('syringe-preset');
    SYRINGE_PRESETS_ML.forEach(ml => {
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('role', 'radio');
        button.setAttribute('aria-checked', 'false');
        button.dataset.ml = ml;
        button.textContent = `${ml} mL`;
        button.title = `Move the syringes to ${ml} mL (${syringeMmForMl(ml).toFixed(2)} mm below Set Home)`;
        button.addEventListener('click', () => pickSyringePreset(ml));
        presetSelect.appendChild(button);
    });

    // Volume scale on the barrel: a label every 0.5 mL, read at the stopper's bottom edge.
    // --capacity also spaces the tick marks in the CSS.
    syringeVisual.style.setProperty('--capacity', SYRINGE_CAPACITY_ML);
    for (let ml = 0.5; ml <= SYRINGE_CAPACITY_ML; ml += 0.5) {
        const mark = document.createElement('span');
        mark.className = 'syringe-mark';
        mark.style.setProperty('--fraction', ml / SYRINGE_CAPACITY_ML);
        mark.textContent = ml === SYRINGE_CAPACITY_ML ? `${ml} mL` : ml;
        syringeVisual.appendChild(mark);
    }

    // Typing in the number above the syringe moves it there (mm below Set Home, or mL held), like a drag
    const syringePositionBox = document.getElementById('syringe-position');
    syringePositionBox.addEventListener('pointerdown', event => event.stopPropagation()); // click to type, not drag
    syringePositionBox.addEventListener('keydown', event => {
        if (event.key === 'Enter') syringePositionBox.blur();
        else if (event.key === 'Escape') { syringePositionBox.dataset.cancel = '1'; syringePositionBox.blur(); }
    });
    syringePositionBox.addEventListener('blur', () => {
        const cancelled = syringePositionBox.dataset.cancel;
        delete syringePositionBox.dataset.cancel;
        const value = parseFloat(syringePositionBox.value);
        const busy = playButton.classList.contains('active') || dispensing || resetRunning || syringePresetMoving || syringeDragMoving();
        if (!cancelled && !Number.isNaN(value)) {
            const mm = Number((plungerUnit === 'ul' ? syringeMmForMl(value) : value).toFixed(4));
            if (busy) console.warn('Syringe position ignored while a routine is running or the syringes are still moving');
            else if (refusedBeforeHome('Typing a syringe position')) { /* put the number back */ }
            else if (Math.abs(mm - syringePosMm) > 1e-4) { moveSyringesTo(mm); return; }
        }
        showSyringePosition(syringePosMm); // put the number back
    });

    syringeVisual.addEventListener('pointerdown', (event) => {
        if (refusedBeforeHome('Dragging the syringe')) return;
        if (playButton.classList.contains('active') || dispensing || resetRunning || syringePresetMoving || syringeDragMoving()) {
            console.warn('Syringe slider ignored while a routine is running or the syringes are still moving');
            return;
        }
        // Plunger travel on screen, measured live so it's right at any zoom/screen size
        const style = getComputedStyle(syringeVisual);
        const travelPx = syringeVisual.getBoundingClientRect().height *
            parseFloat(style.getPropertyValue('--travel')) / parseFloat(style.height);
        syringeDrag = { startY: event.clientY, startValue: parseFloat(syringeSlider.value), travelPx };
        try { syringeVisual.setPointerCapture(event.pointerId); } catch { /* keeps working without capture */ }
        syringeVisual.classList.add('dragging');
    });

    syringeVisual.addEventListener('pointermove', (event) => {
        if (!syringeDrag) return;
        // --travel on screen is the whole drawn scale (SYRINGE_CAPACITY_ML), not just the 0–44 mm the plunger can go
        const drawnMm = SYRINGE_CAPACITY_ML / (SYRINGE_HOME_ML - SYRINGE_END_ML) * SYRINGE_TRAVEL_MM;
        const deltaMm = (event.clientY - syringeDrag.startY) / syringeDrag.travelPx * drawnMm;
        // The input clamps to 0–SYRINGE_TRAVEL_MM, so the drag stops at Set Home and the end of travel.
        // Past either end the plunger waits there, and letting go moves the syringes to that end.
        const mm = syringeDrag.startValue + deltaMm;
        syringeSlider.value = mm.toFixed(2);
        showSyringeReadout(parseFloat(syringeSlider.value));
        fillSyringeSlider(parseFloat(syringeSlider.value));
    });

    function endSyringeDrag(commit) {
        if (!syringeDrag) return;
        const moved = parseFloat(syringeSlider.value) !== syringeDrag.startValue;
        syringeDrag = null;
        syringeVisual.classList.remove('dragging');
        if (commit && moved) {
            moveSyringesTo(parseFloat(syringeSlider.value));
        } else {
            showSyringePosition(syringePosMm);
        }
    }

    syringeVisual.addEventListener('pointerup', () => endSyringeDrag(true));
    syringeVisual.addEventListener('pointercancel', () => endSyringeDrag(false));
    showSyringePosition(syringePosMm);
});

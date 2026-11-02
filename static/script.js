const fanSpeed = 255;
const INCH_TO_MM = 25.4;
let feedRate = 400;          // Movement Speed: X/Y, keyboard, voice, conveyor
let distance = 50;           // Movement Distance
let plungerFeedRate = 200;   // Plunger Speed: syringe arrows and the drag-to-position syringe (LaLi)
let plungerDistance = 1.35;   // Plunger Distance: syringe arrows (LaLi)

// TEMPORARY: show the selected machine's controls even when no board is connected (for UI work).
// Set back to false once testing with the real machine.
const PREVIEW_WITHOUT_BOARD = true;
const PREVIEW_DEFAULT_MACHINE = 'lali-grbl'; // shown in preview mode if no machine has been chosen yet

const SYRINGE_PRESS_MM = 1.35;
const SYRINGE_TRAVEL_MM = 40; // syringe position slider: 0 = home (fully up) to this many mm plunged
// For the drawn syringe's scale only: full travel is assumed to empty the whole syringe
const SYRINGE_CAPACITY_ML = 2.5;
const SYRINGE_START_ML = 1.5; // what the syringes are assumed to hold when LaLi (GRBL) is selected
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
// Prime button (LaLi GRBL only): two 2 mm presses 1 s apart. G4 P is seconds on GRBL; the final G4 P0
// waits for the moves to finish, so the label reads "Priming..." until the syringes stop.
const PRIME_GCODE = `
G1 Y3 F500
G4 P0
`;
const PRIME_TOTAL_MM = 4; // what PRIME_GCODE plunges, for the drawn syringe
const CONVEYOR_AXIS = 'X';
// Direction the Go! routine advances the conveyor (1 = positive, -1 = negative). Only affects Go!.
const CONVEYOR_DIRECTION = 1;
const SEQUENCE_X_STEP_MM = 14.2;
// After the last syringe cycle, keep advancing the conveyor until the last row is through the UV tunnel.
// 11 steps take the last row past all 11 stops. At 0, UV off and the retract follow the last cycle.
const UV_ADVANCE_STEPS = 11;
// Wait before each tunnel advance. 1.4 s + the advance + overhead ≈ one cycle (~4.1 s),
// so the last rows get the same UV time as the rest
const UV_ADVANCE_INTERVAL_S = 1.4;
// LaLi (GRBL) drives the UV MOSFET from the spindle PWM pin (D11). Full brightness = S at
// GRBL 0.9's SPINDLE_MAX_RPM (config.h, default 1000; on GRBL 1.1 it's the $30 setting).
const UV_SPINDLE_MAX_S = 1000;

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
    const gcode = `G1 ${axis}${distance * axisDirection(axis)} F${feedRate}`;
    sendGCode(gcode);
    if (currentMachine?.startsWith('lali') && axis === CONVEYOR_AXIS) {
        noteConveyorMove(distance * axisDirection(axis) * CONVEYOR_DIRECTION);
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
// Position = mm plunged below home (positive = down). The board keeps the real coordinate: "Set Home"
// sets it to SYRINGE_START_ML with G92 and the slider moves there in absolute mode, so those moves are exact.
// syringePosMm is only the page's running total for drawing the slider, updated by every syringe move
// it sends; it doesn't see custom G-code or an emergency stop. It starts at SYRINGE_START_ML when
// LaLi (GRBL) is selected, and the board's coordinate is set to match.
let syringePosMm = 0;

// mm below home (full) at which the syringes hold this many mL
function syringeMmForMl(ml) {
    return Number(((SYRINGE_CAPACITY_ML - ml) / SYRINGE_CAPACITY_ML * SYRINGE_TRAVEL_MM).toFixed(4));
}

function syringeAxesWords(mm) {
    if (currentMachine === 'lali-grbl') return `${GRBL_SYRINGE_AXIS}${mm * axisDirection(GRBL_SYRINGE_AXIS)}`;
    return `B${mm} C${mm}`;
}

function noteSyringeMove(mm) {
    syringePosMm = Number((syringePosMm + mm).toFixed(4));
    showSyringePosition(syringePosMm);
}

function showSyringePosition(mm) {
    const slider = document.getElementById('syringe-slider');
    if (!slider) return;
    slider.value = Math.min(Math.max(mm, 0), SYRINGE_TRAVEL_MM); // draws at the end stop if outside the range
    showSyringeReadout(mm);
    fillSyringeSlider(slider);
}

// The number above the syringe: mm plunged past home (Set Home, at SYRINGE_START_ML), so it reads 0 there
// and goes negative above it
function showSyringeReadout(mm) {
    const fromHome = Number((mm - syringeMmForMl(SYRINGE_START_ML)).toFixed(2));
    document.getElementById('syringe-position').textContent = `${fromHome === 0 ? 0 : fromHome} mm`;
}

// Moves the drawn plunger: --pos goes from 0 (home, plunger up) to 1 (full travel)
function fillSyringeSlider(slider) {
    const fraction = (slider.value - slider.min) / (slider.max - slider.min);
    document.getElementById('syringe-visual').style.setProperty('--pos', fraction);
}

// --- Priming (LaLi GRBL) ---
// Go! stays disabled until Prime has been pressed. Each Prime adds to primedMm, and Go! pulls it back up
// at the end along with its own presses. A manual pull-up (▲, or dragging the syringe up) resets it,
// and so does the end of a Go! run, finished or stopped.
let primedMm = 0;

function setPrimedMm(mm) {
    primedMm = mm;
    updatePlayButton();
}

// Only LaLi (GRBL) has the Prime button, so only it waits for priming
function updatePlayButton() {
    const playButton = document.getElementById('play-button');
    playButton.dataset.title ??= playButton.title;
    const needsPrime = currentMachine === 'lali-grbl' && primedMm <= 0;
    playButton.disabled = needsPrime;
    playButton.title = needsPrime ? 'Press 💧 Prime first' : playButton.dataset.title;
}

function moveSyringes(mm) {
    if (mm > 0 && plungeBlockedByConveyor()) return;
    sendGCode(syringeMoveGCode(mm, plungerFeedRate));
    noteSyringeMove(mm);
    if (mm < 0) setPrimedMm(0);
    if (mm > 0) markTileUnderNeedle();
}

function moveSyringesTo(mm) {
    if (mm > syringePosMm && plungeBlockedByConveyor()) {
        showSyringePosition(syringePosMm); // put the dragged plunger back
        return;
    }
    if (mm < syringePosMm) setPrimedMm(0);
    if (mm > syringePosMm) markTileUnderNeedle();
    sendGCode(['G90', `G1 ${syringeAxesWords(mm)} F${plungerFeedRate}`, 'G91'].join('\n'));
    syringePosMm = mm;
    showSyringePosition(mm);
}

// Set Home: the syringes are at SYRINGE_START_ML right now and tile 1 is under the needle, so the conveyor
// is at 0 (G92 doesn't move anything). Reset moves back to both. The tile strip goes back to home too.
function setSyringeHome() {
    const mm = syringeMmForMl(SYRINGE_START_ML);
    sendGCode(`G92 ${CONVEYOR_AXIS}0 ${syringeAxesWords(mm)}`);
    syringePosMm = mm;
    showSyringePosition(mm);
    resetTiles();
}


// --- Tile strip (LaLi) ---
// Side view of the SEQUENCE_REPEATS tiles under the drawn syringe's needle. Home = tile 1 (the rightmost) centred under
// the needle; each conveyor advance slides the row right so the next tile is centred, and on into the
// UV tunnel. Like syringePosMm, it's the page's estimate from the moves it sends: it doesn't see custom
// G-code, and Stop freezes it wherever the drawing was. Go! puts it back at home when it starts.
const UV_TUNNEL_MM = SEQUENCE_REPEATS * SEQUENCE_X_STEP_MM; // exactly all 12 tiles, from the trailing edge of the tile under the needle
const CONVEYOR_MAX_FEED = 500; // $110: GRBL caps faster X moves to this
const CONVEYOR_ACCEL = 10; // $120, mm/s²
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

// From speed v0 (mm/s) to a stop, distance mm away: speed up to the feed rate (or as fast as there's room
// for), cruise, slow down
function planConveyorMotion(t0, p0, v0, dir, distance) {
    const a = CONVEYOR_ACCEL;
    const vMax = Math.min(feedRate, CONVEYOR_MAX_FEED) / 60;
    v0 = Math.min(v0, vMax);
    const vPeak = Math.min(Math.max(Math.sqrt(a * distance + v0 * v0 / 2), v0), vMax);
    if (vPeak <= 0) return null;
    const cruise = Math.max(0, distance - (vPeak * vPeak - v0 * v0) / (2 * a) - vPeak * vPeak / (2 * a));
    return { t0, p0, dir, distance, v0, vPeak, a, ta: (vPeak - v0) / a, tc: cruise / vPeak, td: vPeak / a };
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

function startConveyorMotion(t, mm) {
    conveyorMotion = planConveyorMotion(t, conveyorRestMm, 0, Math.sign(mm), Math.abs(mm));
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

// A move reaching the board at time t
function addConveyorMove(mm, t) {
    settleConveyor(t);
    const dir = Math.sign(mm);
    if (!dir) return;
    const last = conveyorQueue[conveyorQueue.length - 1];
    if (!conveyorMotion) {
        startConveyorMotion(t, mm);
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
}

function conveyorMoving() {
    const now = performance.now();
    settleConveyor(now);
    return pendingConveyorMoves > 0 || conveyorMotion !== null || now < conveyorStoppedAt + PLUNGE_CONVEYOR_MARGIN_MS;
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
            <rect class="tile-resin" x="${x + 1.6}" y="30" width="${w - 3.2}" height="1" rx="0.5"/>
            <polygon class="tile-body" points="${body.map(p => p.join(',')).join(' ')}"/>
            <text x="${x + w / 2}" y="35.5">${i + 1}</text>
            <text class="tile-timer" x="${x + w / 2}" y="28"></text>
        </g>`;
    }).join('');
    const tunnelX = w / 2;
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
        if (centre > w / 2 && centre < w / 2 + UV_TUNNEL_MM) tunnelMs[i] = (tunnelMs[i] ?? 0) + (uvOn ? elapsed : 0);
        if (tunnelMs[i] === undefined) return; // hasn't been in yet
        const seconds = Math.floor(tunnelMs[i] / 1000);
        tile.querySelector('.tile-timer').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
        tile.classList.add('timed');
    });
}

// Line the strip up under the drawn syringe: its x = 0 under the needle, the needle tip just above the tiles.
// The margin sets the height (it's between the controllers and the strip, so it's exact even though the
// page is centred); the transform sets the sideways shift. Only works while both are shown.
function alignTileStrip() {
    const strip = document.getElementById('tile-strip');
    const svg = strip?.querySelector('svg');
    const needle = document.querySelector('.syringe-needle');
    if (!svg || !needle || !strip.offsetParent || !needle.offsetParent) return;
    strip.style.marginTop = '';
    strip.style.transform = '';
    const tip = needle.getBoundingClientRect();
    const target = new DOMPoint(0, TILE_STRIP_NEEDLE_Y).matrixTransform(svg.getScreenCTM());
    strip.style.marginTop = `${tip.bottom - target.y}px`;
    strip.style.transform = `translateX(${tip.left + tip.width / 2 - target.x}px)`;
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
function noteConveyorMove(mm, delaySeconds = REQUEST_OVERHEAD_S) {
    conveyorMm = Number((conveyorMm + mm).toFixed(4));
    pendingConveyorMoves++;
    tileLater(delaySeconds, () => {
        pendingConveyorMoves--;
        addConveyorMove(mm, performance.now());
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

// Every extrusion (Go! presses, Prime, ▼ / ↓, dragging the syringe down, Dispense) marks the tile under
// the needle as having material on it: it turns purple, and only marked tiles get a tunnel timer
// (nothing to crosslink otherwise). "Under" = the needle is within the tile, where the drawing has it now.
function markTileUnderNeedle() {
    if (!document.getElementById('tile-row')) return;
    const i = Math.round(drawnConveyorMm() / SEQUENCE_X_STEP_MM);
    document.querySelector(`#tile-strip [data-tile="${i}"]`)?.classList.add('dispensed');
}

// Drip from the drawn syringe during the press, then mark the tile under the needle
function noteDispense(delaySeconds, pressSeconds) {
    const syringe = document.getElementById('syringe-visual');
    tileLater(delaySeconds, () => syringe.classList.add('dripping'));
    tileLater(delaySeconds + pressSeconds, () => {
        syringe.classList.remove('dripping');
        markTileUnderNeedle();
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
    document.querySelectorAll('#tile-strip .tile').forEach(tile => tile.classList.remove('dispensed', 'timed'));
    placeConveyor(0);
}

// Reset button: after delaySeconds the conveyor drives back to home (after anything still queued), carrying
// the row back with it (no tunnel timing on the way); the row is cleared once it's stopped there
function rewindTiles(delaySeconds) {
    cancelTileAnimations();
    rewinding = true;
    if (!conveyorMm) {
        tileLater(delaySeconds, resetTiles);
        return;
    }
    noteConveyorMove(-conveyorMm, delaySeconds);
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
                // Start the drawn syringe at SYRINGE_START_ML, and set the board's coordinate to match (G92
                // doesn't move anything), so dragging the syringe still moves to exact positions.
                // The conveyor's home is wherever it is now, until Set Home.
                syringePosMm = syringeMmForMl(SYRINGE_START_ML);
                showSyringePosition(syringePosMm);
                if (connected) sendGCode(`G92 ${CONVEYOR_AXIS}0 ${syringeAxesWords(syringePosMm)}`);
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
    // this stays right even if the browser slows the polling down in a background tab
    const usbStatus = document.getElementById('usb-status');
    let reportedDrop = false;
    async function pollConnection() {
        try {
            const data = await (await fetch('/connection')).json();
            usbStatus.classList.toggle('dropped', data.state === 'dropped');
            if (data.state === 'connected') {
                usbStatus.textContent = `USB connected for ${data.duration}`;
                reportedDrop = false;
            } else if (data.state === 'dropped') {
                usbStatus.textContent = `USB connection lost after ${data.duration}. Restart the app to reconnect.`;
                if (!reportedDrop) console.error(`USB connection lost after ${data.duration}`);
                reportedDrop = true;
            } else {
                usbStatus.textContent = '';
            }
        } catch {
            usbStatus.textContent = 'App not responding';
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

    document.addEventListener('keydown', (event) => {
        // Let arrow keys edit text/number boxes instead of moving the stage
        if (event.target.tagName === 'INPUT' && event.target.type !== 'range') return;
        // A slider keeps focus after it's dragged; stop the key from also nudging it
        if (event.target.type === 'range' && SLIDER_KEYS.includes(event.key)) event.preventDefault();
        if (!keysEnabled) return;
        // On LaLi (GRBL) Y is the syringes, so ↑/↓ work like the syringe ▲/▼ buttons (plunger distance)
        const plunger = currentMachine === 'lali-grbl';
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
                if (plungeBlockedByConveyor()) break;
                sendGCode(syringePressGCode());
                noteSyringeMove(SYRINGE_PRESS_MM);
                markTileUnderNeedle();
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
        if (priming || playButton.classList.contains('active') || plungeBlockedByConveyor()) return;
        priming = true;
        primeLabel.textContent = 'Priming...';
        try {
            await sendGCodeOrThrow(PRIME_GCODE);
            noteSyringeMove(PRIME_TOTAL_MM);
            markTileUnderNeedle();
            setPrimedMm(primedMm + PRIME_TOTAL_MM);
        } catch (error) {
            console.error('Prime failed:', error);
        } finally {
            priming = false;
            primeLabel.textContent = 'Prime';
        }
    });

    // Reset: syringes up to their Set Home position (SYRINGE_START_ML), then the conveyor back to its Set Home
    // position (X0), in absolute mode on the board's coordinates. Ignored during a run. The on-screen syringe
    // and tiles go back to home even if the board doesn't answer (with a console warning).
    const resetLabel = document.getElementById('reset-label');
    let resetting = false;
    document.getElementById('reset-button')?.addEventListener('click', async () => {
        if (resetting || playButton.classList.contains('active')) return;
        resetting = true;
        resetLabel.textContent = 'Resetting...';
        const homeMm = syringeMmForMl(SYRINGE_START_ML);
        const syringeSeconds = moveSeconds(syringePosMm - homeMm, Math.min(SYRINGE_RETRACT_FEEDRATE, CONVEYOR_MAX_FEED), SYRINGE_ACCEL);
        rewindTiles(REQUEST_OVERHEAD_S + syringeSeconds);
        const resetStopCount = stopCount;
        let stopped = false;
        try {
            await sendGCodeOrThrow([
                'G90',
                `G1 ${syringeAxesWords(homeMm)} F${SYRINGE_RETRACT_FEEDRATE}`,
                `G1 ${CONVEYOR_AXIS}0 F${feedRate}`,
                'G91',
                syncGCode()
            ].join('\n'));
        } catch (error) {
            stopped = stopCount !== resetStopCount;
            if (stopped) {
                // Stop pressed partway: the machine is somewhere in between, so leave the drawings where they got to
                console.error('Reset stopped:', error);
            } else {
                // Still reset the drawings, so the page can be put back to home without a board
                console.warn('Reset: no response from the board, so the syringes and conveyor may not have moved. Resetting the on-screen syringe and tiles anyway.', error);
                resetTiles();
            }
        } finally {
            if (!stopped) {
                syringePosMm = homeMm;
                showSyringePosition(homeMm);
            }
            setPrimedMm(0); // pulled back up (or partway)
            resetting = false;
            resetLabel.textContent = 'Reset';
        }
    });

    // The sync makes the request return only once the press has physically finished,
    // so the label reads "Dispensing..." for exactly as long as the syringes are moving
    const syringeLabel = document.getElementById('syringe-label');
    let dispensing = false;
    document.getElementById('syringe-button')?.addEventListener('click', async () => {
        if (dispensing || plungeBlockedByConveyor()) return;
        dispensing = true;
        syringeLabel.textContent = 'Dispensing...';
        try {
            await sendGCodeOrThrow([syringePressGCode(), syncGCode()].join('\n'));
            noteSyringeMove(SYRINGE_PRESS_MM);
            markTileUnderNeedle();
        } catch (error) {
            console.error('Dispense failed:', error);
        } finally {
            dispensing = false;
            syringeLabel.textContent = 'Dispense';
        }
    });

    // Prime the syringes and place the first row under them beforehand. UV on, then
    // press/pause/advance x12, advance UV_ADVANCE_STEPS more
    // through the UV tunnel, UV off, then pull the syringes back up.
    // Each cycle is its own request ending in a sync, so the request only returns
    // once the cycle has physically finished — that's what drives the progress bar.
    const playButton = document.getElementById('play-button');
    const runProgress = document.getElementById('run-progress');
    const runProgressFill = document.getElementById('run-progress-fill');
    const runProgressLabel = document.getElementById('run-progress-label');
    let hideProgressTimer = null;

    function setProgress(done, total, label, state = '') {
        runProgress.style.display = '';
        runProgress.className = state;
        runProgressFill.style.width = `${(done / total) * 100}%`;
        runProgressLabel.textContent = label;
    }

    playButton.addEventListener('click', async () => {
        if (playButton.classList.contains('active') || playButton.disabled) return;
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
        // Go!'s presses plus everything primed, so the syringes end where they were before priming
        const totalPressed = Number((SYRINGE_PRESS_MM * SEQUENCE_REPEATS + primedMm).toFixed(4));
        const retract = [syringeMoveGCode(-totalPressed, SYRINGE_RETRACT_FEEDRATE), syncGCode()].join('\n');

        // Tile strip timing, from the start of each step's request: the pause, the press, the wait, the advance
        const pressAt = REQUEST_OVERHEAD_S + PRE_PLUNGE_PAUSE_S;
        const pressSeconds = moveSeconds(SYRINGE_PRESS_MM, SYRINGE_PRESS_FEEDRATE, SYRINGE_ACCEL);
        const animateCycle = () => {
            noteDispense(pressAt, pressSeconds);
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
            { gcode: lightGCode(false), label: 'UV lights off', onStart: () => lightButton.classList.remove('active') },
            // Last, once everything else has stopped
            { gcode: retract, label: 'Pulling syringes back up', syringeMm: -totalPressed }
        ];

        playButton.classList.add('active');
        resetTiles(); // the first row is placed under the needle before Go!
        let step = 0;
        try {
            const runStopCount = stopCount;
            for (; step < steps.length; step++) {
                // Stop pressed between steps: the board has nothing to cancel, so stop here
                if (stopCount !== runStopCount) throw new Error('Stopped by user');
                setProgress(step, steps.length, steps[step].label);
                steps[step].onStart?.(); // keep the light button in step with the routine
                await sendGCodeOrThrow(steps[step].gcode);
                if (steps[step].syringeMm) noteSyringeMove(steps[step].syringeMm);
            }
            setProgress(steps.length, steps.length, 'Done', 'done');
        } catch (error) {
            console.error('Sequence stopped:', error);
            freezeTiles();
            setProgress(step, steps.length, `Stopped during ${steps[step].label.toLowerCase()}: ${error.message}`, 'failed');
        } finally {
            playButton.classList.remove('active');
            setPrimedMm(0); // finished or stopped: prime again before the next run
            hideProgressTimer = setTimeout(() => { runProgress.style.display = 'none'; }, 5000);
        }
    });

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
    bindSliderPair(document.getElementById('plunger-distance-slider'), document.getElementById('plunger-distance-value'),
        v => { plungerDistance = v; }, () => plungerDistance);

    // Syringe slider: drag anywhere on the drawn syringe. The plunger follows the pointer 1:1 from
    // where you grabbed it; releasing moves the syringes there. The hidden range input just holds the value.
    const syringeSlider = document.getElementById('syringe-slider');
    const syringeVisual = document.getElementById('syringe-visual');
    syringeSlider.max = SYRINGE_TRAVEL_MM;
    let syringeDrag = null;

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

    syringeVisual.addEventListener('pointerdown', (event) => {
        if (playButton.classList.contains('active') || dispensing) {
            console.warn('Syringe slider ignored while a routine is running');
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
        const deltaMm = (event.clientY - syringeDrag.startY) / syringeDrag.travelPx * SYRINGE_TRAVEL_MM;
        syringeSlider.value = syringeDrag.startValue + deltaMm; // the input clamps to 0–max and snaps to its step
        showSyringeReadout(parseFloat(syringeSlider.value));
        fillSyringeSlider(syringeSlider);
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

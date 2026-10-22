const fanSpeed = 255;
const INCH_TO_MM = 25.4;
let feedRate = 500;
let distance = 50;

// TEMPORARY: show the page as if the B/C axis machine is connected, without a board.
// Set back to false once testing with the real machine.
const PREVIEW_BC_MACHINE = true;

// Syringe preset: one press moves B and C down together by this much
const SYRINGE_PRESS_MM = 1.5;
const SYRINGE_PRESS_FEEDRATE = 200;
const SYRINGE_RETRACT_FEEDRATE = 600;
const SYRINGE_WAIT_TIME = 4; // seconds to wait after a syringe press before moving down
const PRE_PLUNGE_PAUSE_S = 0.5; // settle time after a conveyor move, before the next plunge
const SEQUENCE_REPEATS = 12;
// Axis that moves the conveyor in the routine (was Z)
const CONVEYOR_AXIS = 'X';
const SEQUENCE_X_STEP_MM = 14.5;
// Priming: this many presses before the cycles start, then the conveyor (X) moves into place
const PRIMING_PRESSES = 2;
const PRIMING_PAUSE_S = 1; // between priming presses
const PRIMING_X_MOVE_MM = 14.5;
// After the last syringe cycle, keep advancing the conveyor until the tray is through the UV tunnel
const UV_ADVANCE_STEPS = 9;
const UV_ADVANCE_INTERVAL_S = 5; // wait before each advance

let currentDeviceType = null;

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

function move(axis, distance) {
    const gcode = `G1 ${axis}${distance} F${feedRate}`;
    sendGCode(gcode);
}

function emergencyStop() {
    sendGCode('M410');
}

// Always pass seconds. G4 P means milliseconds on Marlin (SKR) but seconds on GRBL,
// so this converts for Marlin. Use it for every routine pause rather than writing G4 by hand.
function dwellGCode(seconds) {
    if (currentDeviceType === 'skr') {
        return `G4 P${Math.round(seconds * 1000)}`;
    }
    if (!currentDeviceType) {
        console.warn(`Board type unknown; assuming GRBL for a ${seconds} s pause (G4 P${seconds})`);
    }
    return `G4 P${seconds}`;
}

// Wait until all queued moves have physically finished
function syncGCode() {
    return currentDeviceType === 'skr' ? 'M400' : 'G4 P0';
}

// "Down" on B/C is positive (matches the ▼ buttons)
function syringePressGCode() {
    return `G1 B${SYRINGE_PRESS_MM} C${SYRINGE_PRESS_MM} F${SYRINGE_PRESS_FEEDRATE}`;
}


// When locked, any B or C arrow moves both axes together in one command
let bcLocked = false;

function moveBC(axis, distance) {
    if (bcLocked) {
        sendGCode(`G1 B${distance} C${distance} F${feedRate}`);
    } else {
        move(axis, distance);
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

    // True if the element (or its label wrapper) isn't hidden for this machine
    function isShown(el) {
        return el.getClientRects().length > 0;
    }
    const pumpButton = document.getElementById('pump-button');
    const danceButton = document.getElementById('dance-button');
    const homeButton = document.getElementById('home-button');
    const recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
    recognition.continuous = true;
    recognition.lang = 'en-US';
    let isManuallyStopped = false;

    function showConnected(hasBcAxes) {
        document.getElementById('connection-status').style.display = 'none';
        document.getElementById('main-container').style.display = 'contents';
        document.querySelectorAll('.bc-axis').forEach(el => {
            el.style.display = hasBcAxes ? '' : 'none';
        });
        // Fan, pump and dance don't apply to the B/C machine
        document.querySelectorAll('.not-bc-axis').forEach(el => {
            el.style.display = hasBcAxes ? 'none' : '';
        });
    }

    // Initialize & check SKR board connection status
    fetch('/initialize') 
    .then(response => response.json())  // parse json regardless of status
    .then(data => {
        // Record the board even in preview mode, so pauses use the right units
        if (data.status === 200) currentDeviceType = data.device_type;

        if (PREVIEW_BC_MACHINE) {
            showConnected(true);
            console.warn('PREVIEW_BC_MACHINE is on: showing B/C controls regardless of connection.', data.message);
        } else if (data.status === 200) {
            showConnected(data.has_bc_axes);
            console.log('Connected:', data.message, 'on', data.port, `(${data.device_type})`);
        } else {
            document.getElementById('connection-status').style.display = 'block';
            document.getElementById('main-container').style.display = 'none';
            console.error('Connection failed:', data.message);  // now shows real error
        }
    })
    .catch(error => {
        console.error('Fetch error:', error);
    });

    document.addEventListener('keydown', (event) => {
        // Let arrow keys edit text/number boxes instead of moving the stage
        if (event.target.tagName === 'INPUT' && event.target.type !== 'range') return;
        switch (event.key) {
            case 'ArrowUp':
                move('Y', distance);
                break;
            case 'ArrowDown':
                move('Y', -distance);
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
    };

    recognition.onend = () => {
        // Restart recognition if it was not manually stopped
        if (!isManuallyStopped) {
            recognition.start();
        } else {
            micButton.classList.remove('listening');
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
                    sendGCode(`G1 Y${distance} F${feedRate}`);
                    break;
                case 'down':
                    sendGCode(`G1 Y-${distance} F${feedRate}`);
                    break;
                case 'left':
                    sendGCode(`G1 X-${distance} F${feedRate}`);
                    break;
                case 'right':
                    sendGCode(`G1 X${distance} F${feedRate}`);
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
                sendGCode(`G1 Y10 F${feedRate}`);
                break;
            case 'move down':
                sendGCode(`G1 Y-10 F${feedRate}`);
                break;
            case 'move left':
                sendGCode(`G1 X-10 F${feedRate}`);
                break;
            case 'move right':
                sendGCode(`G1 X10 F${feedRate}`);
                break;
            case 'basically':
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
                sendGCode(syringePressGCode());
                break;
            case 'nozzle on':
            case 'sprayer on':
            case 'jet on':
            case 'pump on':
            case 'water on':
                pumpButton.classList.add('active');
                sendGCode('M8');
                break;
            case 'nozzle off':
            case 'sprayer off':
            case 'jet off':
            case 'pump off':
            case 'water off':
                pumpButton.classList.remove('active');
                sendGCode('M9');
                break;
            case 'pump pulse':
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

    // UV light strip is on FAN0, so it's switched with the fan commands on fan index 0
    function lightGCode(on) {
        return on ? 'M106 P0 S255' : 'M107 P0';
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

    homeButton.addEventListener('click', function() {
        this.classList.toggle('active');
        sendGCode('G28 X');
    });

    // Sweep buttons are commented out in the HTML; ?. keeps the rest of setup from crashing
    document.getElementById('sweep-10s')?.addEventListener('click', () => runSweep(10));
    document.getElementById('sweep-15s')?.addEventListener('click', () => runSweep(15));
    document.getElementById('sweep-20s')?.addEventListener('click', () => runSweep(20));

    // The sync makes the request return only once the press has physically finished,
    // so the label reads "Dispensing..." for exactly as long as the syringes are moving
    const syringeLabel = document.getElementById('syringe-label');
    let dispensing = false;
    document.getElementById('syringe-button').addEventListener('click', async () => {
        if (dispensing) return;
        dispensing = true;
        syringeLabel.textContent = 'Dispensing...';
        try {
            await sendGCodeOrThrow([syringePressGCode(), syncGCode()].join('\n'));
        } catch (error) {
            console.error('Dispense failed:', error);
        } finally {
            dispensing = false;
            syringeLabel.textContent = 'Dispense';
        }
    });

    // Prime (two presses, conveyor into place), UV on, then press/pause/advance x12, advance x9 more
    // through the UV tunnel, then UV off and retract the syringes.
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
        if (playButton.classList.contains('active')) return;
        clearTimeout(hideProgressTimer);

        // Every cycle follows a conveyor move (priming's or the previous cycle's), and the
        // previous step ended with a sync, so this pause starts once the conveyor has stopped
        const cycle = [
            dwellGCode(PRE_PLUNGE_PAUSE_S),
            syringePressGCode(),
            dwellGCode(SYRINGE_WAIT_TIME),
            `G1 ${CONVEYOR_AXIS}-${SEQUENCE_X_STEP_MM} F${feedRate}`,
            syncGCode()
        ].join('\n');
        const priming = [
            // press, pause, press, ... (no pause after the last press)
            ...Array.from({ length: PRIMING_PRESSES }, (_, i) =>
                i === 0 ? [syringePressGCode()] : [dwellGCode(PRIMING_PAUSE_S), syringePressGCode()]
            ).flat(),
            `G1 ${CONVEYOR_AXIS}-${PRIMING_X_MOVE_MM} F${feedRate}`,
            syncGCode()
        ].join('\n');
        // Wait, then advance one conveyor step (tray moving through the UV tunnel)
        const uvAdvance = [
            dwellGCode(UV_ADVANCE_INTERVAL_S),
            `G1 ${CONVEYOR_AXIS}-${SEQUENCE_X_STEP_MM} F${feedRate}`,
            syncGCode()
        ].join('\n');
        // Includes the priming presses so the syringes end where they started
        const totalPressed = Number((SYRINGE_PRESS_MM * (PRIMING_PRESSES + SEQUENCE_REPEATS)).toFixed(4));
        const retract = [
            lightGCode(false), // lights off before retracting (previous step's sync means the tray is through)
            `G1 B-${totalPressed} C-${totalPressed} F${SYRINGE_RETRACT_FEEDRATE}`,
            syncGCode()
        ].join('\n');

        const steps = [
            { gcode: priming, label: 'Priming' },
            // UV lights go on right after priming, at the start of the first cycle
            ...Array.from({ length: SEQUENCE_REPEATS }, (_, i) => i === 0
                ? {
                    gcode: [lightGCode(true), cycle].join('\n'),
                    label: `Cycle 1 of ${SEQUENCE_REPEATS}`,
                    onStart: () => lightButton.classList.add('active')
                }
                : { gcode: cycle, label: `Cycle ${i + 1} of ${SEQUENCE_REPEATS}` }
            ),
            ...Array.from({ length: UV_ADVANCE_STEPS }, (_, i) => ({
                gcode: uvAdvance,
                label: `UV tunnel: advance ${i + 1} of ${UV_ADVANCE_STEPS}`
            })),
            { gcode: retract, label: 'Pulling syringes back up', onStart: () => lightButton.classList.remove('active') }
        ];

        playButton.classList.add('active');
        let step = 0;
        try {
            for (; step < steps.length; step++) {
                setProgress(step, steps.length, steps[step].label);
                steps[step].onStart?.(); // keep the light button in step with the routine
                await sendGCodeOrThrow(steps[step].gcode);
            }
            setProgress(steps.length, steps.length, 'Done', 'done');
        } catch (error) {
            console.error('Sequence stopped:', error);
            setProgress(step, steps.length, `Stopped during ${steps[step].label.toLowerCase()}: ${error.message}`, 'failed');
        } finally {
            playButton.classList.remove('active');
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

    function updateSpeedSliderBackground() {
        const rawValue = speedSlider.value;
        const value = (rawValue - speedSlider.min) / (speedSlider.max - speedSlider.min) * 100;
        speedSlider.style.background = `linear-gradient(to right,rgb(61, 138, 63) ${value}%, #ddd ${value}%)`;
    }

    // Slider sets speeds in steps of 100 and writes them into the text box
    function onSpeedSliderInput() {
        feedRate = parseFloat(speedSlider.value);
        speedValueInput.value = speedSlider.value;
        updateSpeedSliderBackground();
    }

    // Text box accepts any positive speed (e.g. 250) and moves the slider to the nearest position
    function onSpeedValueInput() {
        const typed = parseFloat(speedValueInput.value);
        if (isNaN(typed) || typed <= 0) return;
        feedRate = typed;
        speedSlider.value = typed; // browser clamps/rounds to the slider's range
        updateSpeedSliderBackground();
    }

    function updateRangeSliderBackground() {
        const rawValue = rangeSlider.value;
        const value = (rawValue - rangeSlider.min) / (rangeSlider.max - rangeSlider.min) * 100;
        rangeSlider.style.background = `linear-gradient(to right,rgb(56, 28, 215) ${value}%, #ddd ${value}%)`;
    }

    // Slider sets whole-mm distances and writes them into the text box
    function onRangeSliderInput() {
        // distance = rangeSlider.value / 100; // if using tens of microns
        distance = parseFloat(rangeSlider.value);
        rangeValueInput.value = rangeSlider.value;
        updateRangeSliderBackground();
    }

    // Text box accepts any positive value (e.g. 0.01) and moves the slider to the nearest position
    function onRangeValueInput() {
        const typed = parseFloat(rangeValueInput.value);
        if (isNaN(typed) || typed <= 0) return;
        distance = typed;
        rangeSlider.value = typed; // browser clamps/rounds to the slider's range
        updateRangeSliderBackground();
    }

    speedSlider.addEventListener('input', onSpeedSliderInput);
    speedValueInput.addEventListener('input', onSpeedValueInput);
    speedValueInput.addEventListener('blur', () => { speedValueInput.value = feedRate; });
    rangeSlider.addEventListener('input', onRangeSliderInput);
    rangeValueInput.addEventListener('input', onRangeValueInput);
    // Snap the box back to the active distance if left empty or invalid
    rangeValueInput.addEventListener('blur', () => { rangeValueInput.value = distance; });

    onSpeedSliderInput();
    onRangeSliderInput();
});

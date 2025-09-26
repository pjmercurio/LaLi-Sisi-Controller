const fanSpeed = 255;
let feedRate = 500;
let distance = 50;

function sendGCode(gcode) {
    fetch('/send_gcode', {
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

function sendGCodeSequence(gcode) {
    fetch('/send_gcode_sequence', {
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

function getMovementDistance() {
    return parseInt(document.getElementById('range-slider').value, 10) || 5;
}

function move(axis, distance) {
    const gcode = `G1 ${axis}${distance} F${feedRate}`;
    sendGCode(gcode);
}

document.addEventListener('DOMContentLoaded', () => {
    const speedSlider = document.getElementById('speed-slider');
    const rangeSlider = document.getElementById('range-slider');
    const micButton = document.getElementById('mic-button');
    const fanButton = document.getElementById('fan-button');
    const recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
    recognition.continuous = true;
    recognition.lang = 'en-US';
    let isManuallyStopped = false;

    // Change color of each arrow button once per second for 10 seconds
    function partyTime() {
        const buttons = document.querySelectorAll('.arrow, bottom-button');
        let count = 0;
        const interval = setInterval(() => {
            if (count >= 40) {
                clearInterval(interval);
                buttons.forEach(button => {
                    button.style.backgroundColor = '';
                });
                return;
            }
            const index = count % buttons.length;
            const button = buttons[index];
            const randomColor = `hsl(${Math.random() * 360}, 100%, 50%)`;
            button.style.backgroundColor = randomColor;
            count++;
        }, 250); 
    }

    // Initialize & check SKR board connection status
    fetch('/initialize') 
    .then(response => {
        if (response.status === 200) {
            document.getElementById('connection-status').style.display = 'none';
            document.getElementById('main-container').style.display = 'contents';
            console.log('SKR board connected successfully.');
        } else {
            const data = response.json();
            document.getElementById('connection-status').style.display = 'block';
            document.getElementById('main-container').style.display = 'none';
            console.error('Error connecting to SKR board:', data.message);
        }
    })
    .catch(error => {
        console.error(error);
    });

    document.addEventListener('keydown', (event) => {
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
        const pattern = /^(?:go|move|slide)\s(up|down|left|right)\s(\d*\.?\d+|to)\s(millimeters?|mm|inch|inches|in|microns?)$/i;
        const match = transcript.match(pattern);

        if (match) {
            const direction = match[1].toLowerCase();
            let distance = parseFloat(match[2] === 'to' ? '2' : match[2]); // Speech recognition may return 'to' instead of the number '2'
            console.log("Parsed distance:", distance);

            // Convert distance to millimeters if necessary
            const unit = match[3] ? match[3].toLowerCase() : 'mm';
            if ("inches".includes(unit)) {
                distance *= 25.4;
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
        const squarePattern = /^draw (a|an) (\d+(?:\.\d+)?)\s*(millimeter|mm)\s*(square|box)$/i;
        const squareMatch = transcript.match(squarePattern);

        if (squareMatch) {
            const sideLength = parseFloat(squareMatch[1]);
            const gcode = `
                G1 Y${sideLength} F${feedRate}
                G4 P2
                G1 X${sideLength} F${feedRate}
                G4 P2
                G1 Y-${sideLength} F${feedRate}
                G4 P2
                G1 X-${sideLength} F${feedRate}
            `;
            sendGCodeSequence(gcode);
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
            case 'party time':
            case 'lets party':
            case 'throw a party':
                partyTime();
                break;
            case 'say no':
                sendGCodeSequence('G1 X15\n G1 X-15\n G1 X15\n G1 X-15');
                break;
            case 'say yes':
                sendGCodeSequence('G1 Y15\n G1 Y-15\n G1 Y15\n G1 Y-15');
                break;
            case 'stop':
                sendGCode('M84');
                break;
            case 'do the cha cha slide':
                sendGCodeSequence(`
                    G1 X15
                    G4 P5
                    G1 X-3
                    G4 P5
                    G1 X-3
                    G4 P750
                    G1 X-15
                    G1 P5
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
                    G1 P5
                    G1 Y3
                    G4 P5
                    G1 Y3
                `);
                break;
            case 'fan on':
                sendGCode(`M106 S${fanSpeed}`);
                fanButton.classList.add('active');
                break;
            case 'fan off':
                fanButton.classList.remove('active');
                sendGCode('M107');
                break;
            case 'run test':
                sendGCodeSequence('G1 X10\n G1 X-10\n G4 P200\n G1 Y10\n G1 Y-10');
                break;
            default:
                console.log('Unrecognized command:', transcript);
        }
    };

    recognition.onerror = (event) => {
        console.error('Speech recognition error detected:', event.error);
    };

    fanButton.addEventListener('click', function() {
        this.classList.toggle('active');
        sendGCode(this.classList.contains('active') ? `M106 S${fanSpeed}` : 'M107');
    });

    function updateSpeedSliderBackground() {
        const rawValue = speedSlider.value;
        const value = (rawValue - speedSlider.min) / (speedSlider.max - speedSlider.min) * 100;
        feedRate = rawValue;
        speedSlider.style.background = `linear-gradient(to right,rgb(61, 138, 63) ${value}%, #ddd ${value}%)`;
        document.getElementById('speed-value').innerText = rawValue;
    }

    function updateRangeSliderBackground() {
        const rawValue = rangeSlider.value;
        const value = (rawValue - rangeSlider.min) / (rangeSlider.max - rangeSlider.min) * 100;
        distance = rawValue / 100;
        rangeSlider.style.background = `linear-gradient(to right,rgb(56, 28, 215) ${value}%, #ddd ${value}%)`;
        document.getElementById('range-value').innerText = rawValue * 10;
    }

    speedSlider.addEventListener('input', updateSpeedSliderBackground);
    rangeSlider.addEventListener('input', updateRangeSliderBackground);

    updateSpeedSliderBackground();
    updateRangeSliderBackground();

    document.getElementById('home-button').addEventListener('click', function() {
        this.classList.toggle('active');
        sendGCode('G28 X');
    });

    document.getElementById('camera-button').addEventListener('click', function() {
        sendGCodeSequence(`
            G1 X10
            G4 P250
            G1 X10
            G4 P250
            G1 X10
            G4 P250
            G1 X10
            G4 P250
            G1 X-40
            G4 P250
            G1 Y10
            G4 P250
            G1 X10
            G4 P250
            G1 X10
            G4 P250
            G1 X10
            G4 P250
            G1 X10
            G4 P250
            G1 X-40
            G4 P250
            G1 Y-10`
        );
    });
});

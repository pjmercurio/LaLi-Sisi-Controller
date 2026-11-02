from flask import Flask, request, jsonify, render_template
import serial
import time
import serial.tools.list_ports as list_ports
import atexit
import socket
import threading
import logging

app = Flask(__name__)

ser = None

def get_local_ip():
    """Find the local IP address of this machine on the network."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))  # Connect to an external server to determine local IP
        local_ip = s.getsockname()[0]
        s.close()
    except Exception:
        local_ip = "Unavailable"
    return local_ip

def wait_for_ok(timeout=30):
    start = time.time()
    while time.time() - start < timeout:
        if stop_requested.is_set():
            raise Exception("Stopped by user")
        response = ser.readline().decode(errors='ignore').strip()
        if not response:
            continue
        print(f"Board: {response}")
        if response.startswith('ok'):
            return True
        if response.startswith('error'):
            raise Exception(f"GRBL error: {response}")
        if response.startswith('ALARM'):
            raise Exception(f"GRBL alarm: {response}")
    raise Exception(f"Timeout after {timeout}s waiting for ok")

@app.route('/')
def home():
    return render_template('index.html')

# The machines the page can control (the segmented control at the top of the page).
# 'firmware' decides how the board is initialized and which G-code dialect the page uses
# (e.g. G4 P is seconds on GRBL but milliseconds on Marlin).
MACHINES = {
    'microscope':  {'name': 'Microscope controller', 'firmware': 'marlin', 'bc_axes': False, 'fan_on_at_start': True},
    'sisi':        {'name': 'SiSi Controller',       'firmware': 'grbl',   'bc_axes': False},
    'lali-marlin': {'name': 'LaLi (Marlin)',         'firmware': 'marlin', 'bc_axes': True},
    'lali-grbl':   {'name': 'LaLi (GRBL)',           'firmware': 'grbl',   'bc_axes': False},  # syringes on Y
}

# Known boards by USB ID, and which machine to pre-select when one is found.
# A machine chosen on the page overrides this.
DEVICE_PROFILES = {
    'grbl': {
        'vid': 0x2341,  # Arduino
        'pid': 0x0043,  # Uno R3
        'name': 'GRBL Arduino',
        'default_machine': 'sisi',
    },
    'skr': {
        'vid': 0x1D50,  # BTT SKR
        'pid': 0x6029,
        'name': 'BTT SKR Board',
        'default_machine': 'microscope',
    },
    'rumba': {
        'vid': 0x2341,  # Arduino
        'pid': 0x0042,  # Mega 2560 R3 (the RUMBA's USB chip reports as a Mega)
        'name': 'RUMBA Board',
        'default_machine': 'lali-marlin',
    }
}
FALLBACK_MACHINE = 'sisi'  # for boards not recognised by USB ID

current_machine = None
current_port = None
stop_requested = threading.Event()
connected_at = None  # time.time() when the current connection was set up
dropped_at = None    # when the watcher saw that connection's USB device disappear

def format_duration(seconds):
    minutes, secs = divmod(int(seconds), 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours}:{minutes:02}:{secs:02}" if hours else f"{minutes}:{secs:02}"

def watch_connection():
    """Every second, check the board's USB device is still there, and log how long the connection
    lasted when it drops. Only asks the OS how many bytes are waiting, so nothing is sent to the board."""
    global dropped_at
    while True:
        time.sleep(1)
        port = ser
        if port is None or dropped_at is not None:
            continue
        try:
            port.in_waiting  # fails with "Device not configured" once the USB device is gone
        except Exception as e:  # a closed port can fail differently, so catch everything: the watcher must keep running
            if port is not ser or not port.is_open:
                continue  # closed on purpose (shutdown or switching machines), not a drop
            dropped_at = time.time()
            print(f"USB connection lost at {time.strftime('%H:%M:%S')}, "
                  f"{format_duration(dropped_at - connected_at)} after connecting ({e})")

def current_firmware():
    return MACHINES[current_machine]['firmware'] if current_machine else None

def detect_device():
    """Find the first board and return (device_type, port)."""
    ports = list_ports.comports()
    for port in ports:
        for device_type, profile in DEVICE_PROFILES.items():
            if port.vid == profile['vid'] and port.pid == profile['pid']:
                print(f"Detected {profile['name']} on {port.device}")
                return device_type, port.device
    
    # Fallback — try name matching
    for port in ports:
        if 'usbmodem' in port.device or 'usbserial' in port.device:
            print(f"Unknown device on {port.device}")
            return None, port.device
    
    return None, None

def initialize_grbl(port, name):
    """Initialize a GRBL board."""
    print(f"Initializing {name} (GRBL) on port {port}...")
    global ser
    ser = serial.Serial(port, 115200, timeout=1)
    
    # Wake GRBL and clear buffer
    ser.write(b"\r\n\r\n")
    time.sleep(2)
    ser.flushInput()
    
    # GRBL init sequence
    ser.write(b"$X\n"); ser.flush(); wait_for_ok()    # clear alarm
    ser.write(b"$20=0\n"); ser.flush(); wait_for_ok() # soft limits off
    ser.write(b"$21=0\n"); ser.flush(); wait_for_ok() # hard limits off
    ser.write(b"G91\n"); ser.flush(); wait_for_ok()   # relative mode
    
    return f"{name} initialized (GRBL)"

def initialize_marlin(port, name, fan_on):
    """Initialize a Marlin board."""
    print(f"Initializing {name} (Marlin) on port {port}...")
    global ser
    ser = serial.Serial(port, 115200, timeout=1)
    
    # Wake Marlin and clear buffer
    time.sleep(2)
    ser.flushInput()
    
    # Marlin init sequence
    if fan_on:
        ser.write(b"M106 S255\n"); ser.flush(); wait_for_ok()  # fan on
    ser.write(b"M84 S0\n"); ser.flush(); wait_for_ok()     # steppers always on
    ser.write(b"M211 S0\n"); ser.flush(); wait_for_ok()    # disable endstops
    ser.write(b"G91\n"); ser.flush(); wait_for_ok()        # relative mode
    
    return f"{name} initialized (Marlin)"

def shutdown_board():
    """Switch outputs off, release the motors and close the port. Safe to call when not connected."""
    global ser, current_machine, current_port, connected_at, dropped_at
    if ser is None:
        return
    try:
        # Skipped if setup failed partway: we don't know which dialect the board speaks
        if current_machine:
            if current_firmware() == 'grbl':
                ser.write(b"M9\n")    # coolant off (SiSi pump)
                ser.write(b"M5\n")    # spindle off (LaLi GRBL UV light)
            else:
                ser.write(b"M107\n")  # FAN0 off (microscope fan / LaLi Marlin UV light)
            ser.flush()
            ser.write(b"M84\n")       # disable all steppers
            ser.flush()
            time.sleep(0.5)           # give commands time to execute
    except Exception as e:
        print(f"Shutdown error: {e}")
    finally:
        try:
            ser.close()
        except Exception:
            pass
        ser = None
        current_machine = None
        current_port = None
        connected_at = None
        dropped_at = None

def connection_info(message, status, detected_machine=None):
    return jsonify({
        "message": message,
        "machine": current_machine,
        "detected_machine": detected_machine,
        "firmware": current_firmware(),
        "port": current_port,
        "has_bc_axes": bool(current_machine and MACHINES[current_machine]['bc_axes']),
        "machines": MACHINES,
        "status": status
    }), status

@app.route('/initialize')
def initialize():
    """Connect to the board, set up for the machine in ?machine= (or the detected default)."""
    global current_machine, current_port, connected_at, dropped_at

    requested = request.args.get('machine')
    if requested and requested not in MACHINES:
        return connection_info(f"Unknown machine '{requested}'", 400)

    # Already set up for this machine: nothing to do
    if ser and (requested is None or requested == current_machine):
        return connection_info(f"Already initialized as {MACHINES[current_machine]['name']}", 200)

    # Switching machines: shut the board down cleanly, then set it up again for the new machine
    if ser:
        print(f"Switching from {current_machine} to {requested}")
        shutdown_board()

    stop_requested.clear()  # an earlier emergency stop shouldn't cancel this setup

    try:
        device_type, port = detect_device()
        if not port:
            return connection_info("No compatible device detected", 500)

        detected_machine = DEVICE_PROFILES[device_type]['default_machine'] if device_type else FALLBACK_MACHINE
        machine = requested or detected_machine
        profile = MACHINES[machine]

        if profile['firmware'] == 'grbl':
            message = initialize_grbl(port, profile['name'])
        else:
            message = initialize_marlin(port, profile['name'], fan_on=profile.get('fan_on_at_start', False))

        current_machine = machine
        current_port = port
        connected_at = time.time()
        dropped_at = None
        print(f"Connected at {time.strftime('%H:%M:%S')} on {port}")
        return connection_info(message, 200, detected_machine)

    except Exception as e:
        # Don't leave a half-initialized connection behind, so the next attempt starts fresh
        shutdown_board()
        return connection_info(f"Failed to initialize: {e}", 500)

@app.route("/stop", methods=["POST"])
def stop():
    """Emergency stop: halts motion, clears queued commands and switches the outputs off.
    Written straight to the port so it doesn't wait behind other commands."""
    if not ser:
        return jsonify({"error": "Serial connection not established"}), 500
    stop_requested.set()  # makes any request waiting on the board give up
    if current_firmware() == 'grbl':
        ser.write(b"!")      # feed hold: stop motion immediately
        ser.flush()
        time.sleep(0.1)
        ser.write(b"\x18")   # soft reset: clear the queued commands; also switches spindle (UV) and coolant off
    else:
        ser.write(b"M410\n") # quickstop
        ser.write(b"M107\n") # FAN0 off (microscope fan / LaLi Marlin UV light); reset already does this on GRBL
    ser.flush()
    print("Emergency stop sent")
    return jsonify({"message": "Stop sent"}), 200

@app.route("/send_gcode", methods=["POST"])
def send_gcode():
    if not ser:
        return jsonify({"error": "Serial connection not established"}), 500

    gcode = request.json.get("gcode")
    if not gcode:
        return jsonify({"error": "No G-code provided"}), 400

    stop_requested.clear()  # a new command after an emergency stop

    try:
        # Always flush buffer and clear alarm before sending
        ser.flushInput()
        ser.flushOutput()
        ser.write(b"$X\n")
        ser.flush()
        time.sleep(0.15)
        ser.flushInput()  # discard the ok from $X

        if current_firmware() == 'grbl':
            # Also needed after an emergency stop, since GRBL's soft reset goes back to absolute mode
            ser.write(b"G91\n")
            ser.flush()
            wait_for_ok()

        for line in gcode.strip().split('\n'):
            line = line.strip()
            if not line or line.startswith(';'):
                continue
            print(f"Sending: {line}")
            ser.write((line + "\n").encode())
            ser.flush()
            wait_for_ok()

        return jsonify({"message": "G-code sent successfully"}), 200

    except Exception as e:
        print(f"Error: {e}")
        # Auto recover
        try:
            ser.flushInput()
            ser.flushOutput()
            ser.write(b"$X\n")
            ser.flush()
            time.sleep(0.5)
            ser.flushInput()
        except Exception as recovery_error:
            print(f"Recovery failed: {recovery_error}")
        return jsonify({"error": str(e)}), 500

@app.route("/connection")
def connection():
    """How long the board has been connected, or how long it lasted before its USB connection dropped.
    The page polls this every second."""
    if connected_at is None:
        return jsonify({"state": "none"})
    end = dropped_at or time.time()
    return jsonify({
        "state": "dropped" if dropped_at else "connected",
        "seconds": round(end - connected_at),
        "duration": format_duration(end - connected_at),
    })

class QuietConnectionPolls(logging.Filter):
    """Keeps the once-a-second /connection polls out of the terminal log."""
    def filter(self, record):
        return '/connection ' not in record.getMessage()

logging.getLogger('werkzeug').addFilter(QuietConnectionPolls())

@app.route("/available-urls")
def get_available_urls():
    """Returns the local network URLs where the Flask app is accessible."""
    local_ip = get_local_ip()
    
    urls = {
        "This Device": "http://localhost:5050",
        "Other Devices on this Network": f"http://{local_ip}:5050" if local_ip != "Unavailable" else "Not Available"
    }
    
    return jsonify(urls)

@app.route("/cleanup")
def cleanup():
    print("Cleaning up before exiting...")
    shutdown_board()
    return jsonify({"message": "Cleanup complete"}), 200

atexit.register(shutdown_board)

if __name__ == "__main__":
    threading.Thread(target=watch_connection, daemon=True).start()
    app.run(host="0.0.0.0", port=5050, debug=False)

from flask import Flask, request, jsonify, render_template
import serial
import time
import serial.tools.list_ports as list_ports
import atexit
import socket

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
        response = ser.readline().decode().strip()
        if not response:
            continue
        print(f"GRBL: {response}")
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

# Known device profiles
DEVICE_PROFILES = {
    'grbl': {
        'vid': 0x2341,  # Arduino
        'pid': 0x0043,  # Uno R3
        'name': 'GRBL Arduino',
        'baudrate': 115200
    },
    'skr': {
        'vid': 0x1D50,  # BTT SKR
        'pid': 0x6029,
        'name': 'BTT SKR Board',
        'baudrate': 115200
    }
}

current_device_type = None
current_port = None

# Ports whose device has the extra B and C axes
MULTI_AXIS_PORT_IDS = ['usbmodem1101']

def has_bc_axes(port):
    return bool(port) and any(port_id in port for port_id in MULTI_AXIS_PORT_IDS)

def detect_device():
    """Detect connected device by VID/PID and return device type."""
    ports = list_ports.comports()
    for port in ports:
        for device_type, profile in DEVICE_PROFILES.items():
            if port.vid == profile['vid'] and port.pid == profile['pid']:
                print(f"Detected {profile['name']} on {port.device}")
                return device_type, port.device
    
    # Fallback — try name matching
    for port in ports:
        if 'usbmodem' in port.device or 'usbserial' in port.device:
            print(f"Unknown device on {port.device} — defaulting to GRBL")
            return 'grbl', port.device
    
    return None, None

def initialize_grbl(port):
    """Initialize GRBL Arduino."""
    print(f"Initializing GRBL board on port {port}...")
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
    
    return "GRBL initialized"

def initialize_skr(port):
    """Initialize BTT SKR / Marlin board."""
    print(f"Initializing SKR board on port {port}...")
    global ser
    ser = serial.Serial(port, 115200, timeout=1)
    
    # Wake Marlin and clear buffer
    time.sleep(2)
    ser.flushInput()
    
    # Marlin init sequence
    ser.write(b"M106 S255\n"); ser.flush(); wait_for_ok()  # fan on
    ser.write(b"M84 S0\n"); ser.flush(); wait_for_ok()     # steppers always on
    ser.write(b"M211 S0\n"); ser.flush(); wait_for_ok()    # disable endstops
    ser.write(b"G91\n"); ser.flush(); wait_for_ok()        # relative mode
    
    return "SKR initialized"

@app.route('/initialize')
def initialize():
    global ser, current_device_type, current_port
    
    if ser:
        return jsonify({
            "message": f"Already initialized as {current_device_type}",
            "device_type": current_device_type,
            "port": current_port,
            "has_bc_axes": has_bc_axes(current_port),
            "status": 200
        }), 200
    
    try:
        device_type, port = detect_device()
        
        if not device_type or not port:
            return jsonify({
                "message": "No compatible device detected",
                "status": 500
            }), 500
        
        if device_type == 'grbl':
            message = initialize_grbl(port)
        elif device_type == 'skr':
            message = initialize_skr(port)
        
        current_device_type = device_type
        current_port = port
        
        return jsonify({
            "message": message,
            "device_type": device_type,
            "port": port,
            "has_bc_axes": has_bc_axes(port),
            "status": 200
        }), 200
        
    except Exception as e:
        return jsonify({
            "message": f"Failed to initialize: {e}",
            "status": 500
        }), 500


@app.route("/send_gcode", methods=["POST"])
def send_gcode():
    if not ser:
        return jsonify({"error": "Serial connection not established"}), 500

    gcode = request.json.get("gcode")
    if not gcode:
        return jsonify({"error": "No G-code provided"}), 400

    try:
        # Always flush buffer and clear alarm before sending
        ser.flushInput()
        ser.flushOutput()
        ser.write(b"$X\n")
        ser.flush()
        time.sleep(0.15)
        ser.flushInput()  # discard the ok from $X

        if current_device_type == 'grbl':
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

    if ser is None:
        return jsonify({"message": "Nothing to clean up"}), 200

    try:
        if current_device_type == 'grbl':
            ser.write(b"M9\n")    # pump off
            ser.flush()
            ser.write(b"M84\n")   # disable all steppers
            ser.flush()
            time.sleep(0.5)       # give commands time to execute
            ser.close()

        elif current_device_type == 'skr':
            ser.write(b"M107\n")  # fan off
            ser.flush()
            ser.write(b"M84\n")   # disable all steppers
            ser.flush()
            time.sleep(0.5)
            ser.close()

        else:
            # Unknown device type — try generic stepper disable
            ser.write(b"M84\n")
            ser.flush()
            time.sleep(0.5)
            ser.close()

        return jsonify({"message": "Cleanup complete"}), 200

    except Exception as e:
        print(f"Cleanup error: {e}")
        try:
            ser.close()  # close even if commands failed
        except:
            pass
        return jsonify({"message": f"Cleanup error: {e}"}), 500

atexit.register(cleanup)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5050, debug=False)

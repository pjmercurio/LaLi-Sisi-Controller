from flask import Flask, request, jsonify, render_template
import serial
import atexit
import glob
import socket

app = Flask(__name__)

BAUDRATE = 115200 # Original baudrate for serial communication (common for SKR boards)
# BAUDRATE = 9600  # Baudrate for serial communication over Bluetooth (HC-05 module)
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

def find_skr_serial_port():
    """Finds the SKR board's serial port automatically."""
    possible_ports = glob.glob('/dev/cu.usbmodem*')  # List all possible SKR board ports

    # return '/dev/cu.DSDTECHHC-05'

    if possible_ports:
        print(f"Detected SKR board on {possible_ports[0]}")
        return possible_ports[0]  # Return the first found port
    else:
        return None

@app.route('/')
def home():
    return render_template('index.html')

@app.route('/initialize')
def initialize():
    global ser
    serial_port = find_skr_serial_port()
    if ser and serial_port:
        return jsonify({"message": "SKR board already initialized", "status": 200}), 200
    try:
        if not serial_port:
            ser = None
            return jsonify({"message": "SKR board not detected", "status": 500}), 500
        ser = serial.Serial(serial_port, BAUDRATE, timeout=1)
        ser.write(b"M106 S255\n")  # Turn on the fan at full speed
        ser.flush()
        ser.write(b"M84 S1\n")  # Disable steppers after 1 second
        ser.flush()
        ser.write(b"M211 S0\n")  # Disable software endstops
        ser.flush()
        ser.write(b"G91\n")  # Set relative positioning
        ser.flush()
        return jsonify({"message": "SKR board initialized successfully!", "status": 200}), 200
    except Exception as e:
        return jsonify({"message": f"Failed to initialize SKR board: {e}", "status": 500}), 500

@app.route("/send_gcode", methods=["POST"])
def send_gcode():
    if not ser:
        return jsonify({"error": "Serial connection not established"}), 500

    gcode = request.json.get("gcode")
    if not gcode:
        return jsonify({"error": "No G-code provided"}), 400

    ser.write((gcode + "\n").encode())  # Send G-code over USB
    ser.flush()
    
    return jsonify({"message": f"G-code '{gcode}' sent"}), 200

@app.route('/send_gcode_sequence', methods=['POST'])
def send_gcode_sequence():
    # Split the G-code sequence into individual commands
    if not ser:
        return jsonify({"error": "Serial connection not established"}), 500

    gcode_sequence = request.json.get("gcode")
    if not gcode_sequence:
        return jsonify({"error": "No G-code provided"}), 400

    for line in gcode_sequence.strip().split('\n'):
        ser.write((line + "\n").encode())
        ser.flush()

    return jsonify({'status': 'success', 'message': 'G-code sequence sent successfully'})

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
    if ser:
        ser.write(b"M107\n") # Turn off the fan
        ser.flush()
        ser.close()

atexit.register(cleanup)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5050, debug=False)

# import serial
# import time

# # Make sure this path matches what you see in `ls /dev/cu.*`
# PORT = '/dev/cu.DSDTECHHC-05'
# BAUD = 38400  # Default AT mode baudrate

# try:
#     ser = serial.Serial(PORT, BAUD, timeout=2)
#     time.sleep(2)  # Let it settle

#     print("Sending: AT")
#     ser.write(b'AT\r\n')
#     time.sleep(0.5)
#     response = ser.read_all()
#     print("Response:", response.decode(errors='ignore'))

#     print("Sending: AT+UART=115200,0,0")
#     ser.write(b'AT+UART=115200,0,0\r\n')
#     time.sleep(0.5)
#     response = ser.read_all()
#     print("Response:", response.decode(errors='ignore'))

#     ser.close()
#     print("Done.")

# except Exception as e:
#     print("Error:", e)

import serial
import time

ser = serial.Serial('/dev/cu.DSDTECHHC-05', 38400, timeout=5)
time.sleep(2)

print("Reading before sending:")
print(ser.read_all().decode(errors='ignore'))

print("Sending: AT")
ser.write(b'AT\r')
time.sleep(1)

print("Reading after sending:")
print(ser.read_all().decode(errors='ignore'))

ser.close()

from flask import Flask, render_template, request, jsonify
import sqlite3
from datetime import datetime
import requests
import threading

app = Flask(__name__)
DB_NAME = "history.db"

# -------------------- ESP32 configuration --------------------
ESP32_IP = "192.168.1.103"   # your ESP32 IP
esp32_connected = False
esp32_last_seen = None

# -------------------- Thread-safe DB --------------------
db_lock = threading.Lock()

def get_db():
    # Allow multi-threaded access safely
    conn = sqlite3.connect(DB_NAME, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with db_lock:
        conn = get_db()
        cur = conn.cursor()
        cur.execute("""
        CREATE TABLE IF NOT EXISTS dispensing_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            start_time TEXT,
            end_time TEXT,
            target_water_ml REAL,
            dispensed_water_ml REAL,
            target_syrup_ml REAL,
            dispensed_syrup_ml REAL,
            status TEXT,
            stop_reason TEXT
        )
        """)
        conn.commit()
        conn.close()

# -------------------- ESP32 heartbeat endpoint --------------------
@app.route('/esp32/heartbeat', methods=['POST'])
def esp32_heartbeat():
    global esp32_connected, esp32_last_seen
    esp32_last_seen = datetime.now()
    if not esp32_connected:
        esp32_connected = True
        print("🟢 ESP32 connected")
    return jsonify({"status": "ok"})

@app.route('/esp32/status')
def esp32_status():
    if esp32_last_seen and (datetime.now() - esp32_last_seen).seconds < 10:
        return jsonify({"status": "connected"}), 200
    else:
        return jsonify({"status": "error", "message": "ESP32 not connected"}), 503

# -------------------- Command ESP32 --------------------
def send_command_to_esp32(endpoint, params=None):
    if not esp32_connected:
        return False, "ESP32 not connected"
    try:
        url = f"http://{ESP32_IP}/{endpoint}"
        response = requests.get(url, params=params, timeout=2)
        if response.status_code == 200:
            return True, "OK"
        else:
            return False, f"ESP32 returned {response.status_code}"
    except Exception as e:
        return False, str(e)

#-------------------- Routes --------------------
@app.route('/')
def home():
    return render_template('index.html')

# -------------------- Dispense --------------------
@app.route('/dispense', methods=['POST'])
def dispense():
    global esp32_connected
    data = request.get_json()
    water = data['water']
    syrup = data['syrup']

    if not esp32_connected:
        return jsonify({"status": "error", "message": "ESP32 not connected"}), 503

    with db_lock:
        conn = get_db()
        cur = conn.cursor()
        cur.execute("""
        INSERT INTO dispensing_log (start_time, target_water_ml, dispensed_water_ml,
                                    target_syrup_ml, dispensed_syrup_ml, status)
        VALUES (?, ?, ?, ?, ?, ?)
        """, (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), water, 0, syrup, 0, "IN_PROGRESS"))
        conn.commit()
        conn.close()

    # Send command to ESP32
    success, message = send_command_to_esp32("start", {"water": water, "syrup": syrup})
    if not success:
        print(f"⚠️ Failed to command ESP32: {message}")

    return jsonify({"status": "started", "esp32_command": message if not success else "sent"})

# -------------------- Emergency Stop --------------------
@app.route('/emergency-stop', methods=['POST'])
def emergency_stop():
    data = request.get_json()
    success, message = send_command_to_esp32("stop")

    with db_lock:
        conn = get_db()
        cur = conn.cursor()
        cur.execute("SELECT id FROM dispensing_log WHERE status='IN_PROGRESS' ORDER BY id DESC LIMIT 1")
        row = cur.fetchone()
        if row:
            cur.execute("""
                UPDATE dispensing_log
                SET end_time=?, status='EMERGENCY_STOP', stop_reason=?
                WHERE id=?
            """, (datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                  data.get("reason", "Emergency stop pressed"), row["id"]))
        conn.commit()
        conn.close()

    return jsonify({"status": "stopped", "esp32_command": "sent" if success else "failed"})

# -------------------- Complete --------------------
@app.route('/complete', methods=['POST'])
def complete_dispense():
    with db_lock:
        conn = get_db()
        cur = conn.cursor()
        cur.execute("SELECT id FROM dispensing_log WHERE status='IN_PROGRESS' ORDER BY id DESC LIMIT 1")
        row = cur.fetchone()
        if row:
            cur.execute("""
                UPDATE dispensing_log
                SET end_time=?, status='COMPLETED'
                WHERE id=?
            """, (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), row["id"]))
        conn.commit()
        conn.close()
    return jsonify({"status": "completed"})

# -------------------- Update Progress --------------------
@app.route('/update-progress', methods=['POST'])
def update_progress():
    data = request.get_json()
    with db_lock:
        conn = get_db()
        cur = conn.cursor()
        cur.execute("SELECT id FROM dispensing_log WHERE status='IN_PROGRESS' ORDER BY id DESC LIMIT 1")
        row = cur.fetchone()
        if row:
            cur.execute("""
                UPDATE dispensing_log
                SET dispensed_water_ml=?, dispensed_syrup_ml=?
                WHERE id=?
            """, (data.get("water_dispensed", 0), data.get("syrup_dispensed", 0), row["id"]))
        conn.commit()
        conn.close()
    return jsonify({"status": "updated"})

# -------------------- History --------------------
@app.route('/history')
def get_history():
    with db_lock:
        conn = get_db()
        cur = conn.cursor()
        cur.execute("SELECT * FROM dispensing_log ORDER BY id DESC")
        rows = cur.fetchall()
        conn.close()

    events = []
    for r in rows:
        r = dict(r)
        if r['status'] == 'IN_PROGRESS':
            message = f"Dispensing in progress | Water: {r['dispensed_water_ml']} ml / {r['target_water_ml']} ml, Syrup: {r['dispensed_syrup_ml']} ml / {r['target_syrup_ml']} ml"
            type_ = "DISPENSE"
        elif r['status'] == 'COMPLETED':
            message = f"Completed | Water: {r['target_water_ml']} ml, Syrup: {r['target_syrup_ml']} ml"
            type_ = "DISPENSE"
        elif r['status'] == 'EMERGENCY_STOP':
            message = f"Emergency Stop | Dispensed Water: {r['dispensed_water_ml']} ml / {r['target_water_ml']} ml, Syrup: {r['dispensed_syrup_ml']} ml / {r['target_syrup_ml']} ml | Reason: {r['stop_reason']}"
            type_ = "EMERGENCY"
        else:
            message = "Unknown status"
            type_ = "INFO"
        events.append({
            "id": r['id'], 
            "timestamp": r['start_time'],
            "type": type_,
            "message": message
        })
    return jsonify(events)

# -------------------- Clear History --------------------
@app.route('/clear-history', methods=['POST'])
def clear_history():
    try:
        with db_lock:
            conn = get_db()
            cur = conn.cursor()
            cur.execute("DELETE FROM dispensing_log")
            conn.commit()
            conn.close()
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

# -------------------- Delete Single History Record --------------------
@app.route('/delete-history/<int:record_id>', methods=['DELETE'])
def delete_history(record_id):
    try:
        with db_lock:
            conn = get_db()
            cur = conn.cursor()
            cur.execute("DELETE FROM dispensing_log WHERE id=?", (record_id,))
            conn.commit()
            conn.close()
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

# -------------------- Main --------------------
if __name__ == '__main__':
    init_db()
    app.run(debug=True, port=5000, host='0.0.0.0', threaded=True)

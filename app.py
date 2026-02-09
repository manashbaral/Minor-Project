from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit
import sqlite3
from datetime import datetime
import requests
from threading import Thread
import time

# -------------------- FLASK APP --------------------
app = Flask(__name__)
app.config['SECRET_KEY'] = 'secret-key'

# ADD SocketIO
socketio = SocketIO(app, cors_allowed_origins="*")

# -------------------- ESP32 CONFIG --------------------
ESP32_IP = "192.168.23.3"  # replace with your ESP32 IP
esp32_connected = False

# -------------------- CONFIGURATION --------------------
DB_NAME = "history.db"

# -------------------- DATABASE HELPERS --------------------
def get_db():
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row
    return conn

# -------------------- DATABASE INITIALIZATION --------------------
def init_db():
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

# -------------------- ROUTES --------------------
@app.route('/')
def home():
    return render_template('index.html')

# -------------------- SOCKET EVENTS --------------------
@socketio.on('connect')
def client_connected():
    emit('esp32_status', {'connected': esp32_connected})

# -------------------- ESP32 MONITORING THREAD --------------------
def monitor_esp32():
    global esp32_connected
    while True:
        try:
            r = requests.get(f"http://{ESP32_IP}/ping", timeout=1)
            if r.status_code == 200:
                if not esp32_connected:
                    esp32_connected = True
                    socketio.emit('esp32_status', {'connected': True}, broadcast=True)
            else:
                if esp32_connected:
                    esp32_connected = False
                    socketio.emit('esp32_status', {'connected': False}, broadcast=True)
        except requests.RequestException:
            if esp32_connected:
                esp32_connected = False
                socketio.emit('esp32_status', {'connected': False}, broadcast=True)
        time.sleep(2)  # check every 2 seconds

# Start monitoring in background thread
Thread(target=monitor_esp32, daemon=True).start()

# -------------------- START DISPENSING --------------------
@app.route('/dispense', methods=['POST'])
def dispense():
    data = request.get_json()

    conn = get_db()
    cur = conn.cursor()

    cur.execute("""
    INSERT INTO dispensing_log (
        start_time,
        target_water_ml,
        dispensed_water_ml,
        target_syrup_ml,
        dispensed_syrup_ml,
        status
    ) VALUES (?, ?, ?, ?, ?, ?)
    """, (
        datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        data['water'],
        0,
        data['syrup'],
        0,
        "IN_PROGRESS"
    ))

    conn.commit()
    conn.close()

    return jsonify({"status": "started"})

# -------------------- UPDATE PROGRESS --------------------
@app.route('/update-progress', methods=['POST'])
def update_progress():
    data = request.get_json()

    conn = get_db()
    cur = conn.cursor()

    cur.execute(
        "SELECT id FROM dispensing_log WHERE status='IN_PROGRESS' ORDER BY id DESC LIMIT 1"
    )
    row = cur.fetchone()

    if row:
        cur.execute("""
            UPDATE dispensing_log
            SET dispensed_water_ml=?, dispensed_syrup_ml=?
            WHERE id=?
        """, (
            data.get("water_dispensed", 0),
            data.get("syrup_dispensed", 0),
            row["id"]
        ))

    conn.commit()
    conn.close()
    return jsonify({"status": "updated"})

# -------------------- EMERGENCY STOP --------------------
@app.route('/emergency-stop', methods=['POST'])
def emergency_stop():
    data = request.get_json()

    conn = get_db()
    cur = conn.cursor()

    cur.execute(
        "SELECT id FROM dispensing_log WHERE status='IN_PROGRESS' ORDER BY id DESC LIMIT 1"
    )
    row = cur.fetchone()

    if row:
        cur.execute("""
            UPDATE dispensing_log
            SET end_time=?, status='EMERGENCY_STOP', stop_reason=?
            WHERE id=?
        """, (
            datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            data.get("reason", "Emergency stop pressed"),
            row["id"]
        ))

    conn.commit()
    conn.close()
    return jsonify({"status": "stopped"})

# -------------------- COMPLETE --------------------
@app.route('/complete', methods=['POST'])
def complete_dispense():
    conn = get_db()
    cur = conn.cursor()

    cur.execute(
        "SELECT id FROM dispensing_log WHERE status='IN_PROGRESS' ORDER BY id DESC LIMIT 1"
    )
    row = cur.fetchone()

    if row:
        cur.execute("""
            UPDATE dispensing_log
            SET end_time=?, status='COMPLETED'
            WHERE id=?
        """, (
            datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            row["id"]
        ))

    conn.commit()
    conn.close()
    return jsonify({"status": "completed"})

# -------------------- FETCH HISTORY --------------------
@app.route('/history')
def get_history():
    conn = get_db()
    cur = conn.cursor()

    cur.execute("SELECT * FROM dispensing_log ORDER BY id DESC")
    rows = cur.fetchall()

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
            "timestamp": r['start_time'],
            "type": type_,
            "message": message
        })

    conn.close()
    return jsonify(events)

# -------------------- MAIN --------------------
if __name__ == '__main__':
    init_db()
    socketio.run(app, debug=True, port=5000)

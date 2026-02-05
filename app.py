from flask import Flask, render_template, request, jsonify
import sqlite3
from datetime import datetime

app = Flask(__name__)

DB_NAME = "history.db"

# -------------------- DATABASE HELPERS --------------------

def get_db():
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row
    return conn

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

    # Safe migration
    cur.execute("PRAGMA table_info(dispensing_log)")
    columns = [col[1] for col in cur.fetchall()]

    def add_column(name, dtype):
        if name not in columns:
            cur.execute(f"ALTER TABLE dispensing_log ADD COLUMN {name} {dtype}")

    for col, dtype in [
        ("start_time", "TEXT"),
        ("end_time", "TEXT"),
        ("target_water_ml", "REAL"),
        ("dispensed_water_ml", "REAL"),
        ("target_syrup_ml", "REAL"),
        ("dispensed_syrup_ml", "REAL"),
        ("status", "TEXT"),
        ("stop_reason", "TEXT")
    ]:
        add_column(col, dtype)

    conn.commit()
    conn.close()


# -------------------- ROUTES --------------------

@app.route('/')
def home():
    return render_template('index.html')


# -------- START DISPENSING --------
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

    return jsonify({"status": "started", "message": "Dispensing started"})


# -------- UPDATE PROGRESS --------
@app.route('/update-progress', methods=['POST'])
def update_progress():
    data = request.get_json()

    conn = get_db()
    cur = conn.cursor()

    # Fetch last IN_PROGRESS dispense
    cur.execute("SELECT id FROM dispensing_log WHERE status='IN_PROGRESS' ORDER BY id DESC LIMIT 1")
    row = cur.fetchone()
    if row:
        dispense_id = row["id"]
        cur.execute("""
            UPDATE dispensing_log
            SET dispensed_water_ml = ?, dispensed_syrup_ml = ?
            WHERE id = ?
        """, (
            data.get("water_dispensed", 0),
            data.get("syrup_dispensed", 0),
            dispense_id
        ))

    conn.commit()
    conn.close()
    return jsonify({"status": "updated"})


# -------- EMERGENCY STOP --------
@app.route('/emergency-stop', methods=['POST'])
def emergency_stop():
    data = request.get_json()

    conn = get_db()
    cur = conn.cursor()

    cur.execute("SELECT id FROM dispensing_log WHERE status='IN_PROGRESS' ORDER BY id DESC LIMIT 1")
    row = cur.fetchone()
    if row:
        dispense_id = row["id"]
        cur.execute("""
            UPDATE dispensing_log
            SET end_time = ?, status='EMERGENCY_STOP', stop_reason=?
            WHERE id = ?
        """, (
            datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            data.get("reason", "Emergency stop pressed"),
            dispense_id
        ))

    conn.commit()
    conn.close()
    return jsonify({"status": "stopped", "message": "Emergency stop recorded"})


# -------- NORMAL COMPLETION --------
@app.route('/complete', methods=['POST'])
def complete_dispense():
    conn = get_db()
    cur = conn.cursor()

    cur.execute("SELECT id FROM dispensing_log WHERE status='IN_PROGRESS' ORDER BY id DESC LIMIT 1")
    row = cur.fetchone()
    if row:
        dispense_id = row["id"]
        cur.execute("""
            UPDATE dispensing_log
            SET end_time = ?, status='COMPLETED'
            WHERE id = ?
        """, (
            datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            dispense_id
        ))

    conn.commit()
    conn.close()
    return jsonify({"status": "completed"})


# -------- FETCH HISTORY --------
@app.route('/history')
def get_history():
    conn = get_db()
    cur = conn.cursor()

    cur.execute("""
        SELECT *
        FROM dispensing_log
        ORDER BY id DESC
    """)
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
    app.run(debug=True, port=5000)

from flask import Flask, render_template, request, jsonify, session, redirect, url_for
from werkzeug.security import generate_password_hash, check_password_hash
import sqlite3
from datetime import datetime
from functools import wraps
import requests
import threading
import os

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "lab-secret-change-in-production")
DB_NAME = "history.db"

# -------------------- ESP32 configuration --------------------
ESP32_IP = "192.168.76.3"
esp32_connected = False
esp32_last_seen = None

# -------------------- Thread-safe DB --------------------
db_lock = threading.Lock()

def get_db():
    conn = sqlite3.connect(DB_NAME, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with db_lock:
        conn = get_db()
        cur = conn.cursor()

        # Dispensing log table
        cur.execute("""
        CREATE TABLE IF NOT EXISTS dispensing_log (
            id                    INTEGER PRIMARY KEY AUTOINCREMENT,
            start_time            TEXT,
            end_time              TEXT,
            target_reagent_a_ml   REAL,
            dispensed_reagent_a_ml REAL,
            target_reagent_b_ml   REAL,
            dispensed_reagent_b_ml REAL,
            status                TEXT,
            stop_reason           TEXT,
            operator              TEXT DEFAULT 'unknown'
        )
        """)

        # Users table
        cur.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            username     TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role         TEXT NOT NULL DEFAULT 'operator',
            created_at   TEXT
        )
        """)

        # Create default admin if no users exist
        cur.execute("SELECT COUNT(*) as cnt FROM users")
        if cur.fetchone()["cnt"] == 0:
            cur.execute("""
                INSERT INTO users (username, password_hash, role, created_at)
                VALUES (?, ?, ?, ?)
            """, (
                "admin",
                generate_password_hash("admin123"),
                "admin",
                datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            ))
            print("✅ Default admin created — username: admin | password: admin123")

        conn.commit()
        conn.close()

# -------------------- Auth Decorators --------------------
def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if "user_id" not in session:
            if request.is_json:
                return jsonify({"status": "error", "message": "Session expired"}), 401
            return redirect(url_for("login"))
        return f(*args, **kwargs)
    return decorated

def admin_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if "user_id" not in session:
            if request.is_json:
                return jsonify({"status": "error", "message": "Session expired"}), 401
            return redirect(url_for("login"))
        if session.get("role") != "admin":
            if request.is_json:
                return jsonify({"status": "error", "message": "Admin access required"}), 403
            return redirect(url_for("home"))
        return f(*args, **kwargs)
    return decorated

# -------------------- Auth Routes --------------------
@app.route("/login", methods=["GET", "POST"])
def login():
    if "user_id" in session:
        return redirect(url_for("home"))

    if request.method == "POST":
        data = request.get_json()
        username = data.get("username", "").strip()
        password = data.get("password", "")

        with db_lock:
            conn = get_db()
            cur = conn.cursor()
            cur.execute("SELECT * FROM users WHERE username = ?", (username,))
            user = cur.fetchone()
            conn.close()

        if user and check_password_hash(user["password_hash"], password):
            session["user_id"]  = user["id"]
            session["username"] = user["username"]
            session["role"]     = user["role"]
            return jsonify({
                "status":   "success",
                "username": user["username"],
                "role":     user["role"]
            })
        else:
            return jsonify({"status": "error", "message": "Invalid username or password"}), 401

    return render_template("login.html")

@app.route("/logout", methods=["POST"])
@login_required
def logout():
    session.clear()
    return jsonify({"status": "success"})

@app.route("/session-info")
@login_required
def session_info():
    return jsonify({
        "username": session.get("username"),
        "role":     session.get("role")
    })

# -------------------- User Management (Admin only) --------------------
@app.route("/users", methods=["GET"])
@admin_required
def get_users():
    with db_lock:
        conn = get_db()
        cur = conn.cursor()
        cur.execute("SELECT id, username, role, created_at FROM users ORDER BY id")
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()
    return jsonify(rows)

@app.route("/users", methods=["POST"])
@admin_required
def create_user():
    data = request.get_json()
    username = data.get("username", "").strip()
    password = data.get("password", "")
    role     = data.get("role", "operator")

    if not username or not password:
        return jsonify({"status": "error", "message": "Username and password required"}), 400
    if role not in ("admin", "operator"):
        return jsonify({"status": "error", "message": "Invalid role"}), 400

    try:
        with db_lock:
            conn = get_db()
            cur = conn.cursor()
            cur.execute("""
                INSERT INTO users (username, password_hash, role, created_at)
                VALUES (?, ?, ?, ?)
            """, (
                username,
                generate_password_hash(password),
                role,
                datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            ))
            conn.commit()
            conn.close()
        return jsonify({"status": "success", "message": f"User '{username}' created."})
    except sqlite3.IntegrityError:
        return jsonify({"status": "error", "message": "Username already exists"}), 409

@app.route("/users/<int:user_id>", methods=["DELETE"])
@admin_required
def delete_user(user_id):
    # Prevent admin from deleting themselves
    if user_id == session.get("user_id"):
        return jsonify({"status": "error", "message": "Cannot delete your own account"}), 400
    try:
        with db_lock:
            conn = get_db()
            cur = conn.cursor()
            cur.execute("DELETE FROM users WHERE id = ?", (user_id,))
            conn.commit()
            conn.close()
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

# -------------------- ESP32 Heartbeat --------------------
@app.route("/esp32/heartbeat", methods=["POST"])
def esp32_heartbeat():
    global esp32_connected, esp32_last_seen
    esp32_last_seen = datetime.now()
    if not esp32_connected:
        esp32_connected = True
        print("🟢 ESP32 connected")
    return jsonify({"status": "ok"})

@app.route("/esp32/status")
@login_required
def esp32_status():
    if esp32_last_seen and (datetime.now() - esp32_last_seen).seconds < 10:
        return jsonify({"status": "connected"}), 200
    return jsonify({"status": "error", "message": "Controller not connected"}), 503

# -------------------- Command ESP32 --------------------
def send_command_to_esp32(endpoint, params=None):
    if not esp32_connected:
        return False, "Controller not connected"
    try:
        url = f"http://{ESP32_IP}/{endpoint}"
        response = requests.get(url, params=params, timeout=2)
        return (True, "OK") if response.status_code == 200 else (False, f"ESP32 returned {response.status_code}")
    except Exception as e:
        return False, str(e)

# -------------------- Main Route --------------------
@app.route("/")
@login_required
def home():
    return render_template("index.html",
                           username=session.get("username"),
                           role=session.get("role"))

# -------------------- Dispense --------------------
@app.route("/dispense", methods=["POST"])
@login_required
def dispense():
    data      = request.get_json()
    reagent_a = data.get("reagent_a", 0)
    reagent_b = data.get("reagent_b", 0)
    operator  = session.get("username", "unknown")

    if not esp32_connected:
        return jsonify({"status": "error", "message": "Controller not connected"}), 503

    success, message = send_command_to_esp32("start", {
        "reagent_a": reagent_a,
        "reagent_b": reagent_b
    })

    if not success:
        return jsonify({"status": "error", "message": message}), 500

    with db_lock:
        conn = get_db()
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO dispensing_log (
                start_time,
                target_reagent_a_ml, dispensed_reagent_a_ml,
                target_reagent_b_ml, dispensed_reagent_b_ml,
                status, operator
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (
            datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            reagent_a, 0, reagent_b, 0,
            "IN_PROGRESS", operator
        ))
        conn.commit()
        conn.close()

    return jsonify({"status": "started"})

# -------------------- Emergency Stop --------------------
@app.route("/emergency-stop", methods=["POST"])
@login_required
def emergency_stop():
    data     = request.get_json()
    operator = session.get("username", "unknown")
    success, _ = send_command_to_esp32("stop")

    with db_lock:
        conn = get_db()
        cur = conn.cursor()
        cur.execute("SELECT id FROM dispensing_log WHERE status='IN_PROGRESS' ORDER BY id DESC LIMIT 1")
        row = cur.fetchone()
        if row:
            cur.execute("""
                UPDATE dispensing_log
                SET end_time=?, status='EMERGENCY_STOP', stop_reason=?, operator=?
                WHERE id=?
            """, (
                datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                data.get("reason", "Emergency stop triggered"),
                operator,
                row["id"]
            ))
        conn.commit()
        conn.close()

    return jsonify({"status": "stopped", "esp32_command": "sent" if success else "failed"})

# -------------------- Complete --------------------
@app.route("/complete", methods=["POST"])
@login_required
def complete_dispense():
    success, message = send_command_to_esp32("complete")
    if not success:
        return jsonify({"status": "error", "message": message}), 500

    with db_lock:
        conn = get_db()
        cur = conn.cursor()
        cur.execute("SELECT id FROM dispensing_log WHERE status='IN_PROGRESS' ORDER BY id DESC LIMIT 1")
        row = cur.fetchone()
        if row:
            cur.execute("""
                UPDATE dispensing_log SET end_time=?, status='COMPLETED' WHERE id=?
            """, (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), row["id"]))
        conn.commit()
        conn.close()

    return jsonify({"status": "completed"})

# -------------------- Update Progress --------------------
@app.route("/update-progress", methods=["POST"])
@login_required
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
                SET dispensed_reagent_a_ml=?, dispensed_reagent_b_ml=?
                WHERE id=?
            """, (data.get("reagent_a_dispensed", 0), data.get("reagent_b_dispensed", 0), row["id"]))
        conn.commit()
        conn.close()
    return jsonify({"status": "updated"})

# -------------------- History --------------------
@app.route("/history")
@login_required
def get_history():
    with db_lock:
        conn = get_db()
        cur = conn.cursor()
        cur.execute("SELECT * FROM dispensing_log ORDER BY id DESC")
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()

    events = []
    for r in rows:
        if r["status"] == "IN_PROGRESS":
            message = (f"In Progress | "
                       f"Reagent A: {r['dispensed_reagent_a_ml']} / {r['target_reagent_a_ml']} ml, "
                       f"Reagent B: {r['dispensed_reagent_b_ml']} / {r['target_reagent_b_ml']} ml")
            type_ = "DISPENSE"
        elif r["status"] == "COMPLETED":
            message = (f"Completed | "
                       f"Reagent A: {r['target_reagent_a_ml']} ml, "
                       f"Reagent B: {r['target_reagent_b_ml']} ml")
            type_ = "DISPENSE"
        elif r["status"] == "EMERGENCY_STOP":
            message = (f"Emergency Stop | "
                       f"Reagent A: {r['dispensed_reagent_a_ml']} / {r['target_reagent_a_ml']} ml, "
                       f"Reagent B: {r['dispensed_reagent_b_ml']} / {r['target_reagent_b_ml']} ml | "
                       f"Reason: {r['stop_reason']}")
            type_ = "EMERGENCY"
        else:
            message = "Unknown status"
            type_ = "INFO"

        events.append({
            "id":        r["id"],
            "timestamp": r["start_time"],
            "operator":  r.get("operator", "unknown"),
            "type":      type_,
            "message":   message
        })

    return jsonify(events)

# -------------------- Clear History (Admin only) --------------------
@app.route("/clear-history", methods=["POST"])
@admin_required
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

# -------------------- Delete Single Record (Admin only) --------------------
@app.route("/delete-history/<int:record_id>", methods=["DELETE"])
@admin_required
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
if __name__ == "__main__":
    init_db()
    app.run(debug=True, port=5000, host="0.0.0.0", threaded=True)
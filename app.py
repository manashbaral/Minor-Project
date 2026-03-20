from flask import Flask, render_template, request, jsonify, session, redirect, url_for
from werkzeug.security import generate_password_hash, check_password_hash
import sqlite3
from datetime import datetime
from functools import wraps
import requests
import threading
import os
import socket

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "lab-secret-change-in-production")

# Always store DB next to app.py regardless of where Flask is launched from
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_NAME  = os.path.join(BASE_DIR, "history.db")
print(f"Database path: {DB_NAME}")

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
        cur  = conn.cursor()

        # ---------- dispensing_log ----------
        cur.execute("""
        CREATE TABLE IF NOT EXISTS dispensing_log (
            id                     INTEGER PRIMARY KEY AUTOINCREMENT,
            start_time             TEXT,
            end_time               TEXT,
            target_reagent_a_ml    REAL,
            dispensed_reagent_a_ml REAL,
            target_reagent_b_ml    REAL,
            dispensed_reagent_b_ml REAL,
            status                 TEXT,
            stop_reason            TEXT,
            operator               TEXT DEFAULT 'unknown'
        )
        """)

        # Auto-migrate: add 'operator' column if missing
        cur.execute("PRAGMA table_info(dispensing_log)")
        existing_cols = [row["name"] for row in cur.fetchall()]
        if "operator" not in existing_cols:
            cur.execute("ALTER TABLE dispensing_log ADD COLUMN operator TEXT DEFAULT 'unknown'")
            print("Migrated dispensing_log: added 'operator' column.")

        # ---------- users ----------
        cur.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            username      TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role          TEXT NOT NULL DEFAULT 'operator',
            created_at    TEXT
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
            print("Default admin created — username: admin | password: admin123")

        # Clean up stale IN_PROGRESS rows from previous crashes
        cur.execute("DELETE FROM dispensing_log WHERE status = 'IN_PROGRESS'")
        if cur.rowcount:
            print(f"Cleaned up {cur.rowcount} stale IN_PROGRESS record(s).")

        # Single commit and close — everything done in one connection
        conn.commit()
        conn.close()
        print("Database initialised successfully.")

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
        data          = request.get_json()
        username      = data.get("username", "").strip()
        password      = data.get("password", "")
        selected_role = data.get("selected_role", None)

        with db_lock:
            conn = get_db()
            cur = conn.cursor()
            cur.execute("SELECT * FROM users WHERE username = ?", (username,))
            user = cur.fetchone()
            conn.close()

        if user and check_password_hash(user["password_hash"], password):
            # Validate selected role matches actual role
            if selected_role and selected_role != user["role"]:
                return jsonify({
                    "status":  "error",
                    "message": f"Access denied. '{username}' is not an {selected_role}."
                }), 401

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

# -------------------- In-memory dispense session --------------------
# Holds current job state between /dispense calls — DB written only on complete/stop
# This prevents double-logging when two pumps are called sequentially
dispense_session = {
    "active":      False,
    "operator":    None,
    "start_time":  None,
    "reagent_a":   0.0,
    "reagent_b":   0.0,
    "dispensed_a": 0.0,
    "dispensed_b": 0.0,
}
session_lock = threading.Lock()

# -------------------- Dispense --------------------
@app.route("/dispense", methods=["POST"])
@login_required
def dispense():
    try:
        data      = request.get_json(force=True) or {}
        reagent_a = float(data.get("reagent_a", 0))
        reagent_b = float(data.get("reagent_b", 0))
        operator  = session.get("username", "unknown")

        if not esp32_connected:
            return jsonify({"status": "error", "message": "Controller not connected"}), 503

        success, message = send_command_to_esp32("start", {
            "reagent_a": reagent_a,
            "reagent_b": reagent_b
        })
        if not success:
            return jsonify({"status": "error", "message": message}), 500

        with session_lock:
            if not dispense_session["active"]:
                # First pump call — open a new session
                dispense_session["active"]      = True
                dispense_session["operator"]    = operator
                dispense_session["start_time"]  = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                dispense_session["reagent_a"]   = reagent_a
                dispense_session["reagent_b"]   = reagent_b
                dispense_session["dispensed_a"] = 0.0
                dispense_session["dispensed_b"] = 0.0
            else:
                # Second pump call — accumulate into same session
                dispense_session["reagent_a"] += reagent_a
                dispense_session["reagent_b"] += reagent_b

        return jsonify({"status": "started"})

    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

# -------------------- Emergency Stop --------------------
@app.route("/emergency-stop", methods=["POST"])
@login_required
def emergency_stop():
    data     = request.get_json(force=True) or {}
    operator = session.get("username", "unknown")
    success, _ = send_command_to_esp32("stop")

    # Step 1 — snapshot session state and mark inactive under session_lock only
    snapshot = None
    with session_lock:
        if dispense_session["active"]:
            snapshot = {
                "start_time":  dispense_session["start_time"],
                "reagent_a":   dispense_session["reagent_a"],
                "dispensed_a": dispense_session["dispensed_a"],
                "reagent_b":   dispense_session["reagent_b"],
                "dispensed_b": dispense_session["dispensed_b"],
                "operator":    dispense_session["operator"] or operator,
            }
            dispense_session["active"] = False  # mark inactive immediately

    # Step 2 — write to DB under db_lock only (session_lock already released)
    if snapshot:
        with db_lock:
            conn = get_db()
            cur  = conn.cursor()
            cur.execute("""
                INSERT INTO dispensing_log (
                    start_time, end_time,
                    target_reagent_a_ml,   dispensed_reagent_a_ml,
                    target_reagent_b_ml,   dispensed_reagent_b_ml,
                    status, stop_reason, operator
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                snapshot["start_time"],
                datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                snapshot["reagent_a"],
                snapshot["dispensed_a"],
                snapshot["reagent_b"],
                snapshot["dispensed_b"],
                "EMERGENCY_STOP",
                data.get("reason", "Emergency stop triggered"),
                snapshot["operator"]
            ))
            conn.commit()
            conn.close()

    return jsonify({"status": "stopped", "esp32_command": "sent" if success else "failed"})

# -------------------- Complete --------------------
@app.route("/complete", methods=["POST"])
@login_required
def complete_dispense():
    send_command_to_esp32("complete")  # best-effort fallback

    # Step 1 — snapshot and mark inactive under session_lock only
    snapshot = None
    with session_lock:
        if dispense_session["active"]:
            snapshot = {
                "start_time":  dispense_session["start_time"],
                "reagent_a":   dispense_session["reagent_a"],
                "dispensed_a": dispense_session["dispensed_a"],
                "reagent_b":   dispense_session["reagent_b"],
                "dispensed_b": dispense_session["dispensed_b"],
                "operator":    dispense_session["operator"],
            }
            dispense_session["active"] = False  # mark inactive immediately

    # Step 2 — write to DB under db_lock only (session_lock already released)
    if snapshot:
        with db_lock:
            conn = get_db()
            cur  = conn.cursor()
            cur.execute("""
                INSERT INTO dispensing_log (
                    start_time, end_time,
                    target_reagent_a_ml,   dispensed_reagent_a_ml,
                    target_reagent_b_ml,   dispensed_reagent_b_ml,
                    status, operator
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                snapshot["start_time"],
                datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                snapshot["reagent_a"],
                snapshot["dispensed_a"],
                snapshot["reagent_b"],
                snapshot["dispensed_b"],
                "COMPLETED",
                snapshot["operator"]
            ))
            conn.commit()
            conn.close()

    return jsonify({"status": "completed"})

# -------------------- Progress (polled by frontend) --------------------
# Frontend calls this every 500ms to get real dispensed amounts from ESP32
@app.route("/progress")
@login_required
def get_progress():
    with session_lock:
        if not dispense_session["active"]:
            return jsonify({
                "active":        False,
                "dispensed_a":   dispense_session["dispensed_a"],
                "dispensed_b":   dispense_session["dispensed_b"],
                "target_a":      dispense_session["reagent_a"],
                "target_b":      dispense_session["reagent_b"],
                "pct_a":         100.0,
                "pct_b":         100.0,
            })

        target_a    = dispense_session["reagent_a"]
        target_b    = dispense_session["reagent_b"]
        dispensed_a = dispense_session["dispensed_a"]
        dispensed_b = dispense_session["dispensed_b"]

        pct_a = round((dispensed_a / target_a * 100), 1) if target_a > 0 else 100.0
        pct_b = round((dispensed_b / target_b * 100), 1) if target_b > 0 else 100.0

        # Cap at 100%
        pct_a = min(pct_a, 100.0)
        pct_b = min(pct_b, 100.0)

        return jsonify({
            "active":      True,
            "dispensed_a": round(dispensed_a, 2),
            "dispensed_b": round(dispensed_b, 2),
            "target_a":    target_a,
            "target_b":    target_b,
            "pct_a":       pct_a,
            "pct_b":       pct_b,
        })

# -------------------- Update Progress --------------------
@app.route("/update-progress", methods=["POST"])
@login_required
def update_progress():
    # Updates in-memory amounts from ESP32 flow sensor (future)
    # No DB write here — DB is only written on complete or emergency stop
    data = request.get_json(force=True) or {}
    with session_lock:
        if dispense_session["active"]:
            dispense_session["dispensed_a"] = float(data.get("reagent_a_dispensed", 0))
            dispense_session["dispensed_b"] = float(data.get("reagent_b_dispensed", 0))
    return jsonify({"status": "updated"})

# -------------------- History --------------------
@app.route("/history")
@login_required
def get_history():
    role     = session.get("role")
    username = session.get("username")

    with db_lock:
        conn = get_db()
        cur  = conn.cursor()
        if role == "admin":
            cur.execute("""
                SELECT * FROM dispensing_log
                WHERE status IN ('COMPLETED','EMERGENCY_STOP')
                ORDER BY id DESC
            """)
        else:
            # Operators only see their own logs
            cur.execute("""
                SELECT * FROM dispensing_log
                WHERE status IN ('COMPLETED','EMERGENCY_STOP')
                AND operator = ?
                ORDER BY id DESC
            """, (username,))
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()

    events = []
    for r in rows:
        if r["status"] == "COMPLETED":
            message = (
                f"Reagent A: {r['dispensed_reagent_a_ml']} ml, "
                f"Reagent B: {r['dispensed_reagent_b_ml']} ml | "
                f"Total: {(r['dispensed_reagent_a_ml'] or 0) + (r['dispensed_reagent_b_ml'] or 0):.1f} ml"
            )
            type_ = "DISPENSE"
        elif r["status"] == "EMERGENCY_STOP":
            message = (
                f"Stopped at — "
                f"Reagent A: {r['dispensed_reagent_a_ml']} / {r['target_reagent_a_ml']} ml, "
                f"Reagent B: {r['dispensed_reagent_b_ml']} / {r['target_reagent_b_ml']} ml | "
                f"Reason: {r['stop_reason']}"
            )
            type_ = "EMERGENCY"
        else:
            continue

        events.append({
            "id":        r["id"],
            "timestamp": r["start_time"],
            "end_time":  r.get("end_time", ""),
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

# -------------------- Global JSON Error Handlers --------------------
# Ensures Flask NEVER returns an HTML error page — always JSON.
# This prevents "Unexpected token '<'" errors in the frontend.
@app.errorhandler(400)
def bad_request(e):
    return jsonify({"status": "error", "message": str(e)}), 400

@app.errorhandler(401)
def unauthorized(e):
    return jsonify({"status": "error", "message": "Session expired"}), 401

@app.errorhandler(403)
def forbidden(e):
    return jsonify({"status": "error", "message": "Access denied"}), 403

@app.errorhandler(404)
def not_found(e):
    return jsonify({"status": "error", "message": "Endpoint not found"}), 404

@app.errorhandler(500)
def internal_error(e):
    return jsonify({"status": "error", "message": f"Internal server error: {str(e)}"}), 500

@app.errorhandler(Exception)
def handle_exception(e):
    return jsonify({"status": "error", "message": str(e)}), 500

# -------------------- Main --------------------
if __name__ == "__main__":
    init_db()
    try:
        local_ip = socket.gethostbyname(socket.gethostname())
    except Exception:
        local_ip = "127.0.0.1"
    print(f"Local:   http://localhost:8000")
    print(f"Network: http://{local_ip}:8000")
    app.run(debug=True, port=8000, host="0.0.0.0", threaded=True)
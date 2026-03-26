from flask import Flask, render_template, request, jsonify, session, redirect, url_for
from werkzeug.security import generate_password_hash, check_password_hash
import sqlite3
from datetime import datetime
from functools import wraps
import requests
import threading
import os
import socket
import json

ESP32_SECRET = "amrds-device-key-2024"

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "lab-secret-change-in-production")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_NAME  = os.path.join(BASE_DIR, "history.db")
print(f"Database path: {DB_NAME}")

ESP32_IP        = "192.168.118.3"
esp32_connected = False
esp32_last_seen = None
db_lock         = threading.Lock()


def get_db():
    conn = sqlite3.connect(DB_NAME, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with db_lock:
        conn = get_db()
        cur  = conn.cursor()

        # dispensing_log — add note column if missing
        cur.execute("""CREATE TABLE IF NOT EXISTS dispensing_log (
            id                     INTEGER PRIMARY KEY AUTOINCREMENT,
            start_time             TEXT,
            end_time               TEXT,
            target_reagent_a_ml    REAL,
            dispensed_reagent_a_ml REAL,
            target_reagent_b_ml    REAL,
            dispensed_reagent_b_ml REAL,
            status                 TEXT,
            stop_reason            TEXT,
            operator               TEXT DEFAULT 'unknown',
            note                   TEXT DEFAULT ''
        )""")
        cur.execute("PRAGMA table_info(dispensing_log)")
        cols = [r["name"] for r in cur.fetchall()]
        if "operator" not in cols:
            cur.execute("ALTER TABLE dispensing_log ADD COLUMN operator TEXT DEFAULT 'unknown'")
        if "note" not in cols:
            cur.execute("ALTER TABLE dispensing_log ADD COLUMN note TEXT DEFAULT ''")

        # users
        cur.execute("""CREATE TABLE IF NOT EXISTS users (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            username      TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role          TEXT NOT NULL DEFAULT 'operator',
            created_at    TEXT
        )""")
        cur.execute("SELECT COUNT(*) as cnt FROM users")
        if cur.fetchone()["cnt"] == 0:
            cur.execute("INSERT INTO users (username,password_hash,role,created_at) VALUES (?,?,?,?)",
                ("admin", generate_password_hash("admin123"), "admin",
                 datetime.now().strftime("%Y-%m-%d %H:%M:%S")))
            print("Default admin created — username: admin | password: admin123")

        # settings
        cur.execute("""CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )""")
        for k, v in [("reagent_a_name", "Reagent A"), ("reagent_b_name", "Reagent B")]:
            cur.execute("INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)", (k, v))

        # protocols
        cur.execute("""CREATE TABLE IF NOT EXISTS protocols (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT NOT NULL,
            steps_json TEXT NOT NULL,
            created_by TEXT NOT NULL,
            created_at TEXT NOT NULL,
            is_global  INTEGER NOT NULL DEFAULT 0
        )""")

        # inventory
        cur.execute("""CREATE TABLE IF NOT EXISTS inventory (
            reagent           TEXT PRIMARY KEY,
            capacity_ml       REAL NOT NULL DEFAULT 1000.0,
            current_ml        REAL NOT NULL DEFAULT 1000.0,
            warn_threshold_ml REAL NOT NULL DEFAULT 100.0,
            updated_at        TEXT NOT NULL
        )""")
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        for r in ("A", "B"):
            cur.execute(
                "INSERT OR IGNORE INTO inventory (reagent,capacity_ml,current_ml,warn_threshold_ml,updated_at) VALUES (?,?,?,?,?)",
                (r, 1000.0, 1000.0, 100.0, now))

        cur.execute("DELETE FROM dispensing_log WHERE status='IN_PROGRESS'")
        conn.commit()
        conn.close()
        print("Database initialised successfully.")


# ── Decorators ────────────────────────────────────────────────

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


def esp32_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if request.headers.get("X-Device-Key") != ESP32_SECRET:
            return jsonify({"status": "error", "message": "Unauthorized"}), 401
        return f(*args, **kwargs)
    return decorated


# ── Auth ──────────────────────────────────────────────────────

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
            conn = get_db(); cur = conn.cursor()
            cur.execute("SELECT * FROM users WHERE username=?", (username,))
            user = cur.fetchone(); conn.close()
        if user and check_password_hash(user["password_hash"], password):
            if selected_role and selected_role != user["role"]:
                return jsonify({"status": "error",
                    "message": f"Access denied. '{username}' is not an {selected_role}."}), 401
            session.update({"user_id": user["id"], "username": user["username"], "role": user["role"]})
            return jsonify({"status": "success", "username": user["username"], "role": user["role"]})
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
    return jsonify({"username": session.get("username"), "role": session.get("role")})


# ── Users ─────────────────────────────────────────────────────

@app.route("/users", methods=["GET"])
@admin_required
def get_users():
    with db_lock:
        conn = get_db(); cur = conn.cursor()
        cur.execute("SELECT id,username,role,created_at FROM users ORDER BY id")
        rows = [dict(r) for r in cur.fetchall()]; conn.close()
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
            conn = get_db(); cur = conn.cursor()
            cur.execute("INSERT INTO users (username,password_hash,role,created_at) VALUES (?,?,?,?)",
                (username, generate_password_hash(password), role,
                 datetime.now().strftime("%Y-%m-%d %H:%M:%S")))
            conn.commit(); conn.close()
        return jsonify({"status": "success", "message": f"User '{username}' created."})
    except sqlite3.IntegrityError:
        return jsonify({"status": "error", "message": "Username already exists"}), 409


@app.route("/users/<int:user_id>", methods=["DELETE"])
@admin_required
def delete_user(user_id):
    if user_id == session.get("user_id"):
        return jsonify({"status": "error", "message": "Cannot delete your own account"}), 400
    try:
        with db_lock:
            conn = get_db(); cur = conn.cursor()
            cur.execute("DELETE FROM users WHERE id=?", (user_id,))
            conn.commit(); conn.close()
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/change-password", methods=["POST"])
@login_required
def change_password():
    data = request.get_json(force=True) or {}
    cur_pw = data.get("current_password", "")
    new_pw = data.get("new_password", "")
    if not cur_pw or not new_pw:
        return jsonify({"status": "error", "message": "All fields are required."}), 400
    if len(new_pw) < 6:
        return jsonify({"status": "error", "message": "New password must be at least 6 characters."}), 400
    uid = session.get("user_id")
    with db_lock:
        conn = get_db(); cur = conn.cursor()
        cur.execute("SELECT * FROM users WHERE id=?", (uid,))
        user = cur.fetchone(); conn.close()
    if not user or not check_password_hash(user["password_hash"], cur_pw):
        return jsonify({"status": "error", "message": "Current password is incorrect."}), 401
    with db_lock:
        conn = get_db(); cur = conn.cursor()
        cur.execute("UPDATE users SET password_hash=? WHERE id=?",
                    (generate_password_hash(new_pw), uid))
        conn.commit(); conn.close()
    return jsonify({"status": "success", "message": "Password updated successfully."})


# ── Settings ──────────────────────────────────────────────────

@app.route("/settings/reagent-names", methods=["GET"])
@login_required
def get_reagent_names():
    with db_lock:
        conn = get_db(); cur = conn.cursor()
        cur.execute("SELECT key,value FROM settings WHERE key IN ('reagent_a_name','reagent_b_name')")
        rows = {r["key"]: r["value"] for r in cur.fetchall()}; conn.close()
    return jsonify({"a": rows.get("reagent_a_name", "Reagent A"),
                    "b": rows.get("reagent_b_name", "Reagent B")})


@app.route("/settings/reagent-names", methods=["POST"])
@login_required
def save_reagent_names():
    data   = request.get_json(force=True) or {}
    name_a = data.get("a", "").strip()
    name_b = data.get("b", "").strip()
    if not name_a or not name_b:
        return jsonify({"status": "error", "message": "Both names are required."}), 400
    if len(name_a) > 30 or len(name_b) > 30:
        return jsonify({"status": "error", "message": "Names must be 30 characters or less."}), 400
    with db_lock:
        conn = get_db(); cur = conn.cursor()
        cur.execute("INSERT OR REPLACE INTO settings (key,value) VALUES ('reagent_a_name',?)", (name_a,))
        cur.execute("INSERT OR REPLACE INTO settings (key,value) VALUES ('reagent_b_name',?)", (name_b,))
        conn.commit(); conn.close()
    return jsonify({"status": "success"})


# ── Protocols ─────────────────────────────────────────────────

@app.route("/protocols", methods=["GET"])
@login_required
def get_protocols():
    username = session.get("username")
    role     = session.get("role")
    with db_lock:
        conn = get_db(); cur = conn.cursor()
        if role == "admin":
            cur.execute("SELECT * FROM protocols ORDER BY is_global DESC, created_at DESC")
        else:
            cur.execute(
                "SELECT * FROM protocols WHERE is_global=1 OR created_by=? ORDER BY is_global DESC, created_at DESC",
                (username,))
        rows = [dict(r) for r in cur.fetchall()]; conn.close()
    for r in rows:
        r["steps"] = json.loads(r["steps_json"])
        del r["steps_json"]
    return jsonify(rows)


@app.route("/protocols", methods=["POST"])
@login_required
def create_protocol():
    data      = request.get_json(force=True) or {}
    name      = data.get("name", "").strip()
    steps     = data.get("steps", [])
    is_global = 1 if (data.get("is_global") and session.get("role") == "admin") else 0
    username  = session.get("username")
    if not name:
        return jsonify({"status": "error", "message": "Protocol name is required."}), 400
    if not steps or not isinstance(steps, list):
        return jsonify({"status": "error", "message": "At least one step is required."}), 400
    for s in steps:
        vol_a = float(s.get("vol_a") or 0)
        vol_b = float(s.get("vol_b") or 0)
        if vol_a < 0 or vol_b < 0:
            return jsonify({"status": "error", "message": "Step volumes cannot be negative."}), 400
        if vol_a == 0 and vol_b == 0:
            return jsonify({"status": "error", "message": "Each step needs at least one non-zero volume."}), 400
    with db_lock:
        conn = get_db(); cur = conn.cursor()
        cur.execute("INSERT INTO protocols (name,steps_json,created_by,created_at,is_global) VALUES (?,?,?,?,?)",
            (name, json.dumps(steps), username,
             datetime.now().strftime("%Y-%m-%d %H:%M:%S"), is_global))
        pid = cur.lastrowid; conn.commit(); conn.close()
    return jsonify({"status": "success", "id": pid})


# ── Protocol edit (PUT) — NEW ─────────────────────────────────
@app.route("/protocols/<int:pid>", methods=["PUT"])
@login_required
def update_protocol(pid):
    username  = session.get("username")
    role      = session.get("role")
    data      = request.get_json(force=True) or {}
    name      = data.get("name", "").strip()
    steps     = data.get("steps", [])
    is_global = 1 if (data.get("is_global") and role == "admin") else 0

    if not name:
        return jsonify({"status": "error", "message": "Protocol name is required."}), 400
    if not steps or not isinstance(steps, list):
        return jsonify({"status": "error", "message": "At least one step is required."}), 400
    for s in steps:
        vol_a = float(s.get("vol_a") or 0)
        vol_b = float(s.get("vol_b") or 0)
        if vol_a == 0 and vol_b == 0:
            return jsonify({"status": "error", "message": "Each step needs at least one non-zero volume."}), 400

    with db_lock:
        conn = get_db(); cur = conn.cursor()
        cur.execute("SELECT * FROM protocols WHERE id=?", (pid,))
        row = cur.fetchone()
        if not row:
            conn.close()
            return jsonify({"status": "error", "message": "Protocol not found."}), 404
        if role != "admin" and row["created_by"] != username:
            conn.close()
            return jsonify({"status": "error", "message": "Cannot edit another user's protocol."}), 403
        cur.execute(
            "UPDATE protocols SET name=?, steps_json=?, is_global=? WHERE id=?",
            (name, json.dumps(steps), is_global, pid))
        conn.commit(); conn.close()
    return jsonify({"status": "success"})


@app.route("/protocols/<int:pid>", methods=["DELETE"])
@login_required
def delete_protocol(pid):
    username = session.get("username")
    role     = session.get("role")
    with db_lock:
        conn = get_db(); cur = conn.cursor()
        cur.execute("SELECT * FROM protocols WHERE id=?", (pid,))
        row = cur.fetchone()
        if not row:
            conn.close()
            return jsonify({"status": "error", "message": "Protocol not found."}), 404
        if role != "admin" and row["created_by"] != username:
            conn.close()
            return jsonify({"status": "error", "message": "Cannot delete another user's protocol."}), 403
        cur.execute("DELETE FROM protocols WHERE id=?", (pid,))
        conn.commit(); conn.close()
    return jsonify({"status": "success"})


# ── Inventory ─────────────────────────────────────────────────

@app.route("/inventory", methods=["GET"])
@login_required
def get_inventory():
    with db_lock:
        conn = get_db(); cur = conn.cursor()
        cur.execute("SELECT * FROM inventory ORDER BY reagent")
        rows = [dict(r) for r in cur.fetchall()]; conn.close()
    return jsonify(rows)


@app.route("/inventory/update", methods=["POST"])
@login_required
def update_inventory():
    data   = request.get_json(force=True) or {}
    role   = session.get("role")
    action = data.get("action", "")
    now    = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with db_lock:
        conn = get_db(); cur = conn.cursor()
        if action == "deduct":
            for reagent, key in [("A","dispensed_a"), ("B","dispensed_b")]:
                amt = float(data.get(key, 0))
                if amt > 0:
                    cur.execute("UPDATE inventory SET current_ml=MAX(0,current_ml-?),updated_at=? WHERE reagent=?",
                                (amt, now, reagent))
        elif action == "refill":
            reagent = data.get("reagent","").upper()
            amt     = float(data.get("amount_ml", 0))
            if reagent not in ("A","B"):
                conn.close(); return jsonify({"status":"error","message":"Invalid reagent."}), 400
            if amt <= 0:
                conn.close(); return jsonify({"status":"error","message":"Amount must be positive."}), 400
            cur.execute("UPDATE inventory SET current_ml=MIN(capacity_ml,current_ml+?),updated_at=? WHERE reagent=?",
                        (amt, now, reagent))
        elif action == "configure":
            if role != "admin":
                conn.close(); return jsonify({"status":"error","message":"Admin access required."}), 403
            reagent  = data.get("reagent","").upper()
            capacity = float(data.get("capacity_ml", 0))
            warn     = float(data.get("warn_threshold_ml", 0))
            current  = data.get("current_ml", None)
            if reagent not in ("A","B"):
                conn.close(); return jsonify({"status":"error","message":"Invalid reagent."}), 400
            if capacity <= 0:
                conn.close(); return jsonify({"status":"error","message":"Capacity must be positive."}), 400
            if current is not None:
                cur.execute("UPDATE inventory SET capacity_ml=?,warn_threshold_ml=?,current_ml=MIN(?,capacity_ml),updated_at=? WHERE reagent=?",
                            (capacity, warn, float(current), now, reagent))
            else:
                cur.execute("UPDATE inventory SET capacity_ml=?,warn_threshold_ml=?,updated_at=? WHERE reagent=?",
                            (capacity, warn, now, reagent))
        else:
            conn.close(); return jsonify({"status":"error","message":"Unknown action."}), 400
        conn.commit(); conn.close()
    return jsonify({"status": "success"})


# ── Analytics — with avg duration per operator ────────────────

@app.route("/analytics")
@login_required
def get_analytics():
    role     = session.get("role")
    username = session.get("username")
    with db_lock:
        conn = get_db(); cur = conn.cursor()
        base = "SELECT * FROM dispensing_log WHERE status IN ('COMPLETED','EMERGENCY_STOP')"
        if role == "admin":
            cur.execute(base + " ORDER BY start_time ASC")
        else:
            cur.execute(base + " AND operator=? ORDER BY start_time ASC", (username,))
        rows = [dict(r) for r in cur.fetchall()]; conn.close()

    by_date = {}; by_op = {}
    for r in rows:
        date  = (r["start_time"] or "")[:10]
        op    = r.get("operator","unknown")
        a     = r.get("dispensed_reagent_a_ml") or 0
        b     = r.get("dispensed_reagent_b_ml") or 0
        total = a + b
        es    = r["status"] == "EMERGENCY_STOP"

        # Duration calculation
        duration_s = None
        try:
            if r.get("start_time") and r.get("end_time"):
                fmt = "%Y-%m-%d %H:%M:%S"
                duration_s = (datetime.strptime(r["end_time"], fmt) -
                              datetime.strptime(r["start_time"], fmt)).total_seconds()
                if duration_s < 0:
                    duration_s = None
        except Exception:
            pass

        if date not in by_date:
            by_date[date] = {"date": date, "total_ml": 0, "reagent_a_ml": 0,
                             "reagent_b_ml": 0, "count": 0, "emergency_stops": 0}
        by_date[date]["total_ml"]     += total
        by_date[date]["reagent_a_ml"] += a
        by_date[date]["reagent_b_ml"] += b
        by_date[date]["count"]        += 1
        if es: by_date[date]["emergency_stops"] += 1

        if op not in by_op:
            by_op[op] = {"operator": op, "total_ml": 0, "count": 0,
                         "emergency_stops": 0, "_dur_sum": 0, "_dur_cnt": 0}
        by_op[op]["total_ml"] += total
        by_op[op]["count"]    += 1
        if es: by_op[op]["emergency_stops"] += 1
        if duration_s is not None:
            by_op[op]["_dur_sum"] += duration_s
            by_op[op]["_dur_cnt"] += 1

    # Finalise avg duration
    for op_data in by_op.values():
        dc = op_data.pop("_dur_cnt")
        ds = op_data.pop("_dur_sum")
        op_data["avg_duration_s"] = round(ds / dc, 1) if dc > 0 else None

    return jsonify({
        "by_date":       sorted(by_date.values(), key=lambda x: x["date"]),
        "by_operator":   sorted(by_op.values(),   key=lambda x: -x["total_ml"]),
        "total_records": len(rows),
        "role":          role
    })


# ── Report ────────────────────────────────────────────────────

@app.route("/report")
@login_required
def get_report():
    role     = session.get("role")
    username = session.get("username")
    with db_lock:
        conn = get_db(); cur = conn.cursor()
        base = "SELECT * FROM dispensing_log WHERE status IN ('COMPLETED','EMERGENCY_STOP')"
        if role == "admin":
            cur.execute(base + " ORDER BY id DESC LIMIT 500")
        else:
            cur.execute(base + " AND operator=? ORDER BY id DESC LIMIT 500", (username,))
        rows  = [dict(r) for r in cur.fetchall()]
        cur.execute("SELECT key,value FROM settings WHERE key IN ('reagent_a_name','reagent_b_name')")
        names = {r["key"]: r["value"] for r in cur.fetchall()}
        cur.execute("SELECT * FROM inventory ORDER BY reagent")
        inv   = [dict(r) for r in cur.fetchall()]
        conn.close()
    return jsonify({
        "generated_at":   datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "generated_by":   username,
        "role":           role,
        "reagent_a_name": names.get("reagent_a_name","Reagent A"),
        "reagent_b_name": names.get("reagent_b_name","Reagent B"),
        "inventory":      inv,
        "records":        rows
    })


# ── ESP32 ─────────────────────────────────────────────────────

@app.route("/esp32/heartbeat", methods=["POST"])
def esp32_heartbeat():
    global esp32_connected, esp32_last_seen
    esp32_last_seen = datetime.now()
    if not esp32_connected:
        esp32_connected = True
        print("ESP32 connected")
    return jsonify({"status": "ok"})


@app.route("/esp32/status")
@login_required
def esp32_status():
    if esp32_last_seen and (datetime.now() - esp32_last_seen).seconds < 10:
        return jsonify({"status": "connected"}), 200
    return jsonify({"status": "error", "message": "Controller not connected"}), 503


def send_command_to_esp32(endpoint, params=None):
    if not esp32_connected:
        return False, "Controller not connected"
    try:
        url = f"http://{ESP32_IP}/{endpoint}"
        r   = requests.get(url, params=params, timeout=2)
        return (True, "OK") if r.status_code == 200 else (False, f"ESP32 returned {r.status_code}")
    except Exception as e:
        return False, str(e)


# ── Home ──────────────────────────────────────────────────────

@app.route("/")
@login_required
def home():
    return render_template("index.html",
                           username=session.get("username"),
                           role=session.get("role"))


# ── In-memory dispense session ────────────────────────────────

dispense_session = {
    "active": False, "operator": None, "start_time": None,
    "reagent_a": 0.0, "reagent_b": 0.0,
    "dispensed_a": 0.0, "dispensed_b": 0.0,
    "halted": False,
    "note": "",
}
session_lock = threading.Lock()


@app.route("/dispense", methods=["POST"])
@login_required
def dispense():
    try:
        data      = request.get_json(force=True) or {}
        reagent_a = float(data.get("reagent_a", 0))
        reagent_b = float(data.get("reagent_b", 0))
        note      = str(data.get("note", "")).strip()[:500]
        operator  = session.get("username", "unknown")
        if not esp32_connected:
            return jsonify({"status": "error", "message": "Controller not connected"}), 503
        ok, msg = send_command_to_esp32("start", {"reagent_a": reagent_a, "reagent_b": reagent_b})
        if not ok:
            return jsonify({"status": "error", "message": msg}), 500
        with session_lock:
            dispense_session.update({
                "active":      True,
                "operator":    operator,
                "start_time":  datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "reagent_a":   reagent_a,
                "reagent_b":   reagent_b,
                "dispensed_a": 0.0,
                "dispensed_b": 0.0,
                "halted":      False,
                "note":        note,
            })
        return jsonify({"status": "started"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


def _do_emergency_stop(data, operator):
    snapshot = None
    with session_lock:
        if dispense_session["active"]:
            snapshot = {k: dispense_session[k] for k in
                        ["start_time","reagent_a","dispensed_a","reagent_b","dispensed_b","operator","note"]}
            snapshot["operator"] = snapshot["operator"] or operator
            dispense_session["active"] = False
            dispense_session["halted"] = True
    if snapshot:
        with db_lock:
            conn = get_db(); cur = conn.cursor()
            cur.execute("""INSERT INTO dispensing_log
                (start_time,end_time,target_reagent_a_ml,dispensed_reagent_a_ml,
                 target_reagent_b_ml,dispensed_reagent_b_ml,status,stop_reason,operator,note)
                VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (snapshot["start_time"], datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                 snapshot["reagent_a"], snapshot["dispensed_a"],
                 snapshot["reagent_b"], snapshot["dispensed_b"],
                 "EMERGENCY_STOP", data.get("reason","Emergency stop triggered"),
                 snapshot["operator"], snapshot.get("note","")))
            conn.commit(); conn.close()
        _deduct_inventory(snapshot["dispensed_a"], snapshot["dispensed_b"])
    return jsonify({"status": "stopped"})


@app.route("/emergency-stop", methods=["POST"])
@login_required
def emergency_stop():
    data     = request.get_json(force=True) or {}
    operator = session.get("username", "unknown")
    send_command_to_esp32("stop")
    return _do_emergency_stop(data, operator)


@app.route("/esp32/emergency-stop", methods=["POST"])
@esp32_auth
def esp32_emergency_stop():
    """Called by ESP32 firmware (physical button / auto-halt).
    Sets halted=True in dispense_session so the frontend poll detects it."""
    data = request.get_json(force=True) or {}
    return _do_emergency_stop(data, "esp32-hardware")


def _do_complete():
    snapshot = None
    with session_lock:
        if dispense_session["active"]:
            snapshot = {k: dispense_session[k] for k in
                        ["start_time","reagent_a","dispensed_a","reagent_b","dispensed_b","operator","note"]}
            dispense_session["active"] = False
            dispense_session["halted"] = False
    if snapshot:
        with db_lock:
            conn = get_db(); cur = conn.cursor()
            cur.execute("""INSERT INTO dispensing_log
                (start_time,end_time,target_reagent_a_ml,dispensed_reagent_a_ml,
                 target_reagent_b_ml,dispensed_reagent_b_ml,status,operator,note)
                VALUES (?,?,?,?,?,?,?,?,?)""",
                (snapshot["start_time"], datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                 snapshot["reagent_a"], snapshot["dispensed_a"],
                 snapshot["reagent_b"], snapshot["dispensed_b"],
                 "COMPLETED", snapshot["operator"], snapshot.get("note","")))
            conn.commit(); conn.close()
        _deduct_inventory(snapshot["dispensed_a"], snapshot["dispensed_b"])
    return jsonify({"status": "completed"})


@app.route("/complete", methods=["POST"])
@login_required
def complete_dispense():
    return _do_complete()


@app.route("/esp32/complete", methods=["POST"])
@esp32_auth
def esp32_complete():
    return _do_complete()


def _deduct_inventory(dispensed_a, dispensed_b):
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with db_lock:
        conn = get_db(); cur = conn.cursor()
        if dispensed_a > 0:
            cur.execute("UPDATE inventory SET current_ml=MAX(0,current_ml-?),updated_at=? WHERE reagent='A'",
                        (dispensed_a, now))
        if dispensed_b > 0:
            cur.execute("UPDATE inventory SET current_ml=MAX(0,current_ml-?),updated_at=? WHERE reagent='B'",
                        (dispensed_b, now))
        conn.commit(); conn.close()


@app.route("/progress")
@login_required
def get_progress():
    with session_lock:
        if not dispense_session["active"]:
            halted = dispense_session.get("halted", False)
            if halted:
                dispense_session["halted"] = False
            return jsonify({
                "active":      False,
                "halted":      halted,
                "dispensed_a": dispense_session["dispensed_a"],
                "dispensed_b": dispense_session["dispensed_b"],
                "target_a":    dispense_session["reagent_a"],
                "target_b":    dispense_session["reagent_b"],
                "pct_a":       100.0,
                "pct_b":       100.0,
            })
        ta  = dispense_session["reagent_a"];   tb  = dispense_session["reagent_b"]
        da  = dispense_session["dispensed_a"]; db_ = dispense_session["dispensed_b"]
        pa  = min(round(da/ta*100,1)  if ta>0 else 100.0, 100.0)
        pb  = min(round(db_/tb*100,1) if tb>0 else 100.0, 100.0)
        return jsonify({
            "active":      True,
            "halted":      False,
            "dispensed_a": round(da,2),  "dispensed_b": round(db_,2),
            "target_a":    ta,           "target_b":    tb,
            "pct_a":       pa,           "pct_b":       pb,
        })


@app.route("/update-progress", methods=["POST"])
@esp32_auth
def update_progress():
    data = request.get_json(force=True) or {}
    with session_lock:
        if dispense_session["active"]:
            dispense_session["dispensed_a"] = float(data.get("reagent_a_dispensed", 0))
            dispense_session["dispensed_b"] = float(data.get("reagent_b_dispensed", 0))
    return jsonify({"status": "updated"})


# ── History ───────────────────────────────────────────────────

@app.route("/history")
@login_required
def get_history():
    role     = session.get("role")
    username = session.get("username")
    with db_lock:
        conn = get_db(); cur = conn.cursor()
        if role == "admin":
            cur.execute("SELECT * FROM dispensing_log WHERE status IN ('COMPLETED','EMERGENCY_STOP') ORDER BY id DESC")
        else:
            cur.execute("SELECT * FROM dispensing_log WHERE status IN ('COMPLETED','EMERGENCY_STOP') AND operator=? ORDER BY id DESC", (username,))
        rows = [dict(r) for r in cur.fetchall()]; conn.close()
    events = []
    for r in rows:
        if r["status"] == "COMPLETED":
            msg   = (f"Reagent A: {r['dispensed_reagent_a_ml']} ml, "
                     f"Reagent B: {r['dispensed_reagent_b_ml']} ml | "
                     f"Total: {(r['dispensed_reagent_a_ml'] or 0)+(r['dispensed_reagent_b_ml'] or 0):.1f} ml")
            type_ = "DISPENSE"
        elif r["status"] == "EMERGENCY_STOP":
            msg   = (f"Stopped at — A: {r['dispensed_reagent_a_ml']}/{r['target_reagent_a_ml']} ml, "
                     f"B: {r['dispensed_reagent_b_ml']}/{r['target_reagent_b_ml']} ml | "
                     f"Reason: {r['stop_reason']}")
            type_ = "EMERGENCY"
        else:
            continue
        events.append({
            "id":        r["id"],
            "timestamp": r["start_time"],
            "end_time":  r.get("end_time",""),
            "operator":  r.get("operator","unknown"),
            "type":      type_,
            "message":   msg,
            "note":      r.get("note","") or ""
        })
    return jsonify(events)


# ── History note update — NEW ─────────────────────────────────
@app.route("/history/<int:record_id>/note", methods=["POST"])
@login_required
def update_history_note(record_id):
    data     = request.get_json(force=True) or {}
    note     = str(data.get("note","")).strip()[:500]
    role     = session.get("role")
    username = session.get("username")
    with db_lock:
        conn = get_db(); cur = conn.cursor()
        cur.execute("SELECT operator FROM dispensing_log WHERE id=?", (record_id,))
        row = cur.fetchone()
        if not row:
            conn.close()
            return jsonify({"status":"error","message":"Record not found."}), 404
        if role != "admin" and row["operator"] != username:
            conn.close()
            return jsonify({"status":"error","message":"Cannot edit another operator's record."}), 403
        cur.execute("UPDATE dispensing_log SET note=? WHERE id=?", (note, record_id))
        conn.commit(); conn.close()
    return jsonify({"status":"success"})


@app.route("/clear-history", methods=["POST"])
@admin_required
def clear_history():
    try:
        with db_lock:
            conn = get_db(); cur = conn.cursor()
            cur.execute("DELETE FROM dispensing_log")
            conn.commit(); conn.close()
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/delete-history/<int:record_id>", methods=["DELETE"])
@admin_required
def delete_history(record_id):
    try:
        with db_lock:
            conn = get_db(); cur = conn.cursor()
            cur.execute("DELETE FROM dispensing_log WHERE id=?", (record_id,))
            conn.commit(); conn.close()
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


# ── Error handlers ────────────────────────────────────────────

@app.errorhandler(400)
def bad_request(e):      return jsonify({"status":"error","message":str(e)}), 400
@app.errorhandler(401)
def unauthorized(e):     return jsonify({"status":"error","message":"Session expired"}), 401
@app.errorhandler(403)
def forbidden(e):        return jsonify({"status":"error","message":"Access denied"}), 403
@app.errorhandler(404)
def not_found(e):        return jsonify({"status":"error","message":"Endpoint not found"}), 404
@app.errorhandler(500)
def internal_error(e):   return jsonify({"status":"error","message":f"Internal server error: {str(e)}"}), 500
@app.errorhandler(Exception)
def handle_exception(e): return jsonify({"status":"error","message":str(e)}), 500


# ── Entry point ───────────────────────────────────────────────

if __name__ == "__main__":
    init_db()
    try:
        local_ip = socket.gethostbyname(socket.gethostname())
    except Exception:
        local_ip = "127.0.0.1"
    print(f"Local:   http://localhost:8000")
    print(f"Network: http://{local_ip}:8000")
    app.run(debug=False, port=8000, host="0.0.0.0", threaded=True)
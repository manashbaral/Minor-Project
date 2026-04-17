// ============================================================
//  AMRDS — Automated Multi-Reagent Dispensing System
//  ESP32 Firmware  |  main.cpp  |  Production build
//
//  Hardware wiring
//  ─────────────────────────────────────────────────────────
//  Pump 1 (Reagent A)  IN1=26  IN2=27  EN(PWM)=25  LEDC ch0
//  Pump 2 (Reagent B)  IN1=18  IN2=19  EN(PWM)=23  LEDC ch1
//  Flow sensor 1       GPIO=4   (FALLING interrupt)
//  Flow sensor 2       GPIO=5   (FALLING interrupt)
//  Emergency button    GPIO=34  (INPUT_PULLUP, active LOW)
//  Note: sensors wired through voltage divider — INPUT (no pull-up)
//
//  Calibration (hardware verified, per-pump)
//  ─────────────────────────────────────────────────────────
//  Pump 1  PULSES_PER_LITRE : 394.8   DEBOUNCE : 5 ms
//  Pump 2  PULSES_PER_LITRE : 398.0   DEBOUNCE : 80 ms
//  DEADBAND_ML : 0.5   (stop threshold)
//  PID gains   : Kp=4.5  Ki=0.03  Kd=2.5
//
//  Flask integration
//  ─────────────────────────────────────────────────────────
//  ESP32 → Flask  POST /esp32/heartbeat      every 2 s
//  ESP32 → Flask  POST /update-progress      every 500 ms (while dispensing)
//  ESP32 → Flask  POST /complete             when sequence finishes
//  Flask → ESP32  GET  /start?reagent_a=X&reagent_b=Y
//  Flask → ESP32  GET  /stop
//  Flask → ESP32  GET  /complete
//  Flask → ESP32  GET  /ping
//
// ============================================================
#include <WiFi.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <HTTPClient.h>

// ============================================================
//  NETWORK CONFIGURATION
// ============================================================
const char* WIFI_SSID  = ""; // your wifi ssid
const char* WIFI_PASS  = ""; // your wifi password
const char* FLASK_HOST = ""; // flask server ip address
const int   FLASK_PORT = 8000;

// ============================================================
//  PIN CONFIGURATION
// ============================================================
#define PUMP1_IN1     26
#define PUMP1_IN2     27
#define PUMP1_EN      25    // LEDC channel 0

#define PUMP2_IN1     18
#define PUMP2_IN2     19
#define PUMP2_EN      33    // LEDC channel 1

#define FLOW1_SENSOR   4
#define FLOW2_SENSOR   5

#define BUTTON_PIN    34    // Emergency stop push button (active LOW, INPUT_PULLUP)

// ============================================================
//  PWM CONFIGURATION
// ============================================================
const int PWM_CHANNEL1   = 0;
const int PWM_CHANNEL2   = 1;
const int PWM_FREQ       = 5000;
const int PWM_RESOLUTION = 8;
const int PWM_MAX        = 255;
const int PWM_MIN        = 220;

// ============================================================
//  FLOW SENSOR CALIBRATION — per pump
//
//  Pump 1: 394.8 pulses/L,  5 ms hardware debounce
//  Pump 2: 398.0 pulses/L, 80 ms hardware debounce
//  Each pump has its own constant so a sensor swap or
//  re-calibration only touches the relevant line.
// ============================================================
#define PUMP1_PULSES_PER_LITRE  394.8f
#define PUMP1_DEBOUNCE_US       5000UL      //  5 ms

#define PUMP2_PULSES_PER_LITRE  400.0f
#define PUMP2_DEBOUNCE_US       80000UL     // 80 ms

const float ML_PER_PULSE1 = 1000.0f / PUMP1_PULSES_PER_LITRE;
const float ML_PER_PULSE2 = 1000.0f / PUMP2_PULSES_PER_LITRE;

// ============================================================
//  BUTTON DEBOUNCE
//  50 ms software debounce — ignores bounces after first press.
//  GPIO 34 is input-only, so INPUT_PULLUP is used.
//  Button press = LOW (active low wiring: button connects pin to GND).
// ============================================================
#define BUTTON_DEBOUNCE_MS  50UL
unsigned long lastButtonPress = 0;
bool          lastButtonState = HIGH;   // unpressed = HIGH (pull-up)

// ============================================================
//  PID CONFIGURATION
// ============================================================
float PID_KP = 2.9f;
float PID_KI = 0.04f;
float PID_KD = 3.0f;

const float         DEADBAND_ML     = 15.0f;
const unsigned long PID_INTERVAL_MS = 100;

// ============================================================
//  TIMING
// ============================================================
const unsigned long HEARTBEAT_MS       = 2000;
const unsigned long REPORT_MS          = 500;
const unsigned long WIFI_WATCHDOG_MS   = 5000;
const unsigned long NO_FLOW_TIMEOUT_MS = 15000UL;

// ============================================================
//  STRUCTS
// ============================================================
struct PIDState {
    float         integral  = 0.0f;
    float         lastError = 0.0f;
    unsigned long lastMs    = 0;
};

struct PumpState {
    bool      active      = false;
    float     targetMl    = 0.0f;
    float     dispensedMl = 0.0f;
    PIDState  pid;
};

// ============================================================
//  GLOBALS
// ============================================================
AsyncWebServer server(80);

volatile uint32_t      pulse1Count    = 0;
volatile uint32_t      pulse2Count    = 0;
volatile unsigned long lastPulse1Time = 0;   // micros() of last accepted pulse
volatile unsigned long lastPulse2Time = 0;

portMUX_TYPE pulseMux = portMUX_INITIALIZER_UNLOCKED;

PumpState     pump1;
PumpState     pump2;
bool          sequenceComplete = false;
bool          pendingComplete  = false;
unsigned long lastReportMs     = 0;
unsigned long lastFlowPulse1Ms = 0;   // millis() of last pulse (no-flow watchdog)
unsigned long lastFlowPulse2Ms = 0;


// ============================================================
//  ISRs — FALLING edge, per-pump debounce constants
//
//  Pump 1 uses PUMP1_DEBOUNCE_US (5 ms).
//  Pump 2 uses PUMP2_DEBOUNCE_US (80 ms) — its sensor produces
//  longer bounce noise so a wider window is required.
// ============================================================
void IRAM_ATTR onFlow1Pulse() {
    unsigned long now = micros();
    portENTER_CRITICAL_ISR(&pulseMux);
    if (now - lastPulse1Time >= PUMP1_DEBOUNCE_US) {
        pulse1Count++;
        lastPulse1Time = now;
    }
    portEXIT_CRITICAL_ISR(&pulseMux);
    if (pump1.active) lastFlowPulse1Ms = millis();
}

void IRAM_ATTR onFlow2Pulse() {
    unsigned long now = micros();
    portENTER_CRITICAL_ISR(&pulseMux);
    if (now - lastPulse2Time >= PUMP2_DEBOUNCE_US) {
        pulse2Count++;
        lastPulse2Time = now;
    }
    portEXIT_CRITICAL_ISR(&pulseMux);
    if (pump2.active) lastFlowPulse2Ms = millis();
}


// ============================================================
//  WIFI
// ============================================================
void connectWiFi() {
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    Serial.print("Connecting to WiFi");
    while (WiFi.status() != WL_CONNECTED) {
        delay(500);
        Serial.print(".");
    }
    Serial.println();
    Serial.println("WiFi connected!");
    Serial.print("ESP32 IP: ");
    Serial.println(WiFi.localIP());
}

void maintainWiFi() {
    if (WiFi.status() == WL_CONNECTED) return;
    Serial.println("[WiFi] Lost — reconnecting...");
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED) {
        if (millis() - start > 10000) {
            Serial.println("[WiFi] Timeout — will retry next cycle.");
            return;
        }
        delay(500);
        Serial.print(".");
    }
    Serial.println();
    Serial.println("[WiFi] Reconnected!");
    Serial.print("ESP32 IP: ");
    Serial.println(WiFi.localIP());
}


// ============================================================
//  FLASK COMMUNICATION
// ============================================================
int postToFlask(const char* path, const String& body) {
    if (WiFi.status() != WL_CONNECTED) return -1;
    HTTPClient http;
    String url = "http://" + String(FLASK_HOST) + ":" + String(FLASK_PORT) + path;
    http.begin(url);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-Device-Key", "amrds-device-key-2024");
    int code = http.POST(body);
    http.end();
    return code;
}

void sendHeartbeat() {
    int code = postToFlask("/esp32/heartbeat", "{}");
    if (code != 200)
        Serial.printf("[Heartbeat] Failed (HTTP %d)\n", code);
}

void reportProgress() {
    String body = "{";
    body += "\"reagent_a_dispensed\":" + String(pump1.dispensedMl, 2) + ",";
    body += "\"reagent_b_dispensed\":" + String(pump2.dispensedMl, 2);
    body += "}";
    postToFlask("/update-progress", body);
}

void notifyComplete() {
    if (WiFi.status() != WL_CONNECTED) {
        pendingComplete = true;
        Serial.println("[Flask] WiFi down — /complete queued.");
        return;
    }
    reportProgress();
    int code = postToFlask("/esp32/complete", "{}");
    if (code == 200) {
        pendingComplete = false;
        Serial.println("[Flask] /complete acknowledged.");
    } else {
        pendingComplete = true;
        Serial.printf("[Flask] /complete failed (HTTP %d) — will retry.\n", code);
    }
}

// ============================================================
//  EMERGENCY STOP
// ============================================================
void notifyEmergencyStop(const char* reason) {
    reportProgress();
    String body = "{\"reason\":\"";
    body += reason;
    body += "\"}";
    int code = postToFlask("/esp32/emergency-stop", body);
    if (code == 200) {
        Serial.printf("[Flask] /emergency-stop acknowledged (%s)\n", reason);
    } else {
        Serial.printf("[Flask] /emergency-stop failed (HTTP %d) — pumps already halted.\n", code);
    }
}


// ============================================================
//  PID COMPUTE
// ============================================================
int computePID(PumpState& pump, int pwmChannel) {
    unsigned long now = millis();
    float dt = (now - pump.pid.lastMs) / 1000.0f;

    if (dt < (PID_INTERVAL_MS / 1000.0f) * 0.8f) return -1;  //0.8f is for 
    pump.pid.lastMs = now;

    float error = pump.targetMl - pump.dispensedMl;

    if (error <= DEADBAND_ML) {
        ledcWrite(pwmChannel, 0);
        return 0;
    }

    float P = PID_KP * error;

    pump.pid.integral += error * dt;
    pump.pid.integral  = constrain(pump.pid.integral, -100.0f, 100.0f);
    float I = PID_KI * pump.pid.integral;

    float derivative   = (dt > 0.0f) ? (error - pump.pid.lastError) / dt : 0.0f;
    float D            = PID_KD * derivative;
    pump.pid.lastError = error;

    int pwm = (int)constrain(P + I + D, (float)PWM_MIN, (float)PWM_MAX);
    ledcWrite(pwmChannel, pwm);

    Serial.printf("[PID ch%d] Remaining:%.2fml | P:%.1f I:%.1f D:%.1f | PWM:%d\n",
                  pwmChannel, error, P, I, D, pwm);
    return pwm;
}


// ============================================================
//  PUMP CONTROL
// ============================================================
void startPump1(float targetMl) {
    portENTER_CRITICAL(&pulseMux);
    pulse1Count    = 0;
    lastPulse1Time = 0;
    portEXIT_CRITICAL(&pulseMux);

    pump1.active        = true;
    pump1.targetMl      = targetMl;
    pump1.dispensedMl   = 0.0f;
    pump1.pid.integral  = 0.0f;
    pump1.pid.lastError = targetMl;
    pump1.pid.lastMs    = millis();
    lastFlowPulse1Ms    = millis();
    sequenceComplete    = false;

    digitalWrite(PUMP1_IN1, HIGH);
    digitalWrite(PUMP1_IN2, LOW);
    ledcWrite(PWM_CHANNEL1, PWM_MAX);

    Serial.printf("[Pump 1] START  Target:%.1fml  %.4fml/pulse  debounce:%lums\n",
                  targetMl, ML_PER_PULSE1, PUMP1_DEBOUNCE_US / 1000UL);
}

void startPump2(float targetMl) {
    portENTER_CRITICAL(&pulseMux);
    pulse2Count    = 0;
    lastPulse2Time = 0;
    portEXIT_CRITICAL(&pulseMux);

    pump2.active        = true;
    pump2.targetMl      = targetMl;
    pump2.dispensedMl   = 0.0f;
    pump2.pid.integral  = 0.0f;
    pump2.pid.lastError = targetMl;
    pump2.pid.lastMs    = millis();
    lastFlowPulse2Ms    = millis();
    sequenceComplete    = false;

    digitalWrite(PUMP2_IN1, HIGH);
    digitalWrite(PUMP2_IN2, LOW);
    ledcWrite(PWM_CHANNEL2, PWM_MAX);

    Serial.printf("[Pump 2] START  Target:%.1fml  %.4fml/pulse  debounce:%lums\n",
                  targetMl, ML_PER_PULSE2, PUMP2_DEBOUNCE_US / 1000UL);
}

void stopPump1() {
    ledcWrite(PWM_CHANNEL1, 0);
    digitalWrite(PUMP1_IN1, LOW);
    digitalWrite(PUMP1_IN2, LOW);
    pump1.active        = false;
    pump1.pid.integral  = 0.0f;
    pump1.pid.lastError = 0.0f;
    Serial.printf("[Pump 1] STOP  Dispensed:%.2f/%.2fml\n",
                  pump1.dispensedMl, pump1.targetMl);
}

void stopPump2() {
    ledcWrite(PWM_CHANNEL2, 0);
    digitalWrite(PUMP2_IN1, LOW);
    digitalWrite(PUMP2_IN2, LOW);
    pump2.active        = false;
    pump2.pid.integral  = 0.0f;
    pump2.pid.lastError = 0.0f;
    Serial.printf("[Pump 2] STOP  Dispensed:%.2f/%.2fml\n",
                  pump2.dispensedMl, pump2.targetMl);
}

void stopAllPumps() {
    stopPump1();
    stopPump2();
    Serial.println("[Pumps] All stopped.");
}


// ============================================================
//  HTTP ROUTES
// ============================================================
void setupRoutes() {

    server.on("/ping", HTTP_GET, [](AsyncWebServerRequest* req) {
        req->send(200, "application/json", "{\"status\":\"ok\"}");
    });

    server.on("/start", HTTP_GET, [](AsyncWebServerRequest* req) {
        if (!req->hasParam("reagent_a") && !req->hasParam("reagent_b")) {
            req->send(400, "application/json",
                      "{\"status\":\"error\",\"message\":\"Missing reagent parameters\"}");
            return;
        }
        float a = req->hasParam("reagent_a")
                  ? req->getParam("reagent_a")->value().toFloat() : 0.0f;
        float b = req->hasParam("reagent_b")
                  ? req->getParam("reagent_b")->value().toFloat() : 0.0f;

        if (a <= 0.0f && b <= 0.0f) {
            req->send(400, "application/json",
                      "{\"status\":\"error\",\"message\":\"Both volumes are zero\"}");
            return;
        }
        if (a > 0.0f) startPump1(a);
        if (b > 0.0f) startPump2(b);

        Serial.printf("[/start] A:%.1fml  B:%.1fml\n", a, b);
        req->send(200, "application/json", "{\"status\":\"started\"}");
    });

    server.on("/stop", HTTP_GET, [](AsyncWebServerRequest* req) {
        stopAllPumps();
        sequenceComplete = false;
        Serial.println("[/stop] Pumps stopped by Flask command.");
        req->send(200, "application/json", "{\"status\":\"emergency_stopped\"}");
    });

    server.on("/complete", HTTP_GET, [](AsyncWebServerRequest* req) {
        stopAllPumps();
        Serial.println("[/complete] Confirmed by Flask.");
        req->send(200, "application/json", "{\"status\":\"completed\"}");
    });

    // ── /status — exposes per-pump calibration separately ──
    server.on("/status", HTTP_GET, [](AsyncWebServerRequest* req) {
        portENTER_CRITICAL(&pulseMux);
        uint32_t p1 = pulse1Count;
        uint32_t p2 = pulse2Count;
        portEXIT_CRITICAL(&pulseMux);

        String j = "{";
        j += "\"pump1_active\":"         + String(pump1.active ? "true" : "false") + ",";
        j += "\"pump1_target\":"         + String(pump1.targetMl,    2) + ",";
        j += "\"pump1_dispensed\":"      + String(pump1.dispensedMl, 2) + ",";
        j += "\"pump1_remaining\":"      + String(pump1.targetMl - pump1.dispensedMl, 2) + ",";
        j += "\"pump1_integral\":"       + String(pump1.pid.integral, 3) + ",";
        j += "\"pump1_pulses_per_l\":"   + String(PUMP1_PULSES_PER_LITRE, 1) + ",";
        j += "\"pump1_ml_per_pulse\":"   + String(ML_PER_PULSE1, 4) + ",";
        j += "\"pump1_debounce_ms\":"    + String(PUMP1_DEBOUNCE_US / 1000UL) + ",";
        j += "\"pump2_active\":"         + String(pump2.active ? "true" : "false") + ",";
        j += "\"pump2_target\":"         + String(pump2.targetMl,    2) + ",";
        j += "\"pump2_dispensed\":"      + String(pump2.dispensedMl, 2) + ",";
        j += "\"pump2_remaining\":"      + String(pump2.targetMl - pump2.dispensedMl, 2) + ",";
        j += "\"pump2_integral\":"       + String(pump2.pid.integral, 3) + ",";
        j += "\"pump2_pulses_per_l\":"   + String(PUMP2_PULSES_PER_LITRE, 1) + ",";
        j += "\"pump2_ml_per_pulse\":"   + String(ML_PER_PULSE2, 4) + ",";
        j += "\"pump2_debounce_ms\":"    + String(PUMP2_DEBOUNCE_US / 1000UL) + ",";
        j += "\"pulse1\":"               + String(p1) + ",";
        j += "\"pulse2\":"               + String(p2) + ",";
        j += "\"button_pin\":"           + String(BUTTON_PIN) + ",";
        j += "\"kp\":"                   + String(PID_KP, 3) + ",";
        j += "\"ki\":"                   + String(PID_KI, 4) + ",";
        j += "\"kd\":"                   + String(PID_KD, 3);
        j += "}";
        req->send(200, "application/json", j);
    });

    server.on("/pid-tune", HTTP_GET, [](AsyncWebServerRequest* req) {
        if (req->hasParam("kp")) PID_KP = req->getParam("kp")->value().toFloat();
        if (req->hasParam("ki")) PID_KI = req->getParam("ki")->value().toFloat();
        if (req->hasParam("kd")) PID_KD = req->getParam("kd")->value().toFloat();
        Serial.printf("[PID-TUNE] Kp=%.3f  Ki=%.4f  Kd=%.3f\n", PID_KP, PID_KI, PID_KD);
        String j = "{\"status\":\"updated\",";
        j += "\"kp\":" + String(PID_KP, 3) + ",";
        j += "\"ki\":" + String(PID_KI, 4) + ",";
        j += "\"kd\":" + String(PID_KD, 3) + "}";
        req->send(200, "application/json", j);
    });

    // ── /simulate — uses correct per-pump ML_PER_PULSE ──────
    server.on("/simulate", HTTP_GET, [](AsyncWebServerRequest* req) {
        if (pump1.active || pump2.active) {
            req->send(409, "application/json",
                      "{\"status\":\"error\",\"message\":\"Cannot simulate while dispensing\"}");
            return;
        }
        if (!req->hasParam("pump") || !req->hasParam("ml")) {
            req->send(400, "application/json",
                      "{\"status\":\"error\",\"message\":\"Usage: /simulate?pump=1&ml=X\"}");
            return;
        }
        int   pump = req->getParam("pump")->value().toInt();
        float ml   = req->getParam("ml")->value().toFloat();

        if (pump == 1) {
            uint32_t fakePulses = (uint32_t)(ml / ML_PER_PULSE1);
            portENTER_CRITICAL(&pulseMux);
            pulse1Count = fakePulses;
            portEXIT_CRITICAL(&pulseMux);
            Serial.printf("[SIM] Pump 1 — %.2fml → %d pulses  (%.4fml/pulse)\n",
                          ml, fakePulses, ML_PER_PULSE1);
        } else if (pump == 2) {
            uint32_t fakePulses = (uint32_t)(ml / ML_PER_PULSE2);
            portENTER_CRITICAL(&pulseMux);
            pulse2Count = fakePulses;
            portEXIT_CRITICAL(&pulseMux);
            Serial.printf("[SIM] Pump 2 — %.2fml → %d pulses  (%.4fml/pulse)\n",
                          ml, fakePulses, ML_PER_PULSE2);
        } else {
            req->send(400, "application/json",
                      "{\"status\":\"error\",\"message\":\"pump must be 1 or 2\"}");
            return;
        }
        req->send(200, "application/json", "{\"status\":\"simulated\"}");
    });
}


// ============================================================
//  SETUP
// ============================================================
void setup() {
    Serial.begin(115200);

    // Direction pins
    pinMode(PUMP1_IN1, OUTPUT);  digitalWrite(PUMP1_IN1, LOW);
    pinMode(PUMP1_IN2, OUTPUT);  digitalWrite(PUMP1_IN2, LOW);
    pinMode(PUMP2_IN1, OUTPUT);  digitalWrite(PUMP2_IN1, LOW);
    pinMode(PUMP2_IN2, OUTPUT);  digitalWrite(PUMP2_IN2, LOW);

    // LEDC PWM
    ledcSetup(PWM_CHANNEL1, PWM_FREQ, PWM_RESOLUTION);
    ledcAttachPin(PUMP1_EN, PWM_CHANNEL1);
    ledcWrite(PWM_CHANNEL1, 0);

    ledcSetup(PWM_CHANNEL2, PWM_FREQ, PWM_RESOLUTION);
    ledcAttachPin(PUMP2_EN, PWM_CHANNEL2);
    ledcWrite(PWM_CHANNEL2, 0);

    // Flow sensors
    pinMode(FLOW1_SENSOR, INPUT);
    attachInterrupt(digitalPinToInterrupt(FLOW1_SENSOR), onFlow1Pulse, FALLING);

    pinMode(FLOW2_SENSOR, INPUT);
    attachInterrupt(digitalPinToInterrupt(FLOW2_SENSOR), onFlow2Pulse, FALLING);

    // Emergency stop button
    pinMode(BUTTON_PIN, INPUT_PULLUP);
    lastButtonState = HIGH;

    connectWiFi();
    setupRoutes();
    server.begin();

    // ── Boot summary — per-pump calibration printed side by side ──
    Serial.println("─────────────────────────────────────────────────────");
    Serial.println("  AMRDS firmware ready");
    Serial.println("  Calibration:");
    Serial.printf ("    Pump 1 : %.1f pulses/L  →  %.4f ml/pulse  |  debounce %lu ms\n",
                   PUMP1_PULSES_PER_LITRE, ML_PER_PULSE1, PUMP1_DEBOUNCE_US / 1000UL);
    Serial.printf ("    Pump 2 : %.1f pulses/L  →  %.4f ml/pulse  |  debounce %lu ms\n",
                   PUMP2_PULSES_PER_LITRE, ML_PER_PULSE2, PUMP2_DEBOUNCE_US / 1000UL);
    Serial.printf ("  Deadband    : %.1f ml\n", DEADBAND_ML);
    Serial.printf ("  PWM range   : %d – %d\n", PWM_MIN, PWM_MAX);
    Serial.printf ("  PID gains   : Kp=%.3f  Ki=%.4f  Kd=%.3f\n", PID_KP, PID_KI, PID_KD);
    Serial.printf ("  E-Stop btn  : GPIO %d (INPUT_PULLUP, active LOW)\n", BUTTON_PIN);
    Serial.printf ("  Flask       : http://%s:%d\n", FLASK_HOST, FLASK_PORT);
    Serial.println("─────────────────────────────────────────────────────");
}


// ============================================================
//  MAIN LOOP
// ============================================================
void loop() {
    unsigned long now = millis();

    // ── Physical emergency stop button ──────────────────────
    bool currentButtonState = digitalRead(BUTTON_PIN);
    if (currentButtonState == LOW &&
        lastButtonState   == HIGH &&
        (now - lastButtonPress) >= BUTTON_DEBOUNCE_MS) {

        if (pump1.active || pump2.active) {
            lastButtonPress = now;
            Serial.println("[BUTTON] Physical emergency stop triggered!");
            stopAllPumps();
            sequenceComplete = false;
            notifyEmergencyStop("Physical emergency stop button pressed");
        }
    }
    lastButtonState = currentButtonState;

    // ── No-flow auto-halt watchdog ───────────────────────────
    if (pump1.active &&
        lastFlowPulse1Ms > 0 &&
        (now - lastFlowPulse1Ms) >= NO_FLOW_TIMEOUT_MS) {
        Serial.println("[WATCHDOG] Pump 1 — no flow for 15s. Auto-halting.");
        stopAllPumps();
        sequenceComplete = false;
        notifyEmergencyStop("Auto-halt: no flow detected on Pump 1 for 15 seconds");
    }
    if (pump2.active &&
        lastFlowPulse2Ms > 0 &&
        (now - lastFlowPulse2Ms) >= NO_FLOW_TIMEOUT_MS) {
        Serial.println("[WATCHDOG] Pump 2 — no flow for 15s. Auto-halting.");
        stopAllPumps();
        sequenceComplete = false;
        notifyEmergencyStop("Auto-halt: no flow detected on Pump 2 for 15 seconds");
    }

    // ── Safe pulse snapshot ──────────────────────────────────
    portENTER_CRITICAL(&pulseMux);
    uint32_t p1 = pulse1Count;
    uint32_t p2 = pulse2Count;
    portEXIT_CRITICAL(&pulseMux);

    // Each pump uses its own ml/pulse constant
    pump1.dispensedMl = p1 * ML_PER_PULSE1;
    pump2.dispensedMl = p2 * ML_PER_PULSE2;

    // ── PID — Pump 1 ─────────────────────────────────────────
    if (pump1.active) {
        if (pump1.targetMl - pump1.dispensedMl <= DEADBAND_ML) {
            stopPump1();
            if (!pump2.active && !sequenceComplete) {
                sequenceComplete = true;
                notifyComplete();
            }
        } else {
            computePID(pump1, PWM_CHANNEL1);
        }
    }

    // ── PID — Pump 2 ─────────────────────────────────────────
    if (pump2.active) {
        if (pump2.targetMl - pump2.dispensedMl <= DEADBAND_ML) {
            stopPump2();
            if (!sequenceComplete) {
                sequenceComplete = true;
                notifyComplete();
            }
        } else {
            computePID(pump2, PWM_CHANNEL2);
        }
    }

    // ── Progress report → Flask every 500 ms ─────────────────
    if ((pump1.active || pump2.active) &&
        (now - lastReportMs >= REPORT_MS)) {
        lastReportMs = now;
        reportProgress();
    }

    // ── Heartbeat → Flask every 2 s ──────────────────────────
    static unsigned long lastHeartbeat = 0;
    if (now - lastHeartbeat >= HEARTBEAT_MS) {
        lastHeartbeat = now;
        sendHeartbeat();
    }

    // ── WiFi watchdog every 5 s ───────────────────────────────
    static unsigned long lastWifiCheck = 0;
    if (now - lastWifiCheck >= WIFI_WATCHDOG_MS) {
        lastWifiCheck = now;
        maintainWiFi();
        if (pendingComplete && WiFi.status() == WL_CONNECTED) {
            Serial.println("[WiFi] Reconnected — retrying /complete...");
            notifyComplete();
        }
    }

    delay(10);
}
#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <time.h>

// ========= OLED CONFIG (same as your working code) =========
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);

// ========= PINS =========
#define BUTTON_PIN 15       // one side -> GND, other side -> GPIO15

// ========= WIFI / BACKEND =========
const char* ssid     = "JioFiber-wA01K";
const char* password = "Kris0909";
const char* BASE_URL = "http://192.168.29.183:3000";   // your Node backend

// ========= BUTTON DEBOUNCE =========
int lastReading = HIGH;
bool latch = false;
unsigned long lastDebounce = 0;
const unsigned long DEBOUNCE_DELAY = 50;

// ========= ANSWER POLLING STATE =========
bool waitingForReply      = false;
unsigned long lastFetchMs = 0;
const unsigned long FETCH_INTERVAL = 3000;
String lastShownSummary   = "";
String lastSeenTranscript = "";   // ⭐ jisko already dikha chuke

// ========= CLOCK / TIMEOUT STATE (NEW) =========
const long gmtOffset_sec      = 19800;  // +5:30 India
const int  daylightOffset_sec = 0;
bool timeInitialized          = false;

unsigned long lastClockUpdateMs = 0;
const unsigned long CLOCK_UPDATE_INTERVAL = 1000;   // 1s

unsigned long lastAnswerShownMs = 0;
const unsigned long ANSWER_TIMEOUT = 60000;         // 1 min

// -------- helper: centered text (for nice clock) ----------
void drawCenteredText(const String &text, int16_t y, uint8_t size) {
  int16_t x = (SCREEN_WIDTH - (int16_t)text.length() * 6 * size) / 2;
  if (x < 0) x = 0;
  display.setTextSize(size);
  display.setCursor(x, y);
  display.print(text);
}

// -------- helper: idle screen (MODIFIED UI) ----------
void showIdleScreen(const String &ip) {
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);

  // Big time in center
  struct tm timeinfo;
  String timeStr = "--:--";
  if (timeInitialized && getLocalTime(&timeinfo)) {
    char buf[6];
    strftime(buf, sizeof(buf), "%H:%M", &timeinfo);  // HH:MM
    timeStr = String(buf);
  }
  drawCenteredText(timeStr, 16, 3);    // big digital clock

  // Hint text
  display.setTextSize(1);
  drawCenteredText("Press button to ask", 48, 1);

  // Small IP bottom-left
  display.setCursor(0, SCREEN_HEIGHT - 8);
  display.print("IP:");
  display.print(ip);

  display.display();
}

// -------- ROBUST JSON field extractor (AS-IS) -----------
String extractJsonField(const String &json, const String &key) {
  String keyQuoted = "\"" + key + "\"";
  int keyPos = json.indexOf(keyQuoted);
  if (keyPos == -1) return "";

  int colonPos = json.indexOf(':', keyPos);
  if (colonPos == -1) return "";

  int i = colonPos + 1;
  while (i < (int)json.length() && isspace(json[i])) i++;

  if (i >= (int)json.length() || json[i] != '\"') return "";
  int start = i + 1;

  int end = start;
  while (end < (int)json.length()) {
    if (json[end] == '\"' && json[end - 1] != '\\') break;
    end++;
  }
  if (end >= (int)json.length()) return "";

  String out = json.substring(start, end);
  out.replace("\\n", "\n");
  out.replace("\\\"", "\"");
  return out;
}

// -------- send POST /button (AS-IS + small flag) ----------
void sendTriggerToBackend() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("❌ WiFi not connected, cannot trigger");
    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 0);
    display.println("No WiFi.");
    display.println("Check router.");
    display.display();
    delay(1500);
    return;
  }

  HTTPClient http;
  String url = String(BASE_URL) + "/button";
  http.begin(url);
  http.addHeader("Content-Type", "application/json");

  String body = "{\"source\":\"esp32\",\"event\":\"button_pressed\"}";
  Serial.print("POST "); Serial.println(url);
  Serial.print("Body: "); Serial.println(body);

  int code = http.POST(body);
  String resp = (code > 0) ? http.getString() : "";
  Serial.print("HTTP POST code: "); Serial.println(code);
  Serial.print("HTTP POST resp: "); Serial.println(resp);
  http.end();

  // Visual feedback on OLED (SAME)
  display.clearDisplay();
  display.setTextSize(3);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 16);
  if (code == 200 || code == 201) {
    display.println("SENT!");
    waitingForReply = true;
    lastFetchMs     = 0;          // jaldi poll shuru ho
    // NOTE: lastSeenTranscript ko touch NAHI kar rahe yaha
  } else {
    display.println("ERR");
  }
  display.display();
  delay(1200);

  if (WiFi.status() == WL_CONNECTED) {
    display.clearDisplay();
    display.setTextSize(1);
    display.setCursor(0, 0);
    display.println("Call triggered.");
    display.println("Speak on phone.");
    display.println("Waiting for AI...");
    display.display();
  }
}

// -------- GET /latest-answer and show summary (EXACT SAME LOGIC) ----------
void fetchLatestSummaryIfNeeded() {
  if (!waitingForReply) return;
  if (WiFi.status() != WL_CONNECTED) return;

  if (millis() - lastFetchMs < FETCH_INTERVAL) return;
  lastFetchMs = millis();

  HTTPClient http;
  String url = String(BASE_URL) + "/latest-answer";
  http.begin(url);

  int code = http.GET();
  String payload = (code > 0) ? http.getString() : "";
  Serial.print("GET "); Serial.print(url);
  Serial.print(" -> "); Serial.println(code);
  Serial.println("Payload:");
  Serial.println(payload);
  http.end();

  if (code != 200 || payload.length() == 0) {
    Serial.println("No new answer or GET failed");
    return;
  }

  // 0) Transcript check – yahi se decide karenge ki new hai ya purana
  String transcript = extractJsonField(payload, "transcript");
  Serial.print("Parsed transcript: ");
  Serial.println(transcript);

  if (transcript.length() == 0) {
    Serial.println("No transcript field, skipping");
    return;
  }

  // Agar transcript same hai as lastSeenTranscript → purana answer, ignore
  if (transcript == lastSeenTranscript) {
    Serial.println("Same transcript as lastSeenTranscript → still old answer, skipping");
    return;
  }

  // 1) Try direct top-level "summary"
  String summary = extractJsonField(payload, "summary");

  // 2) If not found, get nested "answer" JSON string and parse inside it
  if (summary.length() == 0) {
    String inner = extractJsonField(payload, "answer");
    Serial.println("Inner answer JSON:");
    Serial.println(inner);

    if (inner.length() > 0) {
      summary = extractJsonField(inner, "summary");
      if (summary.length() == 0) {
        String fullAns = extractJsonField(inner, "full_answer");
        if (fullAns.length() > 0) {
          summary = fullAns;
        }
      }
    }
  }

  Serial.print("Parsed summary: ");
  Serial.println(summary);

  if (summary.length() == 0) {
    Serial.println("No summary found even inside 'answer'");
    return;
  }

  // ✅ Now we accept this as NEW answer (EXACTLY LIKE BEFORE)
  waitingForReply     = false;
  lastSeenTranscript  = transcript;
  lastShownSummary    = summary;
  lastAnswerShownMs   = millis();   // ⭐ NEW: for timeout

  // Optional: limit length so it fits roughly on screen
  if (summary.length() > 110) summary = summary.substring(0, 110) + "...";

  // Display on OLED (same style as before)
  display.clearDisplay();
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println("AI Summary:");
  display.println("----------------");
  display.println(summary);
  display.display();

  Serial.println("✅ Summary shown on OLED (new transcript).");
}

// -------- periodic clock + timeout (NEW) ----------
void updateScreensPeriodic() {
  unsigned long now = millis();

  // 1) Agar answer screen dikha rahe hain, 1 minute baad idle pe jao
  if (!waitingForReply && lastShownSummary.length() > 0 && lastAnswerShownMs > 0) {
    if (now - lastAnswerShownMs > ANSWER_TIMEOUT) {
      Serial.println("⏱ Answer timeout → back to idle");
      // Mark as idle
      lastShownSummary  = "";
      lastAnswerShownMs = 0;
      showIdleScreen(WiFi.localIP().toString());
    }
  }

  // 2) Idle mode pe ho (no waiting, no current answer) → clock refresh
  if (!waitingForReply && lastShownSummary.length() == 0 && timeInitialized) {
    if (now - lastClockUpdateMs > CLOCK_UPDATE_INTERVAL) {
      lastClockUpdateMs = now;
      showIdleScreen(WiFi.localIP().toString());
    }
  }
}

// ================== SETUP =======================
void setup() {
  Serial.begin(115200);

  pinMode(BUTTON_PIN, INPUT_PULLUP);

  Wire.begin(21, 22);
  Wire.setClock(100000);

  Serial.println("Init OLED...");
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("OLED init FAILED!");
    while(true);
  }
  Serial.println("OLED init OK");

  display.clearDisplay();
  display.setTextSize(2);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0,10);
  display.println("HELLO");
  display.display();
  delay(1000);

  // WiFi connect (AS-IS)
  Serial.println("Connecting WiFi...");
  WiFi.begin(ssid, password);
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 15000) {
    Serial.print(".");
    delay(300);
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n✅ WiFi Connected");
    Serial.print("IP: "); Serial.println(WiFi.localIP());

    // NTP time (NEW)
    configTime(gmtOffset_sec, daylightOffset_sec,
               "pool.ntp.org", "time.nist.gov");
    struct tm timeinfo;
    if (getLocalTime(&timeinfo)) {
      timeInitialized = true;
      Serial.println("⏰ Time initialized from NTP");
    } else {
      Serial.println("⚠️ Failed to get time from NTP");
    }

    showIdleScreen(WiFi.localIP().toString());
  } else {
    Serial.println("\n⚠️ WiFi FAILED");
    display.clearDisplay();
    display.setTextSize(1);
    display.setCursor(0,0);
    display.println("WiFi failed.");
    display.println("Check SSID/pwd.");
    display.display();
  }
}

// ================== LOOP =======================
void loop() {
  // BUTTON handling (same as your working code)
  int reading = digitalRead(BUTTON_PIN);

  if (reading != lastReading) {
    lastDebounce = millis();
  }

  if ((millis() - lastDebounce) > DEBOUNCE_DELAY) {
    if (reading == LOW && !latch) {
      latch = true;
      Serial.println("🔘 Button press detected");
      sendTriggerToBackend();
    } else if (reading == HIGH && latch) {
      latch = false;
    }
  }

  lastReading = reading;

  // ORIGINAL behaviour for AI answer
  fetchLatestSummaryIfNeeded();

  // NEW: clock + timeout
  updateScreensPeriodic();

  delay(10);
}
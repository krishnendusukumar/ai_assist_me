require("dotenv").config();
const fs = require("fs");
const { execFile } = require("child_process");
const { File } = require("node:buffer");
globalThis.File = File;

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const twilio = require("twilio");
const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const NGROK_BASE_URL = process.env.NGROK_BASE_URL; // e.g. https://abcd.ngrok-free.app

// ========== MEMORY FOR LATEST ANSWER ==========
let lastTranscript = "";
let lastFullAnswer = "";
let lastSummary = "";

function saveLatestAnswer({ transcript, full_answer, summary }) {
  lastTranscript = transcript || "";
  lastFullAnswer = full_answer || "";
  lastSummary = summary || "";
  console.log("💾 Saved latest answer + summary");
}

// ========== SYSTEM PROMPT ==========
const MEDICAL_SYSTEM_PROMPT = `
You are "Sehat Assist" — a personal AI voice assistant designed to make the user’s life easier in every possible way. 
You are speaking to ONE user only (the device owner).

-------------------------
PRIMARY GOALS
-------------------------
- Make the user's life easier instantly, without asking unnecessary questions.
- Understand context quickly: health, tasks, reminders, planning, thinking, motivation, personal decisions.
- Give actionable steps, not vague talk.
- Always reply in simple, clear Hinglish (Latin script only).
- Provide BOTH:
  1) Full detailed answer (for WhatsApp)
  2) Short 1–3 line summary (for small wearable screen)

-------------------------
WHAT YOU MUST AVOID
-------------------------
- You are NOT a doctor or lawyer — do not claim to be.
- No exact medicine names, no dosages.
- No diagnostics or high-risk instructions.

-------------------------
RESPONSE FORMAT (VERY IMPORTANT)
-------------------------
You MUST always return your output in JSON with EXACT keys:

{
  "full_answer": "<long, helpful, detailed explanation here>",
  "summary": "<1–3 line condensed summary for OLED screen>"
}

full_answer max ~10 lines, clear Hinglish, friendly.
summary max 3 short lines, very clear.
`;

// ========== WHATSAPP MESSAGE FORMAT ==========
function formatWhatsAppMessage({ transcript, full_answer }) {
  const t = (transcript || "").trim();
  const a = (full_answer || "").trim();

  return [
    "*🎧 Sehat Assist – AI Helper*",
    "",
    t
      ? `_*Aapka sawal (voice se):*_ \n${t}`
      : "_*Aapka sawal clear nahi mila (audio low / noise).*_",
    "",
    "*Jawab:*",
    a,
    "",
    "_Note: Ye general guidance hai. Serious ya lambi problem ho to turant doctor ya expert se milo._",
  ].join("\n");
}

// ========== AUDIO CONVERSION ==========
function convertUlawToWav(ulawPath, wavPath) {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      ["-y", "-f", "mulaw", "-ar", "8000", "-ac", "1", "-i", ulawPath, wavPath],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

// ========== MAIN AUDIO PIPELINE ==========
async function processCallAudio(streamSid, rawBuffer) {
  try {
    if (!rawBuffer || !rawBuffer.length) {
      console.log(`⚠️ No audio data for stream ${streamSid}, skipping.`);
      return;
    }

    const ulawPath = `call-${streamSid}.ulaw`;
    const wavPath = `call-${streamSid}.wav`;

    await fs.promises.writeFile(ulawPath, rawBuffer);
    console.log(`💾 Saved raw audio to ${ulawPath}`);

    console.log("🎼 Converting to wav...");
    await convertUlawToWav(ulawPath, wavPath);
    console.log(`🎧 Wav ready at ${wavPath}`);

    const audioStream = fs.createReadStream(wavPath);
    const stt = await openai.audio.transcriptions.create({
      file: audioStream,
      model: "gpt-4o-mini-transcribe",
    });

    const transcript = (stt.text || "").trim();
    console.log(`📝 Transcript [${streamSid}]:`, transcript);

    if (!transcript) {
      console.log("⚠️ No speech detected or STT empty, sending 'not clear' message.");
      const fallbackBody = formatWhatsAppMessage({
        transcript: "",
        full_answer:
          "Mujhe aapki baat clear nahi sunai di (audio low / noise). Kripya thoda zor se, shant jagah me phir se try karo.",
      });

      await client.messages.create({
        from: process.env.TWILIO_WHATSAPP_FROM,
        to: process.env.MY_WHATSAPP_NUMBER,
        body: fallbackBody,
      });

      return;
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: MEDICAL_SYSTEM_PROMPT },
        { role: "user", content: transcript },
      ],
    });

    const raw = completion.choices[0].message.content.trim();
    console.log(`🤖 Raw AI answer [${streamSid}]:`, raw);

    let full_answer = "";
    let summary = "";

    try {
      const parsed = JSON.parse(raw);
      full_answer = (parsed.full_answer || "").trim();
      summary = (parsed.summary || "").trim();
    } catch (e) {
      console.warn("⚠️ AI did not return valid JSON, falling back to raw text.");
      full_answer = raw;
      summary =
        raw.length > 120 ? raw.slice(0, 120) + "..." : raw;
    }

    console.log("✅ Parsed full_answer:", full_answer);
    console.log("✅ Parsed summary:", summary);

    // Save for ESP32 /latest-answer
    saveLatestAnswer({ transcript, full_answer, summary });

    // Send full answer to WhatsApp
    const body = formatWhatsAppMessage({ transcript, full_answer });

    const message = await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: process.env.MY_WHATSAPP_NUMBER,
      body,
    });

    console.log("📲 WhatsApp Message SID:", message);
  } catch (err) {
    console.error("Error in processCallAudio:", err);
    try {
      await client.messages.create({
        from: process.env.TWILIO_WHATSAPP_FROM,
        to: process.env.MY_WHATSAPP_NUMBER,
        body:
          "Sehat Assist me kuch technical error aa gaya hai. Thodi der baad phir se try karein. Agar emergency ho to turant doctor ya hospital se contact karein.",
      });
    } catch (e2) {
      console.error("Also failed to send error WhatsApp message:", e2);
    }
  }
}

// ========== ROUTES ==========

app.get("/", (req, res) => {
  res.send("Backend is alive");
});

// ESP32 button -> start call
app.post("/button", async (req, res) => {
  console.log("Button pressed from ESP32:", req.body);

  try {
    const call = await client.calls.create({
      to: process.env.MY_PHONE_NUMBER,
      from: process.env.TWILIO_FROM_NUMBER,
      url: `${NGROK_BASE_URL}/voice`,
    });

    console.log("Call SID:", call.sid);
    res.json({ ok: true, callSid: call.sid });
  } catch (err) {
    console.error("Error placing call:", err);
    res.status(500).json({ error: "Failed to place call" });
  }
});

// TwiML for Twilio voice -> start media stream
app.post("/voice", (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  const wsUrl = NGROK_BASE_URL.replace("https://", "wss://") + "/media";
  twiml.start().stream({ url: wsUrl });

  twiml.say(
    "Hello, I am your AI button assistant. You can start speaking after the beep."
  );
  twiml.pause({ length: 1 });
  twiml.say("Beep.");
  twiml.pause({ length: 60 });

  res.type("text/xml");
  res.send(twiml.toString());
});

// ESP32 polls this for latest summary
app.get("/latest-answer", (req, res) => {
  res.json({
    transcript: lastTranscript,
    full_answer: lastFullAnswer,
    summary: lastSummary,
  });
});

// ========== WEBSOCKET MEDIA STREAM ==========
const streams = new Map();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/media" });

wss.on("connection", (ws, req) => {
  console.log("🔗 Media stream connected");

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.event === "start") {
        console.log("🟢 Stream started:", data.streamSid);
        streams.set(data.streamSid, []);
      } else if (data.event === "media") {
        const chunks = streams.get(data.streamSid);
        if (chunks) {
          chunks.push(data.media.payload); // base64 string
        }
      } else if (data.event === "stop") {
        console.log("🔴 Stream stopped:", data.streamSid);

        const chunks = streams.get(data.streamSid) || [];
        streams.delete(data.streamSid);

        if (chunks.length > 0) {
          const raw = Buffer.concat(
            chunks.map((b64) => Buffer.from(b64, "base64"))
          );
          processCallAudio(data.streamSid, raw);
        } else {
          console.log("No audio chunks collected for this stream.");
        }
      }
    } catch (e) {
      console.error("Error parsing WS message:", e);
    }
  });

  ws.on("close", () => {
    console.log("❌ Media WS closed");
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`HTTP + WS server listening on port ${PORT}`);
});

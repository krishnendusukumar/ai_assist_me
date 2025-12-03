require("dotenv").config();
const fs = require("fs");
const { execFile } = require("child_process");
const { File } = require("node:buffer");
globalThis.File = File;  // Node 18 ke liye File polyfill
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const twilio = require("twilio");
const OpenAI = require("openai");
const { Language } = require("twilio/lib/twiml/VoiceResponse");
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


let lastAnswer = "";
let lastTranscript = "";

function saveLatestAnswer({ transcript, answer, body }) {
  // Jo chaho store karo – main 3 cheezen rakh raha hoon
  lastTranscript = transcript || "";
  lastAnswer = answer || "";
}


const MEDICAL_SYSTEM_PROMPT = `
You are a cautious AI health helper called "Sehat Button".

GOALS
- Give simple, practical health guidance in short, clear Hinglish.
- Always use Latin script only (no Devanagari, Urdu, etc.).
- Sound calm, polite, and supportive.

STYLE
- Reply in 3–5 short sentences.
- Use very simple words and short lines so elder people can read easily.
- Prefer bullet-style or line-breaks instead of long paragraphs.
- Do NOT use emojis unless the user uses them first.

SAFETY & LIMITS (VERY IMPORTANT)
- You are NOT a doctor. Do NOT say or imply that you are a doctor.
- Do NOT prescribe exact medicines, brand names, or dosages.
- You may mention general categories only (e.g. "painkiller", "antacid", "ORS").
- Do NOT give instructions for injections, IV drips, or any medical procedures.
- For chest pain, breathing problems, confusion, severe bleeding, loss of consciousness, or stroke symptoms:
  - Immediately say it may be an EMERGENCY.
  - Tell them to go to the nearest hospital or call local emergency services.
- If symptoms are serious, long-lasting, or unclear:
  - Clearly say that a real doctor visit is needed.

UNKNOWN / LOW CONFIDENCE
- If you are not sure, say "Mujhe exact problem clear nahi hai" and recommend seeing a doctor.
- Never guess dangerous advice just to give an answer.

ENDING LINE (ALWAYS)
- Always end with ONE disclaimer line in Hinglish, e.g.:
  "Ye sirf general health info hai, proper diagnosis ke liye zaroor doctor se milo."
`;



function formatWhatsAppMessage({ transcript, answer }) {
  const trimmedTranscript = (transcript || "").trim();
  const trimmedAnswer = (answer || "").trim();

  return [
    "*🩺 Sehat Button – AI Health Helper*",
    "",
    trimmedTranscript
      ? `_*Aapka sawal (voice se):*_ \n${trimmedTranscript}`
      : "_*Aapka sawal clear nahi mila (audio low / noise).*_",
    "",
    "*Sugges­tion:*",
    trimmedAnswer,
    "",
    "_Note: Ye sirf general health info hai. Koi bhi serious ya lambi problem ho to turant doctor se milo ya nearest hospital jao._",
  ].join("\n");
}



function escapeXml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

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
        answer:
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

    const answer = completion.choices[0].message.content.trim();
    console.log(`🤖 AI answer [${streamSid}]:`, answer);

    
    
    const body = formatWhatsAppMessage({ transcript, answer });
    saveLatestAnswer({ transcript, answer, body });

    const message = await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: process.env.MY_WHATSAPP_NUMBER,
      body,
    });

    console.log("WhatsApp Message SID:", message.sid);
  } catch (err) {
    console.error("Error in processCallAudio:", err);
    // Optional: send a fallback error message to WhatsApp
    try {
      await client.messages.create({
        from: process.env.TWILIO_WHATSAPP_FROM,
        to: process.env.MY_WHATSAPP_NUMBER,
        body:
          "Sehat Button me kuch technical error aa gaya hai. Thodi der baad phir se try karein. Agar emergency ho to turant doctor ya hospital se contact karein.",
      });
    } catch (e2) {
      console.error("Also failed to send error WhatsApp message:", e2);
    }
  }
}






// Simple test route
app.get("/", (req, res) => {
  res.send("Backend is alive");
});

// 🔘 ESP32 button route
app.post("/button", async (req, res) => {
  console.log("Button pressed from ESP32:", req.body);

  try {
    const call = await client.calls.create({
      to: process.env.MY_PHONE_NUMBER,
      from: process.env.TWILIO_FROM_NUMBER,
      // Twilio yahan se poochega: call pe kya karna hai?
      url: `${NGROK_BASE_URL}/voice`,
    });

    console.log("Call SID:", call.sid);
    res.json({ ok: true, callSid: call.sid });
  } catch (err) {
    console.error("Error placing call:", err);
    res.status(500).json({ error: "Failed to place call" });
  }
});

// 📞 Twilio -> yahan TwiML milega (stream start karne ke liye)
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

  // 🔴 Call ko 60 second tak open rakho taaki tum bol sako
  twiml.pause({ length: 60 });

  res.type("text/xml");
  res.send(twiml.toString());
});

app.get("/latest-answer", (req, res) => {
  res.json({
    transcript: lastTranscript,
    answer: lastAnswer,
  });
});

// streamSid -> [base64 audio chunks]
const streams = new Map();

// 🎧 WebSocket server for media stream
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

    // Ab async pipeline chalayenge:
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

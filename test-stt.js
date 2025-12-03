require("dotenv").config();
const fs = require("fs");
const OpenAI = require("openai");
const { File } = require("node:buffer");
globalThis.File = File;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function main() {
  try {
    const wavPath = process.argv[2];
    if (!wavPath) {
      console.error("Usage: node test-stt.js <wav-file>");
      process.exit(1);
    }

    console.log("🎧 Reading audio file:", wavPath);
    const audioData = fs.createReadStream(wavPath);

    const stt = await openai.audio.transcriptions.create({
      file: audioData,
      model: "gpt-4o-mini-transcribe",
    });

    const transcript = stt.text;
    console.log("📝 Transcript:");
    console.log(transcript);

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: "You are a helpful voice assistant." },
        { role: "user", content: transcript },
      ],
    });

    const answer = completion.choices[0].message.content;
    console.log("\n🤖 AI answer:");
    console.log(answer);
  } catch (err) {
    console.error("Error in STT/AI test:", err);
  }
}

main();

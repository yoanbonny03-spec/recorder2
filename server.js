const express = require('express');
const multer = require('multer');
const { OpenAI } = require('openai');
const { google } = require('googleapis');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

const app = express();
const upload = multer({ dest: '/tmp/uploads/' });

// ── Clients ──────────────────────────────────────────────────────────────────

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function getDriveClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });
  return google.drive({ version: 'v3', auth });
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Main upload endpoint
app.post('/upload', upload.single('audio'), async (req, res) => {
  const dealId = req.body.dealId;
  const audioPath = req.file?.path;

  if (!dealId || !audioPath) {
    return res.status(400).json({ error: 'dealId and audio are required' });
  }

  try {
    console.log(`[${dealId}] Starting pipeline...`);

    // 1. Transcribe with Whisper
    console.log(`[${dealId}] Transcribing...`);
    const transcription = await transcribeAudio(audioPath);
    console.log(`[${dealId}] Transcription done: ${transcription.slice(0, 80)}...`);

    // 2. Convert audio to MP3 and upload to Google Drive
    console.log(`[${dealId}] Converting audio to MP3...`);
    const mp3Path = audioPath + '.mp3';
    await convertToMp3(audioPath, mp3Path);
    console.log(`[${dealId}] Uploading audio to Drive...`);
    const audioFileName = `deal_${dealId}_audio_${Date.now()}.mp3`;
    const audioFileId = await uploadToDrive(mp3Path, audioFileName, 'audio/mpeg', process.env.GOOGLE_DRIVE_AUDIO_FOLDER_ID);

    // 3. Upload transcription text to Google Drive
    console.log(`[${dealId}] Uploading transcription to Drive...`);
    const textFileName = `deal_${dealId}_transcription_${Date.now()}.txt`;
    const textPath = `/tmp/uploads/${textFileName}`;
    fs.writeFileSync(textPath, transcription, 'utf8');
    const textFileId = await uploadToDrive(textPath, textFileName, 'text/plain', process.env.GOOGLE_DRIVE_TEXT_FOLDER_ID);

    // 4. Send note to AmoCRM lead
    console.log(`[${dealId}] Sending to AmoCRM...`);
    const driveAudioUrl = `https://drive.google.com/file/d/${audioFileId}/view`;
    const driveTextUrl = `https://drive.google.com/file/d/${textFileId}/view`;
    const noteText = `📝 Транскрипция встречи:\n\n${transcription}\n\n🎵 Аудио: ${driveAudioUrl}\n📄 Текст: ${driveTextUrl}`;
    await sendAmoCrmNote(dealId, noteText);

    // Cleanup temp files
    fs.unlinkSync(audioPath);
    if (fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path);
    fs.unlinkSync(textPath);

    console.log(`[${dealId}] Pipeline complete!`);
    res.json({ success: true, dealId, textFileId, audioFileId });

  } catch (err) {
    console.error(`[${dealId}] Error:`, err.message);
    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    const mp3Cleanup = audioPath + '.mp3';
    if (fs.existsSync(mp3Cleanup)) fs.unlinkSync(mp3Cleanup);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── Helpers ───────────────────────────────────────────────────────────────────

function convertToMp3(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioBitrate(128)
      .toFormat('mp3')
      .on('end', resolve)
      .on('error', reject)
      .save(outputPath);
  });
}

async function transcribeAudio(filePath) {
  const mp3Path = filePath + '.whisper.mp3';
  await convertToMp3(filePath, mp3Path);
  try {
    const response = await openai.audio.transcriptions.create({
      file: fs.createReadStream(mp3Path),
      model: 'whisper-1',
      language: 'ru',
    });
    return response.text;
  } finally {
    if (fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path);
  }
}

async function uploadToDrive(filePath, fileName, mimeType, folderId) {
  const drive = getDriveClient();

  const fileMetadata = {
    name: fileName,
    ...(folderId && { parents: [folderId] }),
  };

  const media = {
    mimeType,
    body: fs.createReadStream(filePath),
  };

  const response = await drive.files.create({
    requestBody: fileMetadata,
    media,
    fields: 'id',
  });

  return response.data.id;
}

async function sendAmoCrmNote(dealId, text) {
  const domain = process.env.AMOCRM_DOMAIN;
  const token = process.env.AMOCRM_ACCESS_TOKEN;

  const url = `https://${domain}/api/v4/leads/${dealId}/notes`;

  await axios.post(
    url,
    [{ note_type: 'common', params: { text } }],
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );
}

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Required env vars:');
  console.log('  OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? '✓' : '✗ MISSING');
  console.log('  GOOGLE_SERVICE_ACCOUNT_JSON:', process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? '✓' : '✗ MISSING');
  console.log('  GOOGLE_DRIVE_AUDIO_FOLDER_ID:', process.env.GOOGLE_DRIVE_AUDIO_FOLDER_ID ? '✓' : '✗ MISSING');
  console.log('  GOOGLE_DRIVE_TEXT_FOLDER_ID:', process.env.GOOGLE_DRIVE_TEXT_FOLDER_ID ? '✓' : '✗ MISSING');
  console.log('  AMOCRM_DOMAIN:', process.env.AMOCRM_DOMAIN ? '✓' : '✗ MISSING');
  console.log('  AMOCRM_ACCESS_TOKEN:', process.env.AMOCRM_ACCESS_TOKEN ? '✓' : '✗ MISSING');
});

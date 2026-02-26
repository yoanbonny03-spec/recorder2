const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const ffmpeg = require('fluent-ffmpeg');

const app = express();

// Ensure upload dir exists
if (!fs.existsSync('/tmp/uploads/')) {
  fs.mkdirSync('/tmp/uploads/', { recursive: true });
}

const upload = multer({ dest: '/tmp/uploads/' });

// ── Clients ──────────────────────────────────────────────────────────────────

function getDriveClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });
  return google.drive({ version: 'v3', auth });
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/upload', upload.single('audio'), async (req, res) => {
  const dealId = req.body.dealId;
  const audioPath = req.file?.path;
  const mimetype = req.file?.mimetype || 'audio/webm';

  if (!dealId || !audioPath) {
    return res.status(400).json({ error: 'dealId and audio are required' });
  }

  const mp3Path = audioPath + '.mp3';

  try {
    console.log(`[${dealId}] Starting pipeline... mime=${mimetype}`);

    // 1. Transcribe with Whisper via direct API call (explicit filename)
    console.log(`[${dealId}] Transcribing...`);
    const transcription = await transcribeAudio(audioPath, mimetype);
    console.log(`[${dealId}] Transcription done: ${transcription.slice(0, 80)}...`);

    // 2. Convert to MP3 and upload to Google Drive
    console.log(`[${dealId}] Converting to MP3...`);
    await convertToMp3(audioPath, mp3Path);
    console.log(`[${dealId}] Uploading audio to Drive...`);
    const audioFileName = `deal_${dealId}_audio_${Date.now()}.mp3`;
    const audioFileId = await uploadToDrive(mp3Path, audioFileName, 'audio/mpeg', process.env.GOOGLE_DRIVE_AUDIO_FOLDER_ID);

    // 3. Upload transcription to Google Drive
    console.log(`[${dealId}] Uploading transcription to Drive...`);
    const textFileName = `deal_${dealId}_transcription_${Date.now()}.txt`;
    const textPath = `/tmp/uploads/${textFileName}`;
    fs.writeFileSync(textPath, transcription, 'utf8');
    const textFileId = await uploadToDrive(textPath, textFileName, 'text/plain', process.env.GOOGLE_DRIVE_TEXT_FOLDER_ID);

    // 4. Send note to AmoCRM
    console.log(`[${dealId}] Sending to AmoCRM...`);
    const driveAudioUrl = `https://drive.google.com/file/d/${audioFileId}/view`;
    const driveTextUrl = `https://drive.google.com/file/d/${textFileId}/view`;
    const noteText = `📝 Транскрипция встречи:\n\n${transcription}\n\n🎵 Аудио: ${driveAudioUrl}\n📄 Текст: ${driveTextUrl}`;
    await sendAmoCrmNote(dealId, noteText);

    // Cleanup
    fs.unlinkSync(audioPath);
    if (fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path);
    fs.unlinkSync(textPath);

    console.log(`[${dealId}] Pipeline complete!`);
    res.json({ success: true, dealId, textFileId, audioFileId });

  } catch (err) {
    console.error(`[${dealId}] Error:`, err.message);
    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    if (fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── Helpers ───────────────────────────────────────────────────────────────────

function mimeToExt(mime) {
  if (mime.includes('mp4') || mime.includes('m4a')) return 'mp4';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  return 'webm';
}

// Call Whisper via REST API directly — explicit filename so format is always detected
async function transcribeAudio(filePath, mimetype) {
  const ext = mimeToExt(mimetype);
  const filename = `audio.${ext}`;
  console.log(`  whisper filename=${filename} contentType=${mimetype}`);

  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), { filename, contentType: mimetype });
  form.append('model', 'whisper-1');
  form.append('language', 'ru');

  const { data } = await axios.post(
    'https://api.openai.com/v1/audio/transcriptions',
    form,
    {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
    }
  );
  return data.text;
}

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

async function uploadToDrive(filePath, fileName, mimeType, folderId) {
  const drive = getDriveClient();
  const response = await drive.files.create({
    requestBody: {
      name: fileName,
      ...(folderId && { parents: [folderId] }),
    },
    media: {
      mimeType,
      body: fs.createReadStream(filePath),
    },
    fields: 'id',
  });
  return response.data.id;
}

async function sendAmoCrmNote(dealId, text) {
  const domain = process.env.AMOCRM_DOMAIN;
  const token = process.env.AMOCRM_ACCESS_TOKEN;
  await axios.post(
    `https://${domain}/api/v4/leads/${dealId}/notes`,
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
  console.log(`Server v2 running on port ${PORT}`);
  console.log('  OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? '✓' : '✗ MISSING');
  console.log('  GOOGLE_SERVICE_ACCOUNT_JSON:', process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? '✓' : '✗ MISSING');
  console.log('  GOOGLE_DRIVE_AUDIO_FOLDER_ID:', process.env.GOOGLE_DRIVE_AUDIO_FOLDER_ID ? '✓' : '✗ MISSING');
  console.log('  GOOGLE_DRIVE_TEXT_FOLDER_ID:', process.env.GOOGLE_DRIVE_TEXT_FOLDER_ID ? '✓' : '✗ MISSING');
  console.log('  AMOCRM_DOMAIN:', process.env.AMOCRM_DOMAIN ? '✓' : '✗ MISSING');
  console.log('  AMOCRM_ACCESS_TOKEN:', process.env.AMOCRM_ACCESS_TOKEN ? '✓' : '✗ MISSING');
});

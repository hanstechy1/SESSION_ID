require('dotenv').config();
const express = require('express');
const cors = require('cors');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const { MongoClient } = require('mongodb');
const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGODB_URI;

let dbClient = null;

async function getCollection() {
  if (!MONGO_URI) {
    throw new Error('MONGODB_URI is not set in environment variables.');
  }
  if (!dbClient) {
    dbClient = new MongoClient(MONGO_URI);
    await dbClient.connect();
  }
  return dbClient.db('hans_techy_bot').collection('sessions');
}

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    status: 'ONLINE',
    service: 'HANS TECHY V2 Session Generator',
    version: '2.0.0'
  });
});

app.get('/pair', async (req, res) => {
  const rawNumber = (req.query.number || '').toString().replace(/\D/g, '');

  if (!rawNumber || rawNumber.length < 10 || rawNumber.length > 15) {
    return res.status(400).json({ error: 'Valid phone number with country code is required.' });
  }

  if (!MONGO_URI) {
    return res.status(500).json({ error: 'Database is not configured.' });
  }

  const tempSessionId = `pair_${rawNumber}_${Date.now()}`;
  const sessionDir = path.join(__dirname, 'temp_sessions', tempSessionId);
  await fs.ensureDir(sessionDir);

  let hasResponded = false;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({
      version: [2, 3000, 1017531234]
    }));

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['HANS TECHY V2', 'Chrome', '20.0.04'],
      syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        try {
          const credsPath = path.join(sessionDir, 'creds.json');
          if (await fs.pathExists(credsPath)) {
            const credsData = await fs.readJson(credsPath);
            const token32 = crypto.randomBytes(16).toString('hex');

            const col = await getCollection();
            await col.updateOne(
              { _id: token32 },
              {
                $set: {
                  _id: token32,
                  creds: credsData,
                  phone: rawNumber,
                  createdAt: new Date()
                }
              },
              { upsert: true }
            );

            const sessionCode = `HANS TECHY~${token32}`;
            const userJid = `${rawNumber}@s.whatsapp.net`;

            const messageText = `╭─━─━「 *HANS TECHY V2* 」─━─━
│ 🌟 *SESSION GENERATED SUCCESSFULLY*
│
│ 🔑 *Session ID:*
│ \`\`\`${sessionCode}\`\`\`
│
│ ⚠️ *Keep this ID safe and private!*
│ 🚀 Paste this into Heroku Config Vars as:
│ *SESSION_ID*
╰─━─━─━─━─━─━─━─━─━─━─━─━─━`;

            await sock.sendMessage(userJid, { text: messageText });
            await sock.ws.close();
            await fs.remove(sessionDir).catch(() => {});
            console.log(`[GENERATOR] Stored session for: ${rawNumber}`);
          }
        } catch (saveErr) {
          console.error('[GENERATOR SAVE ERROR]:', saveErr.message);
        }
      }

      if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        if (reason === DisconnectReason.loggedOut) {
          await fs.remove(sessionDir).catch(() => {});
        }
      }
    });

    if (!sock.authState.creds.registered) {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(rawNumber);
          if (!hasResponded) {
            hasResponded = true;
            return res.json({
              status: true,
              code: code?.match(/.{1,4}/g)?.join('-') || code
            });
          }
        } catch (pairErr) {
          if (!hasResponded) {
            hasResponded = true;
            return res.status(500).json({ error: 'Failed to request pairing code. Try again.' });
          }
        }
      }, 3000);
    } else {
      if (!hasResponded) {
        hasResponded = true;
        return res.status(400).json({ error: 'This session is already registered.' });
      }
    }
  } catch (err) {
    await fs.remove(sessionDir).catch(() => {});
    if (!hasResponded) {
      return res.status(500).json({ error: err.message });
    }
  }
});

app.get('/session', async (req, res) => {
  const rawId = (req.query.id || '').toString().trim();

  if (!rawId || rawId.length !== 32 || !/^[a-f0-9]{32}$/i.test(rawId)) {
    return res.status(400).json({ error: 'Invalid or malformed session ID format.' });
  }

  try {
    const col = await getCollection();
    const record = await col.findOne({ _id: rawId.toLowerCase() });

    if (!record || !record.creds) {
      return res.status(404).json({ error: 'Session not found or has expired.' });
    }

    return res.json(record.creds);
  } catch (err) {
    console.error('[API SESSION FETCH ERROR]:', err.message);
    return res.status(500).json({ error: 'Failed to fetch session.' });
  }
});

app.listen(PORT, () => {
  console.log(`[GENERATOR] Server running on port ${PORT}`);
});


const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const pino = require('pino');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  Browsers,
  DisconnectReason,
  delay,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.SESSION_STORE_TOKEN;
const logger = pino({ level: 'silent' });

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : undefined
    })
  : null;

const activeJobs = new Set();

async function initializeDatabase() {
  if (!pool) throw new Error('DATABASE_URL is required.');
  if (!API_SECRET) throw new Error('SESSION_STORE_TOKEN is required.');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS hans_sessions (
      id VARCHAR(32) PRIMARY KEY,
      auth_state JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ DEFAULT
        (NOW() + INTERVAL '90 days')
    )
  `);
}

function protectAPI(req, res, next) {
  const authorization = req.get('authorization') || '';

  if (!API_SECRET ||
      authorization !== `Bearer ${API_SECRET}`) {
    return res.status(401).json({
      error: 'Unauthorized'
    });
  }

  next();
}

async function saveShortSession(directory) {
  const files = {};

  async function collect(folder, prefix = '') {
    const entries = await fs.readdir(folder, {
      withFileTypes: true
    });

    for (const entry of entries) {
      const fullPath = path.join(folder, entry.name);
      const relativePath = path.posix.join(
        prefix,
        entry.name
      );

      if (entry.isDirectory()) {
        await collect(fullPath, relativePath);
      } else if (entry.isFile()) {
        files[relativePath] = await fs.readFile(
          fullPath,
          'utf8'
        );
      }
    }
  }

  await collect(directory);

  if (!files['creds.json']) {
    throw new Error('creds.json is missing.');
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const id = crypto.randomBytes(8)
      .toString('base64url')
      .toUpperCase();

    try {
      await pool.query(
        `INSERT INTO hans_sessions (id, auth_state)
         VALUES ($1, $2::jsonb)`,
        [id, JSON.stringify(files)]
      );

      return id;
    } catch (error) {
      if (error.code !== '23505') throw error;
    }
  }

  throw new Error('Could not generate Session ID.');
}

async function startPairing(id, options, attempt = 0) {
  const directory = path.join(
    __dirname,
    'temp',
    id
  );

  await fs.ensureDir(directory);

  const { state, saveCreds } =
    await useMultiFileAuthState(directory);

  const { version } =
    await fetchLatestBaileysVersion();

  const socket = makeWASocket({
    version,
    auth: state,
    logger,
    browser: Browsers.macOS('Chrome'),
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false
  });

  socket.ev.on('creds.update', saveCreds);

  socket.ev.on('connection.update', async update => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && options.onQR) {
      options.onQR(qr);
      options.onQR = null;
    }

    if (connection === 'open') {
      if (options.completed) return;
      options.completed = true;

      try {
        await delay(2000);

        const sessionId = await saveShortSession(
          directory
        );

        const jid =
          socket.user.id.split(':')[0] +
          '@s.whatsapp.net';

        await socket.sendMessage(jid, {
          text: `HANS TECHY~${sessionId}`
        });

        await socket.sendMessage(jid, {
          text:
            '*HANS TECHY SESSION CONNECTED* ✅\n\n' +
            'Your session has been saved securely.\n' +
            'Keep your Session ID private.'
        });

        if (options.onSaved) {
          options.onSaved(sessionId);
        }
      } catch (error) {
        console.error(
          'Session save error:',
          error.message
        );
      } finally {
        await delay(2000);

        try {
          socket.end();
        } catch {}

        await fs.remove(directory);
        activeJobs.delete(id);
      }
    }

    if (connection === 'close' && !options.completed) {
      const status =
        lastDisconnect?.error?.output?.statusCode;

      const loggedOut =
        status === DisconnectReason.loggedOut;

      if (!loggedOut && attempt < 3) {
        await delay(3000);
        return startPairing(id, options, attempt + 1);
      }

      if (options.onError) {
        options.onError(
          new Error('WhatsApp connection closed.')
        );
      }

      await fs.remove(directory);
      activeJobs.delete(id);
    }
  });

  if (options.number && !state.creds.registered) {
    await delay(3000);

    const code = await socket.requestPairingCode(
      options.number
    );

    if (options.onCode) {
      options.onCode(code);
    }
  }
}

app.get('/', (req, res) => {
  res.json({
    name: 'HANS TECHY SESSION ENGINE',
    status: 'online',
    features: [
      'Pair Code',
      'QR Code',
      'Short Session ID',
      'PostgreSQL Storage'
    ]
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// Generate Pair Code
app.get('/pair', async (req, res) => {
  const number = String(
    req.query.number || ''
  ).replace(/\D/g, '');

  if (!/^[1-9]\d{7,14}$/.test(number)) {
    return res.status(400).json({
      error: 'Enter a valid WhatsApp number with country code.'
    });
  }

  if (!pool || !API_SECRET) {
    return res.status(503).json({
      error: 'Session storage is not configured.'
    });
  }

  const id = `pair_${crypto.randomUUID()}`;

  if (activeJobs.has(id)) {
    return res.status(409).json({
      error: 'Pairing already running.'
    });
  }

  activeJobs.add(id);

  let replied = false;

  const reply = (status, data) => {
    if (replied) return;
    replied = true;
    if (!res.headersSent) res.status(status).json(data);
  };

  const timeout = setTimeout(() => {
    reply(504, { error: 'Pairing request timed out.' });
  }, 30000);

  startPairing(id, {
    number,
    onCode: code => {
      clearTimeout(timeout);
      reply(200, {
        code: code.match(/.{1,4}/g).join('-')
      });
    },
    onError: error => {
      clearTimeout(timeout);
      reply(500, { error: error.message });
    }
  }).catch(error => {
    clearTimeout(timeout);
    console.error('Pair error:', error.message);
    reply(500, { error: 'Pairing failed.' });
    activeJobs.delete(id);
  });
});

// Generate QR Code
app.get('/qr', async (req, res) => {
  if (!pool || !API_SECRET) {
    return res.status(503).json({
      error: 'Session storage is not configured.'
    });
  }

  const id = `qr_${crypto.randomUUID()}`;

  activeJobs.add(id);

  let replied = false;

  const reply = (status, data) => {
    if (replied) return;
    replied = true;
    if (!res.headersSent) res.status(status).json(data);
  };

  const timeout = setTimeout(() => {
    reply(504, { error: 'QR request timed out.' });
  }, 30000);

  startPairing(id, {
    onQR: qr => {
      clearTimeout(timeout);
      reply(200, { qr });
    },
    onError: error => {
      clearTimeout(timeout);
      reply(500, { error: error.message });
    }
  }).catch(error => {
    clearTimeout(timeout);
    console.error('QR error:', error.message);
    reply(500, { error: 'QR generation failed.' });
    activeJobs.delete(id);
  });
});

// Update existing session
app.put('/session/:id', protectAPI, async (req, res) => {
  try {
    const id = String(req.params.id || '')
      .toUpperCase();

    const files = req.body?.files;

    if (!/^[A-Z0-9_-]{6,32}$/.test(id) ||
        !files ||
        typeof files !== 'object' ||
        Array.isArray(files) ||
        typeof files['creds.json'] !== 'string') {
      return res.status(400).json({
        error: 'Invalid session data.'
      });
    }

    const result = await pool.query(
      `UPDATE hans_sessions
       SET auth_state = $2::jsonb,
           expires_at = NOW() + INTERVAL '90 days'
       WHERE id = $1`,
      [id, JSON.stringify(files)]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: 'Session not found.'
      });
    }

    res.json({ saved: true });
  } catch (error) {
    console.error('Session update:', error.message);
    res.status(500).json({
      error: 'Session update failed.'
    });
  }
});

// Restore complete session
app.get('/session/:id', protectAPI, async (req, res) => {
  try {
    const id = String(req.params.id || '')
      .toUpperCase();

    if (!/^[A-Z0-9_-]{6,32}$/.test(id)) {
      return res.status(400).json({
        error: 'Invalid Session ID.'
      });
    }

    const result = await pool.query(
      `SELECT auth_state
       FROM hans_sessions
       WHERE id = $1 AND expires_at > NOW()`,
      [id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: 'Session not found or expired.'
      });
    }

    res.set('Cache-Control', 'no-store');

    res.json({
      files: result.rows[0].auth_state
    });
  } catch (error) {
    console.error('Session restore:', error.message);
    res.status(500).json({
      error: 'Session restore failed.'
    });
  }
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(
        `HANS TECHY SESSION ENGINE running on ${PORT}`
      );
    });
  })
  .catch(error => {
    console.error(
      'Startup failed:',
      error.message
    );
    process.exit(1);
  });

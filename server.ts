import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';

const PORT = 3000;
const ROOT_DIR = process.cwd();
const UPLOAD_DIR = path.resolve(ROOT_DIR, 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Load Firebase Project ID from firebase-applet-config.json
let firebaseProjectId = '';
try {
  const cfgRaw = fs.readFileSync(path.resolve(ROOT_DIR, 'firebase-applet-config.json'), 'utf-8');
  const cfg = JSON.parse(cfgRaw) as { projectId?: string };
  firebaseProjectId = cfg.projectId || '';
} catch {
  console.warn('firebase-applet-config.json not found during server boot.');
}

// --- Firebase ID Token Verification (Zero-IAM Google x509 Certs) ---
interface CertCache {
  certs: Record<string, string>;
  expiresAtMs: number;
}

let certCache: CertCache = { certs: {}, expiresAtMs: 0 };

async function getGoogleCerts(): Promise<Record<string, string>> {
  if (Date.now() < certCache.expiresAtMs && Object.keys(certCache.certs).length > 0) {
    return certCache.certs;
  }
  const resp = await fetch(
    'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'
  );
  if (!resp.ok) {
    throw new Error(`Failed to fetch Google x509 certs: ${resp.status}`);
  }
  const cacheControl = resp.headers.get('cache-control') || '';
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
  const maxAgeSec = maxAgeMatch ? Number(maxAgeMatch[1]) : 3600;
  const certs = (await resp.json()) as Record<string, string>;
  certCache = {
    certs,
    expiresAtMs: Date.now() + maxAgeSec * 1000,
  };
  return certs;
}

function decodeBase64Url(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + '='.repeat(padLen), 'base64');
}

interface VerifiedTokenPayload {
  uid: string;
  email?: string;
  emailVerified: boolean;
}

async function verifyFirebaseIdToken(idToken: string): Promise<VerifiedTokenPayload> {
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed JWT');
  }
  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(decodeBase64Url(headerB64).toString('utf-8')) as {
    alg?: string;
    kid?: string;
  };
  const payload = JSON.parse(decodeBase64Url(payloadB64).toString('utf-8')) as {
    aud?: string;
    iss?: string;
    sub?: string;
    exp?: number;
    iat?: number;
    email?: string;
    email_verified?: boolean;
  };

  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('Invalid JWT algorithm or key ID');
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp <= nowSec) {
    throw new Error('Token expired');
  }
  if (!payload.sub || payload.sub.length > 128) {
    throw new Error('Invalid subject');
  }
  if (firebaseProjectId) {
    if (payload.aud !== firebaseProjectId) {
      throw new Error('Audience mismatch');
    }
    if (payload.iss !== `https://securetoken.google.com/${firebaseProjectId}`) {
      throw new Error('Issuer mismatch');
    }
  }

  const certs = await getGoogleCerts();
  const certPem = certs[header.kid];
  if (!certPem) {
    throw new Error('Unknown signing key');
  }

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();
  const isValid = verifier.verify(certPem, decodeBase64Url(sigB64));
  if (!isValid) {
    throw new Error('Invalid JWT signature');
  }

  return {
    uid: payload.sub,
    email: payload.email,
    emailVerified: Boolean(payload.email_verified),
  };
}

// --- Allowed Media Types ---
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'audio/webm': '.webm',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
};

const SAFE_FILENAME_RE = /^[a-zA-Z0-9_-]{8,96}\.[a-z0-9]{2,5}$/;

// --- Express App & HTTP Server ---
const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, timestamp: Date.now() });
});

// Authenticated Media Upload Endpoint (Images, Voice Notes, 15s-60s Reels, Verification Docs)
app.post(
  '/api/media/upload',
  express.raw({ type: '*/*', limit: '55mb' }),
  async (req, res) => {
    try {
      const authHeader = req.headers.authorization || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      if (!token) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const verified = await verifyFirebaseIdToken(token);
      if (!verified.emailVerified) {
        res.status(403).json({ error: 'Verified account required' });
        return;
      }

      const rawMime = String(req.headers['x-file-mime'] || 'application/octet-stream')
        .split(';')[0]
        .trim()
        .toLowerCase();
      const ext = MIME_TO_EXT[rawMime];
      if (!ext) {
        res.status(400).json({ error: 'Unsupported media format' });
        return;
      }

      const category = String(req.headers['x-media-category'] || 'general').trim();
      if (category === 'reel') {
        const duration = Number(req.headers['x-reel-duration'] || 0);
        if (!Number.isFinite(duration) || duration < 15 || duration > 60) {
          res.status(400).json({
            error: 'Reel duration must be strictly between 15 and 60 seconds',
          });
          return;
        }
      }

      const bodyBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (bodyBuffer.length === 0 || bodyBuffer.length > 52 * 1024 * 1024) {
        res.status(400).json({ error: 'File size must be between 1 byte and 52 MB' });
        return;
      }

      const randomName = `${verified.uid.slice(0, 12)}_${Date.now()}_${crypto
        .randomBytes(6)
        .toString('hex')}${ext}`;
      const targetPath = path.resolve(UPLOAD_DIR, randomName);
      if (!targetPath.startsWith(UPLOAD_DIR + path.sep)) {
        res.status(400).json({ error: 'Invalid file destination' });
        return;
      }

      await fs.promises.writeFile(targetPath, bodyBuffer);
      res.json({
        url: `/api/media/${randomName}`,
        mime: rawMime,
        size: bodyBuffer.length,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed';
      res.status(401).json({ error: msg });
    }
  }
);

// Media Streaming Endpoint with HTTP Range Support (for instant 15s-60s Reels playback)
app.get('/api/media/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    if (!SAFE_FILENAME_RE.test(filename)) {
      res.status(400).json({ error: 'Invalid media identifier' });
      return;
    }

    const filePath = path.resolve(UPLOAD_DIR, filename);
    if (!filePath.startsWith(UPLOAD_DIR + path.sep)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat || !stat.isFile()) {
      res.status(404).json({ error: 'Media not found' });
      return;
    }

    const ext = path.extname(filename).toLowerCase();
    const contentType =
      Object.entries(MIME_TO_EXT).find(([, e]) => e === ext)?.[0] ||
      'application/octet-stream';

    const fileSize = stat.size;
    const range = req.headers.range;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=86400');

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = Number.parseInt(parts[0], 10);
      const end = parts[1] ? Number.parseInt(parts[1], 10) : fileSize - 1;
      if (
        Number.isNaN(start) ||
        Number.isNaN(end) ||
        start < 0 ||
        end >= fileSize ||
        start > end
      ) {
        res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
        return;
      }
      const chunkSize = end - start + 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', chunkSize);
      res.setHeader('Content-Type', contentType);
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }

    res.setHeader('Content-Length', fileSize);
    res.setHeader('Content-Type', contentType);
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.status(500).json({ error: 'Failed to stream media' });
  }
});

// --- WebSocket Real-Time Presence, Typing & WebRTC Signaling Server ---
interface AuthedSocket extends WebSocket {
  uid?: string;
  isAlive?: boolean;
}

const wss = new WebSocketServer({ server, path: '/ws' });
const onlineSockets = new Map<string, Set<AuthedSocket>>();

function sendToUser(targetUid: string, event: Record<string, unknown>): void {
  const sockets = onlineSockets.get(targetUid);
  if (!sockets) return;
  const serialized = JSON.stringify(event);
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(serialized);
    }
  }
}

function broadcastPresence(): void {
  const onlineIds = Array.from(onlineSockets.keys());
  const payload = JSON.stringify({ type: 'presence:list', onlineIds });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && (client as AuthedSocket).uid) {
      client.send(payload);
    }
  }
}

wss.on('connection', (ws: AuthedSocket) => {
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as {
        type: string;
        token?: string;
        targetUserIds?: string[];
        targetUid?: string;
        chatId?: string;
        callId?: string;
        callType?: 'audio' | 'video' | 'group';
        callerName?: string;
        callerAvatar?: string;
        offer?: unknown;
        answer?: unknown;
        candidate?: unknown;
        isTyping?: boolean;
      };

      if (msg.type === 'auth' && msg.token) {
        const verified = await verifyFirebaseIdToken(msg.token);
        ws.uid = verified.uid;
        if (!onlineSockets.has(verified.uid)) {
          onlineSockets.set(verified.uid, new Set());
        }
        onlineSockets.get(verified.uid)!.add(ws);
        ws.send(JSON.stringify({ type: 'auth:ok', uid: verified.uid }));
        broadcastPresence();
        return;
      }

      if (!ws.uid) {
        ws.send(JSON.stringify({ type: 'error', message: 'Unauthenticated' }));
        return;
      }

      if (msg.type === 'typing' && Array.isArray(msg.targetUserIds) && msg.chatId) {
        for (const targetId of msg.targetUserIds) {
          if (targetId !== ws.uid) {
            sendToUser(targetId, {
              type: 'typing',
              chatId: msg.chatId,
              senderId: ws.uid,
              isTyping: Boolean(msg.isTyping),
            });
          }
        }
        return;
      }

      // WebRTC Call Signaling
      if (msg.type === 'call:invite' && Array.isArray(msg.targetUserIds)) {
        for (const targetId of msg.targetUserIds) {
          if (targetId !== ws.uid) {
            sendToUser(targetId, {
              type: 'call:invite',
              callId: msg.callId,
              chatId: msg.chatId,
              callType: msg.callType || 'video',
              callerId: ws.uid,
              callerName: msg.callerName || 'User',
              callerAvatar: msg.callerAvatar || '',
            });
          }
        }
        return;
      }

      if (
        (msg.type === 'call:accept' ||
          msg.type === 'call:decline' ||
          msg.type === 'call:end' ||
          msg.type === 'webrtc:offer' ||
          msg.type === 'webrtc:answer' ||
          msg.type === 'webrtc:ice-candidate') &&
        msg.targetUid
      ) {
        sendToUser(msg.targetUid, {
          ...msg,
          senderId: ws.uid,
        });
      }
    } catch {
      // Ignore malformed WebSocket payloads cleanly
    }
  });

  ws.on('close', () => {
    if (ws.uid && onlineSockets.has(ws.uid)) {
      const set = onlineSockets.get(ws.uid)!;
      set.delete(ws);
      if (set.size === 0) {
        onlineSockets.delete(ws.uid);
      }
      broadcastPresence();
    }
  });
});

// Heartbeat interval to prune stale sockets
const heartbeatInterval = setInterval(() => {
  for (const client of wss.clients) {
    const ws = client as AuthedSocket;
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

wss.on('close', () => clearInterval(heartbeatInterval));

async function start(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(ROOT_DIR, 'dist');
    app.use(express.static(distDir));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.resolve(distDir, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Alap server running on http://0.0.0.0:${PORT}`);
  });
}

start();

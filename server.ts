import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import {
  FREE_TIER_LIMITS,
  FreeTierQuotaManager,
  deleteObjectFromR2,
  getObjectFromR2,
  getR2Config,
  headObjectInR2,
  putObjectToR2,
} from './server/r2Storage.ts';

const PORT = Number(process.env.PORT) || 3000;
const ROOT_DIR = process.cwd();
const UPLOAD_DIR = path.resolve(ROOT_DIR, 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const quotaManager = new FreeTierQuotaManager(UPLOAD_DIR);

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
  'application/pdf': '.pdf',
};

const SAFE_FILENAME_RE = /^[a-zA-Z0-9_-]{8,96}\.[a-z0-9]{2,5}$/;

// --- Express App & HTTP Server ---
const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

app.use(express.json({ limit: '2mb' }));

app.use((_req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
  next();
});

app.use('/api', (_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    timestamp: Date.now(),
    uptimeSeconds: Math.round(process.uptime()),
    nodeVersion: process.version,
    env: process.env.NODE_ENV || 'development',
  });
});

interface IceConfigResult {
  iceServers: { urls: string | string[]; username?: string; credential?: string }[];
  iceCandidatePoolSize: number;
  turnConfigured: boolean;
  turnProvider: 'static' | 'cloudflare-calls' | 'none';
}

let cachedCfTurn: {
  iceServers: { urls: string | string[]; username?: string; credential?: string }[];
  expiresAtMs: number;
} | null = null;

async function buildIceServersConfig(): Promise<IceConfigResult> {
  const iceServers: { urls: string | string[]; username?: string; credential?: string }[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.cloudflare.com:53' },
  ];

  const turnUrls = (process.env.TURN_URLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const turnUsername = (process.env.TURN_USERNAME || '').trim();
  const turnCredential = (process.env.TURN_CREDENTIAL || '').trim();

  if (turnUrls.length > 0 && turnUsername && turnCredential) {
    iceServers.push({
      urls: turnUrls,
      username: turnUsername,
      credential: turnCredential,
    });
    return {
      iceServers,
      iceCandidatePoolSize: 4,
      turnConfigured: true,
      turnProvider: 'static',
    };
  }

  // Optional Cloudflare Calls Free-Tier TURN (1 TB/month free)
  const cfTurnTokenId = (process.env.CLOUDFLARE_TURN_TOKEN_ID || '').trim();
  const cfTurnApiToken = (process.env.CLOUDFLARE_TURN_API_TOKEN || '').trim();
  if (cfTurnTokenId && cfTurnApiToken) {
    if (cachedCfTurn && Date.now() < cachedCfTurn.expiresAtMs) {
      iceServers.push(...cachedCfTurn.iceServers);
      return {
        iceServers,
        iceCandidatePoolSize: 4,
        turnConfigured: true,
        turnProvider: 'cloudflare-calls',
      };
    }

    try {
      const cfResp = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(cfTurnTokenId)}/credentials/generate`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cfTurnApiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ttl: 86400 }),
        }
      );
      if (cfResp.ok) {
        const cfData = (await cfResp.json()) as {
          iceServers?: { urls: string | string[]; username?: string; credential?: string };
        };
        if (cfData.iceServers) {
          cachedCfTurn = {
            iceServers: [cfData.iceServers],
            expiresAtMs: Date.now() + 6 * 3600_000,
          };
          iceServers.push(cfData.iceServers);
          return {
            iceServers,
            iceCandidatePoolSize: 4,
            turnConfigured: true,
            turnProvider: 'cloudflare-calls',
          };
        }
      }
    } catch {
      // Continue gracefully with multi-region STUN servers
    }
  }

  return {
    iceServers,
    iceCandidatePoolSize: 4,
    turnConfigured: false,
    turnProvider: 'none',
  };
}

// Balanced WebRTC ICE/STUN/TURN Configuration Endpoint
app.get('/api/rtc/ice-servers', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!token) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    await verifyFirebaseIdToken(token);
    res.json(await buildIceServersConfig());
  } catch {
    res.status(401).json({ error: 'Invalid authentication token' });
  }
});

// Unified Server & Free-Tier Guardrail Status Endpoint
app.get('/api/system/status', async (req, res) => {
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

    const r2 = getR2Config();
    const quota = quotaManager.getSnapshot();
    const rtc = await buildIceServersConfig();
    const isRender = Boolean(process.env.RENDER || process.env.RENDER_EXTERNAL_URL);

    res.json({
      hosting: {
        platform: isRender ? 'Render Web Service (Free Tier)' : 'Alap Node Server',
        nodeVersion: process.version,
        port: PORT,
        uptimeSeconds: Math.round(process.uptime()),
        environment: process.env.NODE_ENV || 'development',
        externalUrl: process.env.RENDER_EXTERNAL_URL || '',
      },
      r2: {
        accountId: r2.accountId,
        bucket: r2.bucket,
        endpoint: r2.endpoint,
        mode: r2.configured ? 'cloudflare-r2' : 'local-cache-fallback',
        tokensConfigured: r2.configured,
        usage: {
          estimatedStorageBytes: quota.estimatedStorageBytes,
          maxStorageBytes: FREE_TIER_LIMITS.R2_MAX_STORAGE_BYTES,
          monthlyClassAOps: quota.monthlyClassAOps,
          maxMonthlyClassAOps: FREE_TIER_LIMITS.R2_MAX_MONTHLY_CLASS_A,
          monthlyClassBOps: quota.monthlyClassBOps,
          maxMonthlyClassBOps: FREE_TIER_LIMITS.R2_MAX_MONTHLY_CLASS_B,
        },
      },
      realtime: {
        activeUsers: onlineSockets.size,
        activeSockets: wss.clients.size,
        maxSocketsPerUser: 5,
        heartbeatSeconds: 30,
        httpsFallbackActive: true,
      },
      webrtc: {
        stunServersCount: rtc.iceServers.length,
        turnConfigured: rtc.turnConfigured,
        turnProvider: rtc.turnProvider,
        maxVideoBitrateKbps: 900,
      },
      ai: {
        model: GEMINI_MODEL,
        configured: Boolean(process.env.GEMINI_API_KEY?.trim() || process.env.API_KEY?.trim()),
        dailyRequestsUsed: quota.dailyAiRequests,
        dailyRequestsCap: FREE_TIER_LIMITS.GEMINI_MAX_DAILY_GLOBAL,
        perUserPerMinuteCap: FREE_TIER_LIMITS.GEMINI_PER_USER_PER_MINUTE,
      },
      firestore: {
        projectId: firebaseProjectId,
        boundedQueriesEnabled: true,
      },
    });
  } catch {
    res.status(401).json({ error: 'Authentication failed' });
  }
});

// Server-Side Gemini API Endpoint (@google/genai)
const GEMINI_MODEL = 'gemini-4-hydrogen';

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim() || process.env.API_KEY?.trim();
  if (!apiKey) {
    throw Object.assign(
      new Error('GEMINI_API_KEY is not configured. Please add it in Settings > Secrets.'),
      { status: 503 }
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function generateWithRetry(
  ai: GoogleGenAI,
  contents: string,
  systemInstruction: string
): Promise<string> {
  const maxAttempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents,
        config: {
          systemInstruction,
        },
      });
      return (response.text ?? '').trim();
    } catch (err) {
      lastError = err;
      const status =
        typeof err === 'object' && err !== null && 'status' in err
          ? Number((err as { status?: number }).status)
          : 0;
      const retryable = status === 429 || status === 503 || status === 500;
      if (!retryable || attempt === maxAttempts) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

app.post('/api/ai/generate', async (req, res) => {
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

    const body = (req.body || {}) as {
      prompt?: unknown;
      mode?: unknown;
      context?: unknown;
    };

    const rawPrompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!rawPrompt || rawPrompt.length > 2000) {
      res.status(400).json({ error: 'Prompt must be between 1 and 2000 characters' });
      return;
    }

    const aiCheck = quotaManager.checkAiAllowed(verified.uid);
    if (!aiCheck.allowed) {
      res.status(429).json({ error: aiCheck.reason || 'AI rate limit reached' });
      return;
    }

    const mode =
      body.mode === 'draft_post' || body.mode === 'smart_reply' ? body.mode : 'ask';
    const context =
      typeof body.context === 'string' ? body.context.trim().slice(0, 1500) : '';

    let systemInstruction =
      'You are a concise, helpful assistant inside Alap, a secure messaging and social platform. Keep responses clear, accurate, and natural.';
    let contents = rawPrompt;

    if (mode === 'draft_post') {
      systemInstruction =
        'Write a natural, engaging social post caption based on the user topic. Output only the post text without surrounding quotes or extra commentary. Keep it under 400 characters unless requested otherwise.';
      contents = context ? `Topic: ${rawPrompt}\nAdditional context: ${context}` : rawPrompt;
    } else if (mode === 'smart_reply') {
      systemInstruction =
        'Suggest a single concise, natural chat reply based on the recent conversation context. Output only the suggested message text without quotes.';
      contents = context
        ? `Recent chat messages:\n${context}\n\nInstruction: ${rawPrompt}`
        : rawPrompt;
    }

    const ai = getGeminiClient();
    const text = await generateWithRetry(ai, contents, systemInstruction);
    quotaManager.recordAiUsage(verified.uid);
    res.json({ text, model: GEMINI_MODEL });
  } catch (err) {
    const status =
      typeof err === 'object' && err !== null && 'status' in err
        ? Number((err as { status?: number }).status)
        : 500;
    const message = err instanceof Error ? err.message : 'AI generation failed';
    res.status(status >= 400 && status < 600 ? status : 500).json({ error: message });
  }
});

// Authenticated Media Upload Endpoint (Cloudflare R2 + Free-Tier Quota Guard + Local Cache)
app.post(
  '/api/media/upload',
  express.raw({ type: '*/*', limit: '28mb' }),
  async (req, res) => {
    try {
      const authHeader = req.headers.authorization || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      if (!token) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      let verified: VerifiedTokenPayload;
      try {
        verified = await verifyFirebaseIdToken(token);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Invalid authentication token';
        res.status(401).json({ error: msg });
        return;
      }

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
      const isVideo = rawMime.startsWith('video/');
      const maxAllowedBytes = isVideo
        ? FREE_TIER_LIMITS.MAX_VIDEO_OR_REEL_BYTES
        : FREE_TIER_LIMITS.MAX_IMAGE_OR_VOICE_BYTES;
      if (bodyBuffer.length === 0 || bodyBuffer.length > maxAllowedBytes) {
        const maxMb = Math.round(maxAllowedBytes / (1024 * 1024));
        res.status(400).json({
          error: `File size must be between 1 byte and ${maxMb} MB to stay within free-tier storage limits`,
        });
        return;
      }

      const quotaCheck = quotaManager.checkUploadAllowed(verified.uid, bodyBuffer.length);
      if (!quotaCheck.allowed) {
        res.status(429).json({ error: quotaCheck.reason || 'Free-tier storage quota reached' });
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

      const r2 = getR2Config();
      let storageBackend: 'cloudflare-r2' | 'local-cache' = 'local-cache';

      if (r2.configured) {
        try {
          await putObjectToR2(r2, `media/${randomName}`, bodyBuffer, rawMime);
          storageBackend = 'cloudflare-r2';
          // Cache smaller assets locally to avoid repeat R2 Class B reads, bounded to 300MB
          if (bodyBuffer.length <= 8 * 1024 * 1024) {
            await fs.promises.writeFile(targetPath, bodyBuffer).catch(() => {});
            quotaManager.pruneLocalCacheIfNeeded();
          }
        } catch (r2Err) {
          console.warn('R2 upload fallback to local server:', r2Err);
          await fs.promises.writeFile(targetPath, bodyBuffer);
        }
      } else {
        await fs.promises.writeFile(targetPath, bodyBuffer);
      }

      quotaManager.recordUpload(verified.uid, bodyBuffer.length);
      res.json({
        url: `/api/media/${randomName}`,
        mime: rawMime,
        size: bodyBuffer.length,
        storage: storageBackend,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed';
      res.status(500).json({ error: msg });
    }
  }
);

// HEAD handler for mobile browsers / Safari media probing
app.head('/api/media/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    if (!SAFE_FILENAME_RE.test(filename)) {
      res.status(400).end();
      return;
    }
    const filePath = path.resolve(UPLOAD_DIR, filename);
    if (!filePath.startsWith(UPLOAD_DIR + path.sep)) {
      res.status(403).end();
      return;
    }
    const ext = path.extname(filename).toLowerCase();
    const contentType =
      Object.entries(MIME_TO_EXT).find(([, e]) => e === ext)?.[0] ||
      'application/octet-stream';

    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (stat && stat.isFile()) {
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Content-Type', contentType);
      res.status(200).end();
      return;
    }

    const r2 = getR2Config();
    if (r2.configured && quotaManager.checkReadAllowed()) {
      const r2Head = await headObjectInR2(r2, `media/${filename}`);
      if (r2Head.ok) {
        quotaManager.recordRead();
        res.setHeader('Accept-Ranges', 'bytes');
        const len = r2Head.headers.get('content-length');
        const type = r2Head.headers.get('content-type') || contentType;
        if (len) res.setHeader('Content-Length', len);
        res.setHeader('Content-Type', type);
        res.status(200).end();
        return;
      }
    }
    res.status(404).end();
  } catch {
    res.status(500).end();
  }
});

// Media Streaming Endpoint (Local Cache -> Cloudflare R2 Fallback with HTTP Range Support)
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

    const ext = path.extname(filename).toLowerCase();
    const contentType =
      Object.entries(MIME_TO_EXT).find(([, e]) => e === ext)?.[0] ||
      'application/octet-stream';

    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (stat && stat.isFile()) {
      const fileSize = stat.size;
      const range = req.headers.range;
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

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
      return;
    }

    // Fallback to Cloudflare R2 bucket zan-gi-media
    const r2 = getR2Config();
    if (r2.configured) {
      if (!quotaManager.checkReadAllowed()) {
        res.status(429).json({ error: 'R2 free-tier read safeguard reached' });
        return;
      }
      if (r2.publicUrl && !req.headers.range) {
        quotaManager.recordRead();
        res.redirect(302, `${r2.publicUrl}/media/${encodeURIComponent(filename)}`);
        return;
      }
      const r2Resp = await getObjectFromR2(r2, `media/${filename}`, req.headers.range);
      if (r2Resp.ok || r2Resp.status === 206) {
        quotaManager.recordRead();
        res.status(r2Resp.status);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        const r2Len = r2Resp.headers.get('content-length');
        const r2Range = r2Resp.headers.get('content-range');
        const r2Type = r2Resp.headers.get('content-type') || contentType;
        if (r2Len) res.setHeader('Content-Length', r2Len);
        if (r2Range) res.setHeader('Content-Range', r2Range);
        res.setHeader('Content-Type', r2Type);
        const buf = Buffer.from(await r2Resp.arrayBuffer());
        res.send(buf);
        return;
      }
    }

    res.status(404).json({ error: 'Media not found' });
  } catch {
    res.status(500).json({ error: 'Failed to stream media' });
  }
});

// Owner-Verified Media Delete (reclaims free-tier quota)
app.delete('/api/media/:filename', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!token) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const verified = await verifyFirebaseIdToken(token);
    const filename = req.params.filename;
    if (!SAFE_FILENAME_RE.test(filename)) {
      res.status(400).json({ error: 'Invalid media identifier' });
      return;
    }
    if (!filename.startsWith(`${verified.uid.slice(0, 12)}_`)) {
      res.status(403).json({ error: 'Not authorized to delete this media item' });
      return;
    }

    const filePath = path.resolve(UPLOAD_DIR, filename);
    if (!filePath.startsWith(UPLOAD_DIR + path.sep)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (stat?.isFile()) {
      quotaManager.recordDelete(stat.size);
      await fs.promises.unlink(filePath).catch(() => {});
    }

    const r2 = getR2Config();
    if (r2.configured) {
      await deleteObjectFromR2(r2, `media/${filename}`).catch(() => {});
    }
    res.json({ ok: true });
  } catch {
    res.status(401).json({ error: 'Authentication failed' });
  }
});

// --- WebSocket Real-Time Presence, Typing & WebRTC Signaling Server ---
interface AuthedSocket extends WebSocket {
  uid?: string;
  isAlive?: boolean;
  msgWindowStart?: number;
  msgWindowCount?: number;
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
const onlineSockets = new Map<string, Set<AuthedSocket>>();
const pendingCallSignals = new Map<
  string,
  Array<{ event: Record<string, unknown>; expiresAt: number }>
>();

function enqueuePendingSignal(targetUid: string, event: Record<string, unknown>): void {
  const now = Date.now();
  const existing = (pendingCallSignals.get(targetUid) || []).filter(
    (entry) => entry.expiresAt > now
  );
  existing.push({ event, expiresAt: now + 45_000 });
  if (existing.length > 40) {
    existing.splice(0, existing.length - 40);
  }
  pendingCallSignals.set(targetUid, existing);
}

function drainPendingSignals(targetUid: string): Record<string, unknown>[] {
  const now = Date.now();
  const list = pendingCallSignals.get(targetUid);
  if (!list || list.length === 0) return [];
  pendingCallSignals.delete(targetUid);
  return list.filter((item) => item.expiresAt > now).map((item) => item.event);
}

function sendToUser(
  targetUid: string,
  event: Record<string, unknown>,
  bufferIfOffline = false
): void {
  const sockets = onlineSockets.get(targetUid);
  const serialized = JSON.stringify(event);
  let delivered = false;
  if (sockets) {
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(serialized);
        delivered = true;
      }
    }
  }
  if (!delivered && bufferIfOffline) {
    enqueuePendingSignal(targetUid, event);
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

const RTC_SIGNAL_TYPES = new Set([
  'call:accept',
  'call:decline',
  'call:end',
  'call:busy',
  'webrtc:offer',
  'webrtc:answer',
  'webrtc:ice-candidate',
]);

// HTTPS Signaling Fallback (guarantees WebRTC calls work even if WS is blocked or reconnecting)
app.post('/api/rtc/signal', async (req, res) => {
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

    const msg = (req.body || {}) as {
      type?: string;
      targetUserIds?: string[];
      targetUid?: string;
      callId?: string;
      chatId?: string;
      callType?: 'audio' | 'video' | 'group';
      callerName?: string;
      callerAvatar?: string;
      offer?: unknown;
      answer?: unknown;
      candidate?: unknown;
    };

    if (msg.type === 'call:invite' && Array.isArray(msg.targetUserIds)) {
      for (const targetId of msg.targetUserIds.slice(0, 20)) {
        if (targetId && targetId !== verified.uid) {
          sendToUser(
            targetId,
            {
              type: 'call:invite',
              callId: msg.callId,
              chatId: msg.chatId,
              callType: msg.callType || 'video',
              callerId: verified.uid,
              callerName: msg.callerName || 'User',
              callerAvatar: msg.callerAvatar || '',
            },
            true
          );
        }
      }
      res.json({ ok: true });
      return;
    }

    if (msg.type && RTC_SIGNAL_TYPES.has(msg.type) && msg.targetUid) {
      sendToUser(
        msg.targetUid,
        {
          ...msg,
          senderId: verified.uid,
        },
        true
      );
      res.json({ ok: true });
      return;
    }

    res.status(400).json({ error: 'Invalid RTC signal payload' });
  } catch {
    res.status(401).json({ error: 'Invalid authentication token' });
  }
});

app.get('/api/rtc/signal', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!token) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const verified = await verifyFirebaseIdToken(token);
    const events = drainPendingSignals(verified.uid);
    res.json({ events });
  } catch {
    res.status(401).json({ error: 'Invalid authentication token' });
  }
});

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
        const userSockets = onlineSockets.get(verified.uid)!;
        // Free-tier guard: max 5 concurrent sockets per user
        if (userSockets.size >= 5) {
          const oldest = userSockets.values().next().value;
          if (oldest && oldest !== ws) {
            userSockets.delete(oldest);
            oldest.close(4001, 'Session limit reached');
          }
        }
        userSockets.add(ws);
        ws.send(JSON.stringify({ type: 'auth:ok', uid: verified.uid }));
        // Flush any call/WebRTC signals buffered while user was reconnecting
        const buffered = drainPendingSignals(verified.uid);
        for (const ev of buffered) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(ev));
          }
        }
        broadcastPresence();
        return;
      }

      if (msg.type === 'ping') {
        ws.isAlive = true;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        }
        return;
      }

      if (!ws.uid) {
        ws.send(JSON.stringify({ type: 'error', message: 'Unauthenticated' }));
        return;
      }

      // Per-socket rate limit (40 events / 10 seconds)
      const now = Date.now();
      if (!ws.msgWindowStart || now - ws.msgWindowStart > 10_000) {
        ws.msgWindowStart = now;
        ws.msgWindowCount = 1;
      } else {
        ws.msgWindowCount = (ws.msgWindowCount || 0) + 1;
        if (ws.msgWindowCount > 40) {
          return;
        }
      }

      if (msg.type === 'typing' && Array.isArray(msg.targetUserIds) && msg.chatId) {
        for (const targetId of msg.targetUserIds.slice(0, 50)) {
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

      // WebRTC Call Signaling (buffered if peer WS is temporarily reconnecting)
      if (msg.type === 'call:invite' && Array.isArray(msg.targetUserIds)) {
        for (const targetId of msg.targetUserIds.slice(0, 20)) {
          if (targetId !== ws.uid) {
            sendToUser(
              targetId,
              {
                type: 'call:invite',
                callId: msg.callId,
                chatId: msg.chatId,
                callType: msg.callType || 'video',
                callerId: ws.uid,
                callerName: msg.callerName || 'User',
                callerAvatar: msg.callerAvatar || '',
              },
              true
            );
          }
        }
        return;
      }

      if (RTC_SIGNAL_TYPES.has(msg.type) && msg.targetUid) {
        sendToUser(
          msg.targetUid,
          {
            ...msg,
            senderId: ws.uid,
          },
          true
        );
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

// Heartbeat interval to prune stale sockets & expired signal buffers
const heartbeatInterval = setInterval(() => {
  const now = Date.now();
  for (const [uid, list] of pendingCallSignals.entries()) {
    const active = list.filter((item) => item.expiresAt > now);
    if (active.length === 0) pendingCallSignals.delete(uid);
    else if (active.length !== list.length) pendingCallSignals.set(uid, active);
  }
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
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found' });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(ROOT_DIR, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distDir, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Alap server running on http://0.0.0.0:${PORT}`);
  });
}

function gracefulShutdown(signal: string): void {
  console.log(`Received ${signal}, shutting down Alap server cleanly...`);
  clearInterval(heartbeatInterval);
  wss.close();
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

start();

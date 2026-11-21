import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface R2Config {
  accountId: string;
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicUrl: string;
  configured: boolean;
}

export interface QuotaState {
  monthKey: string;
  dayKey: string;
  monthlyClassAOps: number;
  dailyClassAOps: number;
  monthlyClassBOps: number;
  dailyClassBOps: number;
  estimatedStorageBytes: number;
  dailyAiRequests: number;
}

// Conservative caps strictly inside Cloudflare R2 & Gemini free tiers:
// R2 Free Tier: 10 GB storage, 1M Class A ops/mo, 10M Class B ops/mo
export const FREE_TIER_LIMITS = {
  R2_MAX_STORAGE_BYTES: Math.floor(8.5 * 1024 * 1024 * 1024), // 8.5 GB hard cap (< 10 GB)
  R2_MAX_EPHEMERAL_CACHE_BYTES: 300 * 1024 * 1024, // 300 MB local disk cache cap (Render free tier safe)
  R2_MAX_MONTHLY_CLASS_A: 800_000, // < 1,000,000
  R2_MAX_DAILY_CLASS_A: 25_000,
  R2_MAX_MONTHLY_CLASS_B: 8_000_000, // < 10,000,000
  R2_MAX_DAILY_CLASS_B: 250_000,
  MAX_IMAGE_OR_VOICE_BYTES: 5 * 1024 * 1024, // 5 MB
  MAX_VIDEO_OR_REEL_BYTES: 25 * 1024 * 1024, // 25 MB
  USER_UPLOADS_PER_HOUR: 25,
  USER_UPLOADS_PER_DAY: 120,
  GEMINI_PER_USER_PER_MINUTE: 15,
  GEMINI_PER_USER_PER_DAY: 100,
  GEMINI_MAX_DAILY_GLOBAL: 1400, // safely inside free daily quota
} as const;

export function getR2Config(): R2Config {
  const accountId = (process.env.R2_ACCOUNT_ID || 'd862607d4f089ab670bd9e4611a6e2e1').trim();
  const endpoint = (
    process.env.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`
  )
    .trim()
    .replace(/\/+$/, '');
  const bucket = (process.env.R2_BUCKET || 'zan-gi-media').trim();
  const accessKeyId = (process.env.R2_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = (process.env.R2_SECRET_ACCESS_KEY || '').trim();
  const publicUrl = (process.env.R2_PUBLIC_URL || '').trim().replace(/\/+$/, '');

  return {
    accountId,
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    publicUrl,
    configured: Boolean(accessKeyId && secretAccessKey && endpoint && bucket),
  };
}

function getDateKeys(): { monthKey: string; dayKey: string } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return { monthKey: `${y}-${m}`, dayKey: `${y}-${m}-${d}` };
}

export class FreeTierQuotaManager {
  private readonly quotaFilePath: string;
  private readonly uploadDir: string;
  private state: QuotaState;
  private userUploadTimestamps = new Map<string, number[]>();
  private userDailyUploadCounts = new Map<string, { dayKey: string; count: number }>();
  private userAiMinuteTimestamps = new Map<string, number[]>();
  private userAiDailyCounts = new Map<string, { dayKey: string; count: number }>();

  constructor(uploadDir: string) {
    this.uploadDir = uploadDir;
    this.quotaFilePath = path.resolve(uploadDir, '.quota-state.json');
    this.state = this.loadState();
    this.syncLocalDiskUsage(uploadDir);
  }

  private syncLocalDiskUsage(uploadDir: string): void {
    try {
      const entries = fs.readdirSync(uploadDir, { withFileTypes: true });
      let diskBytes = 0;
      for (const entry of entries) {
        if (!entry.isFile() || entry.name.startsWith('.')) continue;
        const st = fs.statSync(path.join(uploadDir, entry.name));
        diskBytes += st.size;
      }
      if (diskBytes > this.state.estimatedStorageBytes) {
        this.state.estimatedStorageBytes = diskBytes;
        this.persist();
      }
    } catch {
      // Ignore startup scan error
    }
  }

  pruneLocalCacheIfNeeded(): void {
    try {
      const entries = fs.readdirSync(this.uploadDir, { withFileTypes: true });
      const files: Array<{ filePath: string; size: number; mtimeMs: number }> = [];
      let totalSize = 0;
      for (const entry of entries) {
        if (!entry.isFile() || entry.name.startsWith('.')) continue;
        const filePath = path.join(this.uploadDir, entry.name);
        const st = fs.statSync(filePath);
        totalSize += st.size;
        files.push({ filePath, size: st.size, mtimeMs: st.mtimeMs });
      }
      if (totalSize <= FREE_TIER_LIMITS.R2_MAX_EPHEMERAL_CACHE_BYTES) return;
      files.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const file of files) {
        if (totalSize <= FREE_TIER_LIMITS.R2_MAX_EPHEMERAL_CACHE_BYTES * 0.8) break;
        fs.unlinkSync(file.filePath);
        totalSize -= file.size;
      }
    } catch {
      // Ignore prune error
    }
  }

  private loadState(): QuotaState {
    const { monthKey, dayKey } = getDateKeys();
    try {
      const raw = fs.readFileSync(this.quotaFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<QuotaState>;
      const sameMonth = parsed.monthKey === monthKey;
      const sameDay = parsed.dayKey === dayKey;
      return {
        monthKey,
        dayKey,
        monthlyClassAOps: sameMonth ? Number(parsed.monthlyClassAOps || 0) : 0,
        dailyClassAOps: sameDay ? Number(parsed.dailyClassAOps || 0) : 0,
        monthlyClassBOps: sameMonth ? Number(parsed.monthlyClassBOps || 0) : 0,
        dailyClassBOps: sameDay ? Number(parsed.dailyClassBOps || 0) : 0,
        estimatedStorageBytes: Number(parsed.estimatedStorageBytes || 0),
        dailyAiRequests: sameDay ? Number(parsed.dailyAiRequests || 0) : 0,
      };
    } catch {
      return {
        monthKey,
        dayKey,
        monthlyClassAOps: 0,
        dailyClassAOps: 0,
        monthlyClassBOps: 0,
        dailyClassBOps: 0,
        estimatedStorageBytes: 0,
        dailyAiRequests: 0,
      };
    }
  }

  private rolloverIfNeeded(): void {
    const { monthKey, dayKey } = getDateKeys();
    if (this.state.monthKey !== monthKey) {
      this.state.monthKey = monthKey;
      this.state.monthlyClassAOps = 0;
      this.state.monthlyClassBOps = 0;
    }
    if (this.state.dayKey !== dayKey) {
      this.state.dayKey = dayKey;
      this.state.dailyClassAOps = 0;
      this.state.dailyClassBOps = 0;
      this.state.dailyAiRequests = 0;
    }
  }

  private persist(): void {
    void fs.promises
      .writeFile(this.quotaFilePath, JSON.stringify(this.state, null, 2))
      .catch(() => {});
  }

  checkUploadAllowed(uid: string, byteLength: number): { allowed: boolean; reason?: string } {
    this.rolloverIfNeeded();

    if (
      this.state.estimatedStorageBytes + byteLength >
      FREE_TIER_LIMITS.R2_MAX_STORAGE_BYTES
    ) {
      return {
        allowed: false,
        reason: 'Storage free-tier safeguard reached (8.5 GB cap). Please delete older media.',
      };
    }
    if (
      this.state.monthlyClassAOps >= FREE_TIER_LIMITS.R2_MAX_MONTHLY_CLASS_A ||
      this.state.dailyClassAOps >= FREE_TIER_LIMITS.R2_MAX_DAILY_CLASS_A
    ) {
      return {
        allowed: false,
        reason: 'Daily/monthly upload safeguard reached to stay inside R2 free tier.',
      };
    }

    const now = Date.now();
    const oneHourAgo = now - 3600_000;
    const recent = (this.userUploadTimestamps.get(uid) || []).filter((ts) => ts > oneHourAgo);
    if (recent.length >= FREE_TIER_LIMITS.USER_UPLOADS_PER_HOUR) {
      return {
        allowed: false,
        reason: 'Hourly upload limit reached (25 uploads/hour) to protect free-tier quota.',
      };
    }

    const { dayKey } = getDateKeys();
    const userDay = this.userDailyUploadCounts.get(uid);
    if (userDay && userDay.dayKey === dayKey && userDay.count >= FREE_TIER_LIMITS.USER_UPLOADS_PER_DAY) {
      return {
        allowed: false,
        reason: 'Daily per-user upload limit reached (120/day) to protect free-tier quota.',
      };
    }
    return { allowed: true };
  }

  recordUpload(uid: string, byteLength: number): void {
    this.rolloverIfNeeded();
    this.state.monthlyClassAOps += 1;
    this.state.dailyClassAOps += 1;
    this.state.estimatedStorageBytes += byteLength;

    const now = Date.now();
    const oneHourAgo = now - 3600_000;
    const recent = (this.userUploadTimestamps.get(uid) || []).filter((ts) => ts > oneHourAgo);
    recent.push(now);
    this.userUploadTimestamps.set(uid, recent);

    const { dayKey } = getDateKeys();
    const prev = this.userDailyUploadCounts.get(uid);
    this.userDailyUploadCounts.set(uid, {
      dayKey,
      count: prev && prev.dayKey === dayKey ? prev.count + 1 : 1,
    });
    this.persist();
  }

  recordDelete(byteLength: number): void {
    this.rolloverIfNeeded();
    this.state.estimatedStorageBytes = Math.max(0, this.state.estimatedStorageBytes - byteLength);
    this.persist();
  }

  checkReadAllowed(): boolean {
    this.rolloverIfNeeded();
    return (
      this.state.monthlyClassBOps < FREE_TIER_LIMITS.R2_MAX_MONTHLY_CLASS_B &&
      this.state.dailyClassBOps < FREE_TIER_LIMITS.R2_MAX_DAILY_CLASS_B
    );
  }

  recordRead(): void {
    this.rolloverIfNeeded();
    this.state.monthlyClassBOps += 1;
    this.state.dailyClassBOps += 1;
    this.persist();
  }

  checkAiAllowed(uid: string): { allowed: boolean; reason?: string } {
    this.rolloverIfNeeded();
    if (this.state.dailyAiRequests >= FREE_TIER_LIMITS.GEMINI_MAX_DAILY_GLOBAL) {
      return {
        allowed: false,
        reason: 'Daily AI free-tier limit reached. Please try again tomorrow.',
      };
    }

    const now = Date.now();
    const oneMinAgo = now - 60_000;
    const minList = (this.userAiMinuteTimestamps.get(uid) || []).filter((ts) => ts > oneMinAgo);
    if (minList.length >= FREE_TIER_LIMITS.GEMINI_PER_USER_PER_MINUTE) {
      return {
        allowed: false,
        reason: 'Too many AI requests per minute. Please wait a few seconds.',
      };
    }

    const { dayKey } = getDateKeys();
    const userDay = this.userAiDailyCounts.get(uid);
    if (userDay && userDay.dayKey === dayKey && userDay.count >= FREE_TIER_LIMITS.GEMINI_PER_USER_PER_DAY) {
      return {
        allowed: false,
        reason: 'Daily per-user AI limit reached (100/day) to stay inside free tier.',
      };
    }

    return { allowed: true };
  }

  recordAiUsage(uid: string): void {
    this.rolloverIfNeeded();
    this.state.dailyAiRequests += 1;

    const now = Date.now();
    const oneMinAgo = now - 60_000;
    const minList = (this.userAiMinuteTimestamps.get(uid) || []).filter((ts) => ts > oneMinAgo);
    minList.push(now);
    this.userAiMinuteTimestamps.set(uid, minList);

    const { dayKey } = getDateKeys();
    const prev = this.userAiDailyCounts.get(uid);
    const nextCount = prev && prev.dayKey === dayKey ? prev.count + 1 : 1;
    this.userAiDailyCounts.set(uid, { dayKey, count: nextCount });
    this.persist();
  }

  getSnapshot(): QuotaState {
    this.rolloverIfNeeded();
    return { ...this.state };
  }
}

// --- Zero-Dependency AWS SigV4 Signer for Cloudflare R2 S3 API ---
function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function encodeRfc3986Path(objectKey: string): string {
  return objectKey
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function signR2Request(opts: {
  method: 'PUT' | 'GET' | 'HEAD' | 'DELETE';
  cfg: R2Config;
  objectKey: string;
  payloadHash: string;
  extraHeaders?: Record<string, string>;
}): { url: string; headers: Record<string, string> } {
  const { method, cfg, objectKey, payloadHash, extraHeaders = {} } = opts;
  const parsedEndpoint = new URL(cfg.endpoint);
  const host = parsedEndpoint.host;
  const canonicalUri = `/${encodeRfc3986Path(cfg.bucket)}/${encodeRfc3986Path(objectKey)}`;
  const url = `${cfg.endpoint}${canonicalUri}`;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const region = 'auto';
  const service = 's3';

  const baseHeaders: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  for (const [k, v] of Object.entries(extraHeaders)) {
    baseHeaders[k.toLowerCase()] = v;
  }

  const sortedHeaderKeys = Object.keys(baseHeaders).sort();
  const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${baseHeaders[k]}\n`).join('');
  const signedHeaders = sortedHeaderKeys.join(';');

  const canonicalRequest = [
    method,
    canonicalUri,
    '', // query string
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmacSha256(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers: Record<string, string> = {
    ...extraHeaders,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    Authorization: authorization,
  };
  return { url, headers };
}

export async function putObjectToR2(
  cfg: R2Config,
  objectKey: string,
  body: Buffer,
  contentType: string
): Promise<void> {
  const payloadHash = sha256Hex(body);
  const { url, headers } = signR2Request({
    method: 'PUT',
    cfg,
    objectKey,
    payloadHash,
    extraHeaders: {
      'content-type': contentType,
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });

  const resp = await fetch(url, {
    method: 'PUT',
    headers,
    body: new Uint8Array(body),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`R2 upload failed (${resp.status}): ${errText.slice(0, 180)}`);
  }
}

export async function getObjectFromR2(
  cfg: R2Config,
  objectKey: string,
  rangeHeader?: string
): Promise<Response> {
  const emptyHash = sha256Hex('');
  const extraHeaders: Record<string, string> = {};
  if (rangeHeader) {
    extraHeaders.range = rangeHeader;
  }

  const { url, headers } = signR2Request({
    method: 'GET',
    cfg,
    objectKey,
    payloadHash: emptyHash,
    extraHeaders,
  });

  return fetch(url, {
    method: 'GET',
    headers,
  });
}

export async function headObjectInR2(cfg: R2Config, objectKey: string): Promise<Response> {
  const emptyHash = sha256Hex('');
  const { url, headers } = signR2Request({
    method: 'HEAD',
    cfg,
    objectKey,
    payloadHash: emptyHash,
  });

  return fetch(url, {
    method: 'HEAD',
    headers,
  });
}

export async function deleteObjectFromR2(cfg: R2Config, objectKey: string): Promise<void> {
  const emptyHash = sha256Hex('');
  const { url, headers } = signR2Request({
    method: 'DELETE',
    cfg,
    objectKey,
    payloadHash: emptyHash,
  });

  const resp = await fetch(url, {
    method: 'DELETE',
    headers,
  });
  if (!resp.ok && resp.status !== 404) {
    throw new Error(`R2 delete failed (${resp.status})`);
  }
}

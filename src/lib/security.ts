export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function generateSafetyCode(seed: string): Promise<string> {
  const hex = await sha256Hex(seed);
  const digits = hex
    .slice(0, 24)
    .split('')
    .map((c) => String(Number.parseInt(c, 16) % 10))
    .join('');
  return digits.match(/.{1,4}/g)?.join(' ') || digits;
}

export async function generateIdentityKeyPair(): Promise<{ publicKeyJwk: string }> {
  try {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey']
    );
    const exported = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
    return { publicKeyJwk: JSON.stringify(exported).slice(0, 2000) };
  } catch {
    return { publicKeyJwk: '' };
  }
}

export function sanitizeMediaUrl(url?: string): string {
  if (!url) return '';
  const trimmed = url.trim();
  if (
    trimmed.startsWith('/api/media/') ||
    trimmed.startsWith('/src/assets/') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('http://') ||
    trimmed.startsWith('blob:')
  ) {
    return trimmed;
  }
  return '';
}

export function formatDurationClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function formatRelativeTime(ms: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return 'Just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

import { auth } from './firebase';

export async function compressImageFile(file: File, maxDim = 1440, quality = 0.84): Promise<Blob> {
  if (file.type === 'image/gif') {
    return file;
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = Math.min(maxDim / width, maxDim / height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(file);
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else resolve(file);
        },
        'image/jpeg',
        quality
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Failed to decode image'));
    };
    img.src = objectUrl;
  });
}

export async function getVideoDuration(file: Blob): Promise<number> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    const objectUrl = URL.createObjectURL(file);
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(objectUrl);
      if (!Number.isFinite(video.duration)) {
        reject(new Error('Could not determine video duration'));
        return;
      }
      resolve(video.duration);
    };
    video.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Invalid video file'));
    };
    video.src = objectUrl;
  });
}

export async function uploadMediaBlob(
  blob: Blob,
  mimeType: string,
  category: 'general' | 'reel' | 'voice' | 'verification',
  reelDurationSec?: number
): Promise<string> {
  const user = auth.currentUser;
  if (!user) throw new Error('Must be signed in to upload media');
  const token = await user.getIdToken();

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'X-File-Mime': mimeType,
    'X-Media-Category': category,
  };
  if (category === 'reel' && typeof reelDurationSec === 'number') {
    headers['X-Reel-Duration'] = String(Math.round(reelDurationSec));
  }

  const resp = await fetch('/api/media/upload', {
    method: 'POST',
    headers,
    body: blob,
  });

  if (!resp.ok) {
    const errBody = (await resp.json().catch(() => ({}))) as { error?: string };
    throw new Error(errBody.error || `Upload failed (${resp.status})`);
  }

  const data = (await resp.json()) as { url: string };
  return data.url;
}

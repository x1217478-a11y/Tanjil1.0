import { auth } from './firebase';

export type PermissionStateValue = 'granted' | 'denied' | 'prompt' | 'unsupported';

export interface DevicePermissionsSummary {
  camera: PermissionStateValue;
  microphone: PermissionStateValue;
  notifications: PermissionStateValue;
}

const DEFAULT_ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.cloudflare.com:53' },
  ],
  iceCandidatePoolSize: 4,
};

async function queryBrowserPermission(name: 'camera' | 'microphone'): Promise<PermissionStateValue> {
  try {
    if (!navigator.permissions?.query) return 'prompt';
    const res = await navigator.permissions.query({ name: name as PermissionName });
    return res.state as PermissionStateValue;
  } catch {
    return 'prompt';
  }
}

export async function checkDevicePermissions(): Promise<DevicePermissionsSummary> {
  const [camera, microphone] = await Promise.all([
    queryBrowserPermission('camera'),
    queryBrowserPermission('microphone'),
  ]);
  let notifications: PermissionStateValue = 'unsupported';
  if (typeof Notification !== 'undefined') {
    notifications =
      Notification.permission === 'default'
        ? 'prompt'
        : (Notification.permission as PermissionStateValue);
  }
  return { camera, microphone, notifications };
}

export async function requestMediaPermission(
  kind: 'camera' | 'microphone'
): Promise<PermissionStateValue> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia(
      kind === 'camera' ? { video: true } : { audio: true }
    );
    stream.getTracks().forEach((t) => t.stop());
    return 'granted';
  } catch {
    return 'denied';
  }
}

export async function requestNotificationPermission(): Promise<PermissionStateValue> {
  if (typeof Notification === 'undefined') return 'unsupported';
  try {
    const res = await Notification.requestPermission();
    return res === 'default' ? 'prompt' : (res as PermissionStateValue);
  } catch {
    return 'denied';
  }
}

export async function requestAllPermissions(): Promise<DevicePermissionsSummary> {
  let camera: PermissionStateValue = 'denied';
  let microphone: PermissionStateValue = 'denied';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    stream.getTracks().forEach((t) => t.stop());
    camera = 'granted';
    microphone = 'granted';
  } catch {
    camera = await requestMediaPermission('camera');
    microphone = await requestMediaPermission('microphone');
  }
  const notifications = await requestNotificationPermission();
  return { camera, microphone, notifications };
}

export async function acquireCallMediaStream(withVideo: boolean): Promise<{
  stream: MediaStream | null;
  videoActive: boolean;
  warning: string;
}> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return {
      stream: null,
      videoActive: false,
      warning: 'Browser media devices API is unavailable (requires HTTPS or localhost).',
    };
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: withVideo
        ? {
            width: { ideal: 1280, max: 1920 },
            height: { ideal: 720, max: 1080 },
            facingMode: 'user',
          }
        : false,
    });
    return { stream, videoActive: withVideo, warning: '' };
  } catch {
    if (withVideo) {
      // Fallback to audio-only if camera permission or hardware fails
      try {
        const audioOnly = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        });
        return {
          stream: audioOnly,
          videoActive: false,
          warning: 'Camera unavailable — connected with audio only.',
        };
      } catch {
        // Both camera and mic failed
      }
    }
    return {
      stream: null,
      videoActive: false,
      warning: 'Microphone/camera access is blocked. Allow permissions in your browser and tap Retry.',
    };
  }
}

export async function fetchIceServersConfig(): Promise<RTCConfiguration> {
  try {
    const user = auth.currentUser;
    if (!user) return DEFAULT_ICE_SERVERS;
    const token = await user.getIdToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch('/api/rtc/ice-servers', {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return DEFAULT_ICE_SERVERS;
    const data = (await resp.json()) as {
      iceServers?: RTCIceServer[];
      iceCandidatePoolSize?: number;
    };
    if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
      return {
        iceServers: data.iceServers,
        iceCandidatePoolSize: data.iceCandidatePoolSize ?? 4,
      };
    }
  } catch {
    // Fallback to default STUN pool
  }
  return DEFAULT_ICE_SERVERS;
}

export interface SystemStatusReport {
  hosting?: {
    platform: string;
    nodeVersion: string;
    port: number;
    uptimeSeconds: number;
    environment: string;
    externalUrl?: string;
  };
  r2: {
    accountId: string;
    bucket: string;
    endpoint: string;
    mode: 'cloudflare-r2' | 'local-cache-fallback';
    tokensConfigured: boolean;
    usage: {
      estimatedStorageBytes: number;
      maxStorageBytes: number;
      monthlyClassAOps: number;
      maxMonthlyClassAOps: number;
      monthlyClassBOps: number;
      maxMonthlyClassBOps: number;
    };
  };
  realtime: {
    activeUsers: number;
    activeSockets: number;
    maxSocketsPerUser: number;
    heartbeatSeconds: number;
    httpsFallbackActive?: boolean;
  };
  webrtc: {
    stunServersCount: number;
    turnConfigured: boolean;
    turnProvider?: 'static' | 'cloudflare-calls' | 'none';
    maxVideoBitrateKbps?: number;
  };
  ai: {
    model: string;
    configured: boolean;
    dailyRequestsUsed: number;
    dailyRequestsCap: number;
    perUserPerMinuteCap: number;
  };
  firestore: {
    projectId: string;
    boundedQueriesEnabled: boolean;
  };
}

export async function fetchSystemStatus(): Promise<SystemStatusReport> {
  const user = auth.currentUser;
  if (!user) throw new Error('Sign in required');
  const token = await user.getIdToken();
  const resp = await fetch('/api/system/status', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    throw new Error(`Status check failed (${resp.status})`);
  }
  return (await resp.json()) as SystemStatusReport;
}

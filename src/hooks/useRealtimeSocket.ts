import { useCallback, useEffect, useRef, useState } from 'react';
import { auth } from '../lib/firebase';
import type { CallType } from '../types/app';

export interface IncomingCallSignal {
  callId: string;
  chatId: string;
  callType: CallType;
  callerId: string;
  callerName: string;
  callerAvatar: string;
}

export interface WebRtcSignalEvent {
  type:
    | 'call:accept'
    | 'call:decline'
    | 'call:end'
    | 'call:busy'
    | 'webrtc:offer'
    | 'webrtc:answer'
    | 'webrtc:ice-candidate';
  senderId: string;
  callId?: string;
  chatId?: string;
  offer?: RTCSessionDescriptionInit;
  answer?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

export function useRealtimeSocket(
  uid: string | undefined,
  onIncomingCall: (signal: IncomingCallSignal) => void
) {
  const wsRef = useRef<WebSocket | null>(null);
  const [onlineUserIds, setOnlineUserIds] = useState<string[]>([]);
  const [typingByChat, setTypingByChat] = useState<Record<string, Record<string, number>>>({});
  const [connected, setConnected] = useState(false);
  const [networkOnline, setNetworkOnline] = useState(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  const onIncomingCallRef = useRef(onIncomingCall);
  onIncomingCallRef.current = onIncomingCall;
  const signalListenersRef = useRef<Set<(event: WebRtcSignalEvent) => void>>(new Set());

  const subscribeSignals = useCallback((listener: (event: WebRtcSignalEvent) => void) => {
    signalListenersRef.current.add(listener);
    return () => {
      signalListenersRef.current.delete(listener);
    };
  }, []);

  const dispatchIncomingEvent = useCallback((data: Record<string, unknown>) => {
    const type = typeof data.type === 'string' ? data.type : '';
    if (type === 'auth:ok') {
      setConnected(true);
      return;
    }
    if (type === 'pong') {
      return;
    }
    if (type === 'presence:list' && Array.isArray(data.onlineIds)) {
      setOnlineUserIds(data.onlineIds as string[]);
      return;
    }
    if (type === 'typing' && typeof data.chatId === 'string' && typeof data.senderId === 'string') {
      const chatId = data.chatId;
      const senderId = data.senderId;
      const isTyping = Boolean(data.isTyping);
      setTypingByChat((prev) => {
        const chatMap = { ...(prev[chatId] || {}) };
        if (isTyping) {
          chatMap[senderId] = Date.now() + 4000;
        } else {
          delete chatMap[senderId];
        }
        return { ...prev, [chatId]: chatMap };
      });
      return;
    }
    if (type === 'call:invite' && typeof data.callId === 'string' && typeof data.callerId === 'string') {
      onIncomingCallRef.current({
        callId: data.callId,
        chatId: (data.chatId as string) || '',
        callType: (data.callType as CallType) || 'video',
        callerId: data.callerId,
        callerName: (data.callerName as string) || 'User',
        callerAvatar: (data.callerAvatar as string) || '',
      });
      return;
    }
    if (
      type === 'call:accept' ||
      type === 'call:decline' ||
      type === 'call:end' ||
      type === 'call:busy' ||
      type === 'webrtc:offer' ||
      type === 'webrtc:answer' ||
      type === 'webrtc:ice-candidate'
    ) {
      const ev = data as unknown as WebRtcSignalEvent;
      for (const listener of signalListenersRef.current) {
        listener(ev);
      }
    }
  }, []);

  useEffect(() => {
    const onOnline = () => setNetworkOnline(true);
    const onOffline = () => setNetworkOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  useEffect(() => {
    if (!uid) {
      setOnlineUserIds([]);
      setConnected(false);
      return;
    }

    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;

    const connect = async () => {
      if (cancelled) return;
      const user = auth.currentUser;
      if (!user) return;
      const token = await user.getIdToken().catch(() => '');
      if (!token || cancelled) return;

      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttempt = 0;
        ws.send(JSON.stringify({ type: 'auth', token }));
      };

      ws.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data as string) as Record<string, unknown>;
          dispatchIncomingEvent(data);
        } catch {
          // Ignore malformed frame
        }
      };

      ws.onerror = () => {
        // Close handler manages reconnect cleanly
      };

      ws.onclose = () => {
        setConnected(false);
        if (!cancelled) {
          reconnectAttempt += 1;
          const delayMs = Math.min(15000, 1500 * reconnectAttempt);
          reconnectTimer = setTimeout(() => {
            void connect();
          }, delayMs);
        }
      };
    };

    const handleNetworkBack = () => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectAttempt = 0;
        void connect();
      }
    };
    window.addEventListener('online', handleNetworkBack);

    void connect();

    // Keepalive ping every 25s so reverse proxies (Render) keep active WS alive
    const pingInterval = setInterval(() => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 25_000);

    // HTTPS fallback poller when WebSocket is disconnected (keeps calls working on restricted networks)
    const fallbackPollInterval = setInterval(() => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) return;
      const user = auth.currentUser;
      if (!user || (typeof navigator !== 'undefined' && !navigator.onLine)) return;
      void user
        .getIdToken()
        .then((token) =>
          fetch('/api/rtc/signal', {
            headers: { Authorization: `Bearer ${token}` },
          })
        )
        .then((resp) => (resp.ok ? resp.json() : null))
        .then((payload: { events?: Record<string, unknown>[] } | null) => {
          if (payload && Array.isArray(payload.events)) {
            for (const ev of payload.events) {
              dispatchIncomingEvent(ev);
            }
          }
        })
        .catch(() => {});
    }, 2000);

    // Prune stale typing states
    const pruneInterval = setInterval(() => {
      const now = Date.now();
      setTypingByChat((prev) => {
        let changed = false;
        const next: Record<string, Record<string, number>> = {};
        for (const [cid, users] of Object.entries(prev)) {
          const active: Record<string, number> = {};
          for (const [sid, exp] of Object.entries(users)) {
            if (exp > now) active[sid] = exp;
            else changed = true;
          }
          if (Object.keys(active).length > 0) next[cid] = active;
        }
        return changed ? next : prev;
      });
    }, 1500);

    return () => {
      cancelled = true;
      window.removeEventListener('online', handleNetworkBack);
      clearInterval(pingInterval);
      clearInterval(fallbackPollInterval);
      clearInterval(pruneInterval);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [uid, dispatchIncomingEvent]);

  const sendSocketEvent = useCallback((payload: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      return;
    }

    const type = typeof payload.type === 'string' ? payload.type : '';
    if (type.startsWith('call:') || type.startsWith('webrtc:')) {
      const user = auth.currentUser;
      if (!user) return;
      void user
        .getIdToken()
        .then((token) =>
          fetch('/api/rtc/signal', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(payload),
          })
        )
        .catch(() => {});
    }
  }, []);

  return { onlineUserIds, typingByChat, connected, networkOnline, sendSocketEvent, subscribeSignals };
}

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
  type: 'call:accept' | 'call:decline' | 'call:end' | 'webrtc:offer' | 'webrtc:answer' | 'webrtc:ice-candidate';
  senderId: string;
  callId?: string;
  chatId?: string;
  offer?: RTCSessionDescriptionInit;
  answer?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

export function useRealtimeSocket(
  uid: string | undefined,
  onIncomingCall: (signal: IncomingCallSignal) => void,
  onWebRtcSignal: (event: WebRtcSignalEvent) => void
) {
  const wsRef = useRef<WebSocket | null>(null);
  const [onlineUserIds, setOnlineUserIds] = useState<string[]>([]);
  const [typingByChat, setTypingByChat] = useState<Record<string, Record<string, number>>>({});
  const [connected, setConnected] = useState(false);

  const onIncomingCallRef = useRef(onIncomingCall);
  const onWebRtcSignalRef = useRef(onWebRtcSignal);
  onIncomingCallRef.current = onIncomingCall;
  onWebRtcSignalRef.current = onWebRtcSignal;

  useEffect(() => {
    if (!uid) {
      setOnlineUserIds([]);
      setConnected(false);
      return;
    }

    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

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
        ws.send(JSON.stringify({ type: 'auth', token }));
      };

      ws.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data as string) as {
            type: string;
            onlineIds?: string[];
            chatId?: string;
            senderId?: string;
            isTyping?: boolean;
            callId?: string;
            callType?: CallType;
            callerId?: string;
            callerName?: string;
            callerAvatar?: string;
            offer?: RTCSessionDescriptionInit;
            answer?: RTCSessionDescriptionInit;
            candidate?: RTCIceCandidateInit;
          };

          if (data.type === 'auth:ok') {
            setConnected(true);
            return;
          }
          if (data.type === 'presence:list' && Array.isArray(data.onlineIds)) {
            setOnlineUserIds(data.onlineIds);
            return;
          }
          if (data.type === 'typing' && data.chatId && data.senderId) {
            setTypingByChat((prev) => {
              const chatMap = { ...(prev[data.chatId!] || {}) };
              if (data.isTyping) {
                chatMap[data.senderId!] = Date.now() + 4000;
              } else {
                delete chatMap[data.senderId!];
              }
              return { ...prev, [data.chatId!]: chatMap };
            });
            return;
          }
          if (data.type === 'call:invite' && data.callId && data.callerId) {
            onIncomingCallRef.current({
              callId: data.callId,
              chatId: data.chatId || '',
              callType: data.callType || 'video',
              callerId: data.callerId,
              callerName: data.callerName || 'User',
              callerAvatar: data.callerAvatar || '',
            });
            return;
          }
          if (
            data.type === 'call:accept' ||
            data.type === 'call:decline' ||
            data.type === 'call:end' ||
            data.type === 'webrtc:offer' ||
            data.type === 'webrtc:answer' ||
            data.type === 'webrtc:ice-candidate'
          ) {
            onWebRtcSignalRef.current(data as WebRtcSignalEvent);
          }
        } catch {
          // Ignore malformed frame
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (!cancelled) {
          reconnectTimer = setTimeout(() => {
            void connect();
          }, 2500);
        }
      };
    };

    void connect();

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
      clearInterval(pruneInterval);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [uid]);

  const sendSocketEvent = useCallback((payload: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }, []);

  return { onlineUserIds, typingByChat, connected, sendSocketEvent };
}

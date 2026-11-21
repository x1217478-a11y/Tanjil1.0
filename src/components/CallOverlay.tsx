import { useEffect, useRef, useState } from 'react';
import { addDoc, collection, doc, onSnapshot, serverTimestamp, updateDoc } from 'firebase/firestore';
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  PhoneOff,
  Phone,
  MonitorUp,
  Minimize2,
  Maximize2,
  ShieldCheck,
  RefreshCw,
  SwitchCamera,
} from 'lucide-react';
import { db } from '../lib/firebase';
import { acquireCallMediaStream, fetchIceServersConfig } from '../lib/permissions';
import { formatDurationClock } from '../lib/security';
import { Avatar } from './Avatar';
import type { CallType } from '../types/app';
import type { WebRtcSignalEvent } from '../hooks/useRealtimeSocket';

export interface ActiveCallSession {
  callId: string;
  chatId: string;
  direction: 'outgoing' | 'incoming';
  callType: CallType;
  peerId: string;
  peerName: string;
  peerAvatar: string;
  status: 'ringing' | 'connecting' | 'connected';
}

interface CallOverlayProps {
  session: ActiveCallSession | null;
  currentUid: string;
  currentDisplayName: string;
  sendSocketEvent: (payload: Record<string, unknown>) => void;
  subscribeSignals: (listener: (event: WebRtcSignalEvent) => void) => () => void;
  onUpdateStatus: (status: ActiveCallSession['status']) => void;
  onClose: () => void;
}

export function CallOverlay({
  session,
  currentUid,
  currentDisplayName,
  sendSocketEvent,
  subscribeSignals,
  onUpdateStatus,
  onClose,
}: CallOverlayProps) {
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const pcPromiseRef = useRef<Promise<RTCPeerConnection> | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const activePeerRef = useRef<string>('');
  const callLoggedRef = useRef<boolean>(false);
  const offerSentRef = useRef<boolean>(false);
  const signalQueueRef = useRef<Promise<void>>(Promise.resolve());

  const [micMuted, setMicMuted] = useState(false);
  const [camOff, setCamOff] = useState(false);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const [screenSharing, setScreenSharing] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [mediaError, setMediaError] = useState('');
  const [networkNotice, setNetworkNotice] = useState('');
  const [hasRemoteStream, setHasRemoteStream] = useState(false);
  const [audioPlayBlocked, setAudioPlayBlocked] = useState(false);

  const sessionRef = useRef(session);
  sessionRef.current = session;

  const cleanupCallMedia = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.onicecandidate = null;
      pcRef.current.ontrack = null;
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.oniceconnectionstatechange = null;
      pcRef.current.close();
      pcRef.current = null;
    }
    pcPromiseRef.current = null;
    pendingCandidatesRef.current = [];
    offerSentRef.current = false;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    setHasRemoteStream(false);
    setAudioPlayBlocked(false);
    setElapsedSec(0);
    setMicMuted(false);
    setCamOff(false);
    setScreenSharing(false);
    setMediaError('');
    setNetworkNotice('');
  };

  useEffect(() => {
    return () => {
      cleanupCallMedia();
    };
  }, []);

  // Gentle Web Audio ringtone while status === 'ringing'
  useEffect(() => {
    if (!session || session.status !== 'ringing') return;
    let ctx: AudioContext | null = null;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const playTone = () => {
      try {
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!ctx) ctx = new AudioCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = session.direction === 'incoming' ? 523.25 : 440;
        gain.gain.setValueAtTime(0.03, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.65);
      } catch {
        // Ignore browser autoplay audio block
      }
    };

    playTone();
    intervalId = setInterval(playTone, 2200);
    return () => {
      if (intervalId) clearInterval(intervalId);
      if (ctx) void ctx.close().catch(() => {});
    };
  }, [session?.callId, session?.status, session?.direction]);

  // Call duration timer
  useEffect(() => {
    if (!session || session.status !== 'connected') return;
    const id = setInterval(() => {
      setElapsedSec((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(id);
  }, [session?.status]);

  // Sync remote call acceptance/termination via Firestore in case WebSocket dropped a frame
  useEffect(() => {
    if (!session?.callId) return;
    const unsub = onSnapshot(
      doc(db, 'calls', session.callId),
      (snap) => {
        if (!snap.exists()) return;
        const data = snap.data() as { status?: string };
        if (
          data.status === 'ended' ||
          data.status === 'declined' ||
          data.status === 'missed'
        ) {
          cleanupCallMedia();
          onClose();
        } else if (
          data.status === 'active' &&
          sessionRef.current?.direction === 'outgoing' &&
          !offerSentRef.current
        ) {
          void sendOfferForActiveCall();
        }
      },
      () => {}
    );
    return () => unsub();
  }, [session?.callId]);

  // Auto-end unanswered outgoing calls after 45s and mark as missed
  useEffect(() => {
    if (!session || session.direction !== 'outgoing' || session.status !== 'ringing') return;
    const timeoutId = setTimeout(() => {
      const active = sessionRef.current;
      if (!active || active.status !== 'ringing') return;
      sendSocketEvent({
        type: 'call:end',
        targetUid: activePeerRef.current || active.peerId,
        callId: active.callId,
      });
      void updateDoc(doc(db, 'calls', active.callId), {
        status: 'missed',
        durationSeconds: 0,
        updatedAt: serverTimestamp(),
      }).catch(() => {});
      logCallToChat(0, true);
      cleanupCallMedia();
      onClose();
    }, 45_000);
    return () => clearTimeout(timeoutId);
  }, [session?.callId, session?.direction, session?.status]);

  const flushPendingCandidates = async (pc: RTCPeerConnection) => {
    if (!pc.remoteDescription) return;
    const queued = pendingCandidatesRef.current.splice(0);
    for (const c of queued) {
      await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
    }
  };

  const applySenderBitrateCaps = async (pc: RTCPeerConnection) => {
    for (const sender of pc.getSenders()) {
      const kind = sender.track?.kind;
      if (!kind || typeof sender.getParameters !== 'function') continue;
      try {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        const targetCap = kind === 'video' ? 900_000 : 64_000;
        params.encodings = params.encodings.map((enc) => ({
          ...enc,
          maxBitrate: targetCap,
        }));
        await sender.setParameters(params);
      } catch {
        // Ignore if browser restricts RTCRtpSender.setParameters on this track
      }
    }
  };

  const attachLocalTracks = async (pc: RTCPeerConnection, withVideo: boolean) => {
    if (localStreamRef.current) return;
    const { stream, videoActive, warning } = await acquireCallMediaStream(withVideo);
    if (warning) setMediaError(warning);
    if (!stream) return;

    localStreamRef.current = stream;
    if (withVideo && !videoActive) {
      setCamOff(true);
    }
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
    }

    stream.getTracks().forEach((track) => {
      const alreadyAdded = pc.getSenders().some((s) => s.track === track);
      if (!alreadyAdded) {
        pc.addTrack(track, stream);
      }
    });
    await applySenderBitrateCaps(pc);
  };

  // Initialize local media + PeerConnection (deduplicated via pcPromiseRef)
  const setupPeerConnection = async (withVideo: boolean): Promise<RTCPeerConnection> => {
    if (pcRef.current) return pcRef.current;
    if (pcPromiseRef.current) return pcPromiseRef.current;

    const promise = (async () => {
      const rtcConfig = await fetchIceServersConfig();
      const pc = new RTCPeerConnection(rtcConfig);
      pcRef.current = pc;

      await attachLocalTracks(pc, withVideo);

      pc.ontrack = (event) => {
        const [remoteStream] = event.streams;
        const streamToUse = remoteStream || new MediaStream([event.track]);
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = streamToUse;
        }
        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = streamToUse;
          void remoteAudioRef.current
            .play()
            .then(() => setAudioPlayBlocked(false))
            .catch(() => setAudioPlayBlocked(true));
        }
        setHasRemoteStream(true);
      };

      pc.onicecandidate = (event) => {
        if (event.candidate && sessionRef.current) {
          const target = activePeerRef.current || sessionRef.current.peerId;
          sendSocketEvent({
            type: 'webrtc:ice-candidate',
            targetUid: target,
            callId: sessionRef.current.callId,
            candidate: event.candidate.toJSON(),
          });
        }
      };

      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          setNetworkNotice('');
          onUpdateStatus('connected');
        } else if (pc.iceConnectionState === 'disconnected') {
          setNetworkNotice('Reconnecting network...');
        } else if (pc.iceConnectionState === 'failed') {
          setNetworkNotice('Attempting ICE network recovery...');
          try {
            pc.restartIce();
          } catch {
            // Ignore if browser does not support restartIce
          }
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          setNetworkNotice('');
          onUpdateStatus('connected');
        } else if (pc.connectionState === 'failed') {
          setNetworkNotice('Connection unstable — trying fallback route...');
        }
      };

      return pc;
    })();

    pcPromiseRef.current = promise;
    try {
      return await promise;
    } finally {
      pcPromiseRef.current = null;
    }
  };

  const sendOfferForActiveCall = async () => {
    const active = sessionRef.current;
    if (!active || offerSentRef.current) return;
    offerSentRef.current = true;
    onUpdateStatus('connecting');
    try {
      const pc = await setupPeerConnection(active.callType !== 'audio');
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: active.callType !== 'audio',
      });
      await pc.setLocalDescription(offer);
      sendSocketEvent({
        type: 'webrtc:offer',
        targetUid: activePeerRef.current || active.peerId,
        callId: active.callId,
        offer,
      });
    } catch {
      offerSentRef.current = false;
      setNetworkNotice('Call negotiation hit a network error. Retrying...');
    }
  };

  // Start outgoing media preview immediately when dialing
  useEffect(() => {
    if (!session) {
      cleanupCallMedia();
      return;
    }
    callLoggedRef.current = false;
    offerSentRef.current = false;
    activePeerRef.current = session.peerId;
    if (session.direction === 'outgoing' && session.status === 'ringing') {
      void setupPeerConnection(session.callType !== 'audio');
    }
  }, [session?.callId]);

  // Subscribe sequentially to incoming WebRTC signaling events without dropping batched frames
  useEffect(() => {
    if (!session?.callId) return;

    const processSignal = async (signal: WebRtcSignalEvent) => {
      const active = sessionRef.current;
      if (!active) return;
      if (signal.callId && signal.callId !== active.callId) return;

      if (signal.senderId) {
        activePeerRef.current = signal.senderId;
      }

      try {
        if (signal.type === 'call:busy') {
          setNetworkNotice(`${active.peerName} is currently on another call.`);
          setTimeout(() => {
            cleanupCallMedia();
            onClose();
          }, 1800);
          return;
        }

        if (signal.type === 'call:accept') {
          await sendOfferForActiveCall();
        } else if (signal.type === 'webrtc:offer' && signal.offer) {
          onUpdateStatus('connecting');
          const pc = await setupPeerConnection(active.callType !== 'audio');
          if (pc.signalingState !== 'stable') {
            await pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
          }
          await pc.setRemoteDescription(new RTCSessionDescription(signal.offer));
          await flushPendingCandidates(pc);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendSocketEvent({
            type: 'webrtc:answer',
            targetUid: activePeerRef.current || active.peerId,
            callId: active.callId,
            answer,
          });
        } else if (signal.type === 'webrtc:answer' && signal.answer) {
          const pc = await setupPeerConnection(active.callType !== 'audio');
          if (pc.signalingState === 'have-local-offer') {
            await pc.setRemoteDescription(new RTCSessionDescription(signal.answer));
            await flushPendingCandidates(pc);
          }
        } else if (signal.type === 'webrtc:ice-candidate' && signal.candidate) {
          const pc = pcRef.current;
          if (pc && pc.remoteDescription) {
            await pc.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(() => {});
          } else {
            pendingCandidatesRef.current.push(signal.candidate);
          }
        } else if (signal.type === 'call:decline' || signal.type === 'call:end') {
          cleanupCallMedia();
          onClose();
        }
      } catch {
        setNetworkNotice('Call negotiation hit a network error. Retrying...');
      }
    };

    const unsub = subscribeSignals((signal) => {
      signalQueueRef.current = signalQueueRef.current.then(() => processSignal(signal));
    });
    return () => unsub();
  }, [session?.callId, subscribeSignals]);

  if (!session) return null;

  const handleRetryPermissions = async () => {
    setMediaError('');
    if (pcRef.current) {
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
        localStreamRef.current = null;
      }
      await attachLocalTracks(pcRef.current, session.callType !== 'audio');
    } else {
      await setupPeerConnection(session.callType !== 'audio');
    }
  };

  const handleAcceptIncoming = async () => {
    onUpdateStatus('connecting');
    await setupPeerConnection(session.callType !== 'audio');
    sendSocketEvent({
      type: 'call:accept',
      targetUid: activePeerRef.current || session.peerId,
      callId: session.callId,
    });
    void updateDoc(doc(db, 'calls', session.callId), {
      status: 'active',
      updatedAt: serverTimestamp(),
    }).catch(() => {});
  };

  const logCallToChat = (finalDurationSec: number, wasDeclinedOrMissed: boolean) => {
    if (!session || callLoggedRef.current || !session.chatId) return;
    if (session.direction !== 'outgoing') return;
    callLoggedRef.current = true;

    const label =
      session.callType === 'audio' ? 'Audio call' : session.callType === 'group' ? 'Group video call' : 'Video call';
    const summaryText =
      finalDurationSec > 0
        ? `${label} · ${formatDurationClock(finalDurationSec)}`
        : wasDeclinedOrMissed
          ? `Missed ${label.toLowerCase()}`
          : `${label} ended`;

    void addDoc(collection(db, 'chats', session.chatId, 'messages'), {
      chatId: session.chatId,
      senderId: currentUid,
      senderName: currentDisplayName.slice(0, 60) || 'Alap User',
      type: 'call',
      text: summaryText,
      mediaUrl: '',
      mediaDurationSec: Math.min(600, Math.max(0, finalDurationSec)),
      replyToId: '',
      replyToPreview: '',
      reactions: [],
      isEdited: false,
      isDeleted: false,
      expiresAtMs: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }).catch(() => {});

    void updateDoc(doc(db, 'chats', session.chatId), {
      lastMessageText: summaryText,
      lastMessageSenderId: currentUid,
      lastMessageAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }).catch(() => {});
  };

  const handleDeclineOrEnd = () => {
    const isIncomingRinging = session.direction === 'incoming' && session.status === 'ringing';
    sendSocketEvent({
      type: isIncomingRinging ? 'call:decline' : 'call:end',
      targetUid: activePeerRef.current || session.peerId,
      callId: session.callId,
    });
    void updateDoc(doc(db, 'calls', session.callId), {
      status: isIncomingRinging ? 'declined' : 'ended',
      durationSeconds: elapsedSec,
      updatedAt: serverTimestamp(),
    }).catch(() => {});
    logCallToChat(elapsedSec, elapsedSec === 0);
    cleanupCallMedia();
    onClose();
  };

  const toggleMic = () => {
    const stream = localStreamRef.current;
    if (stream) {
      stream.getAudioTracks().forEach((t) => {
        t.enabled = micMuted;
      });
    }
    setMicMuted(!micMuted);
  };

  const toggleCamera = async () => {
    const stream = localStreamRef.current;
    const existingVideoTracks = stream?.getVideoTracks() || [];

    if (existingVideoTracks.length > 0) {
      const nextEnabled = camOff;
      existingVideoTracks.forEach((t) => {
        t.enabled = nextEnabled;
      });
      setCamOff(!nextEnabled);
      return;
    }

    if (!camOff) {
      setCamOff(true);
      return;
    }

    // No video track was acquired initially (e.g. camera fallback or upgrade) — acquire camera now
    try {
      const camStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      const newTrack = camStream.getVideoTracks()[0];
      if (!newTrack) return;

      if (localStreamRef.current) {
        localStreamRef.current.addTrack(newTrack);
      } else {
        localStreamRef.current = camStream;
      }
      if (localVideoRef.current && localStreamRef.current) {
        localVideoRef.current.srcObject = localStreamRef.current;
      }

      const pc = pcRef.current;
      if (pc && localStreamRef.current) {
        const videoSender = pc.getSenders().find((s) => s.track?.kind === 'video');
        if (videoSender) {
          await videoSender.replaceTrack(newTrack);
        } else {
          pc.addTrack(newTrack, localStreamRef.current);
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          sendSocketEvent({
            type: 'webrtc:offer',
            targetUid: activePeerRef.current || session.peerId,
            callId: session.callId,
            offer,
          });
        }
        await applySenderBitrateCaps(pc);
      }
      setMediaError('');
      setCamOff(false);
    } catch {
      setMediaError('Camera access was blocked. Allow camera permission in browser settings.');
    }
  };

  const switchCameraFacing = async () => {
    const pc = pcRef.current;
    if (!pc || session.callType === 'audio') return;
    const nextMode: 'user' | 'environment' = facingMode === 'user' ? 'environment' : 'user';
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: nextMode, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      const newTrack = newStream.getVideoTracks()[0];
      if (!newTrack) return;

      const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
      if (sender) {
        await sender.replaceTrack(newTrack);
        await applySenderBitrateCaps(pc);
      }

      if (localStreamRef.current) {
        localStreamRef.current.getVideoTracks().forEach((t) => {
          t.stop();
          localStreamRef.current?.removeTrack(t);
        });
        localStreamRef.current.addTrack(newTrack);
      } else {
        localStreamRef.current = newStream;
      }

      if (localVideoRef.current && localStreamRef.current) {
        localVideoRef.current.srcObject = localStreamRef.current;
      }
      setFacingMode(nextMode);
      setCamOff(false);
    } catch {
      setMediaError('Secondary camera is unavailable on this device.');
    }
  };

  const toggleScreenShare = async () => {
    const pc = pcRef.current;
    if (!pc) return;
    if (!screenSharing) {
      try {
        const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = displayStream.getVideoTracks()[0];
        if (!screenTrack) return;

        const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
        if (sender) {
          await sender.replaceTrack(screenTrack);
        } else {
          pc.addTrack(screenTrack, displayStream);
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          sendSocketEvent({
            type: 'webrtc:offer',
            targetUid: activePeerRef.current || session.peerId,
            callId: session.callId,
            offer,
          });
        }

        if (localVideoRef.current) {
          localVideoRef.current.srcObject = displayStream;
        }
        setScreenSharing(true);
        screenTrack.onended = () => {
          setScreenSharing(false);
          const camTrack = localStreamRef.current?.getVideoTracks()[0];
          const currentSender = pc.getSenders().find((s) => s.track?.kind === 'video');
          if (camTrack && currentSender) {
            void currentSender.replaceTrack(camTrack);
          }
          if (localVideoRef.current && localStreamRef.current) {
            localVideoRef.current.srcObject = localStreamRef.current;
          }
        };
      } catch {
        // User cancelled screen share
      }
    } else {
      const camTrack = localStreamRef.current?.getVideoTracks()[0];
      const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
      if (camTrack && sender) await sender.replaceTrack(camTrack);
      if (localVideoRef.current && localStreamRef.current) {
        localVideoRef.current.srcObject = localStreamRef.current;
      }
      setScreenSharing(false);
    }
  };

  if (minimized) {
    return (
      <>
        <audio ref={remoteAudioRef} autoPlay playsInline className="sr-only" />
        <div className="fixed bottom-20 lg:bottom-6 right-4 z-50 w-72 bg-slate-900 text-white border border-slate-700 rounded-2xl p-3.5 shadow-2xl flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Avatar src={session.peerAvatar} name={session.peerName} size="sm" />
            <div className="min-w-0">
              <p className="text-sm font-semibold truncate">{session.peerName}</p>
              <p className="text-xs font-mono text-sky-400">
                {session.status === 'connected' ? formatDurationClock(elapsedSec) : 'Calling...'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => setMinimized(false)}
              aria-label="Expand call"
              className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 transition-colors"
            >
              <Maximize2 className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={handleDeclineOrEnd}
              aria-label="End call"
              className="p-2 rounded-lg bg-rose-600 hover:bg-rose-500 transition-colors"
            >
              <PhoneOff className="w-4 h-4" />
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/95 backdrop-blur-md flex flex-col justify-between p-4 sm:p-8 text-white">
      <audio ref={remoteAudioRef} autoPlay playsInline className="sr-only" />

      {/* Top Bar */}
      <div className="flex items-center justify-between max-w-5xl w-full mx-auto">
        <div className="flex items-center gap-2 text-xs text-slate-300">
          <ShieldCheck className="w-4 h-4 text-emerald-400" />
          <span>Encrypted WebRTC {session.callType === 'audio' ? 'Audio' : 'HD Video'} Call</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono text-sky-400">
            {networkNotice
              ? networkNotice
              : session.status === 'connected'
                ? formatDurationClock(elapsedSec)
                : session.status === 'connecting'
                  ? 'Connecting...'
                  : session.direction === 'incoming'
                    ? 'Incoming Call'
                    : 'Ringing...'}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setMinimized(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium transition-colors"
        >
          <Minimize2 className="w-3.5 h-3.5" />
          Minimize
        </button>
      </div>

      {/* Main Call Stage */}
      <div className="relative flex-1 max-w-5xl w-full mx-auto my-4 rounded-3xl overflow-hidden bg-slate-900 border border-slate-800 flex items-center justify-center">
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          muted
          className={`w-full h-full object-cover ${
            hasRemoteStream && (session.callType !== 'audio' || screenSharing) ? 'block' : 'hidden'
          }`}
        />

        {(!hasRemoteStream || (session.callType === 'audio' && !screenSharing)) && (
          <div className="flex flex-col items-center text-center p-8 space-y-4">
            <Avatar src={session.peerAvatar} name={session.peerName} size="xl" />
            <div>
              <h2 className="font-display text-2xl font-bold">{session.peerName}</h2>
              <p className="text-sm text-slate-400 mt-1">
                {session.status === 'connected'
                  ? `Connected · ${formatDurationClock(elapsedSec)}`
                  : session.direction === 'incoming'
                    ? `Incoming ${session.callType} call`
                    : 'Waiting for answer...'}
              </p>
              {audioPlayBlocked && (
                <button
                  type="button"
                  onClick={() => {
                    void remoteAudioRef.current
                      ?.play()
                      .then(() => setAudioPlayBlocked(false))
                      .catch(() => {});
                  }}
                  className="mt-2 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-xs font-semibold text-white transition-colors"
                >
                  Tap to Enable Call Audio
                </button>
              )}
              {mediaError && (
                <div className="mt-3 space-y-2">
                  <p className="text-xs text-amber-400 max-w-sm">{mediaError}</p>
                  <button
                    type="button"
                    onClick={() => void handleRetryPermissions()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-white"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Retry Camera / Mic
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Local Self-View PiP */}
        {(session.callType !== 'audio' || screenSharing) && (
          <div className="absolute bottom-4 right-4 w-32 sm:w-44 aspect-[3/4] sm:aspect-video rounded-2xl overflow-hidden bg-slate-950 border border-slate-700 shadow-xl">
            <video
              ref={localVideoRef}
              autoPlay
              muted
              playsInline
              className={`w-full h-full object-cover ${screenSharing ? '' : '-scale-x-100'} ${camOff ? 'hidden' : 'block'}`}
            />
            {camOff && (
              <div className="w-full h-full flex items-center justify-center text-xs text-slate-400">
                Camera Off
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom Controls */}
      <div className="flex items-center justify-center gap-3 sm:gap-4 max-w-xl w-full mx-auto pb-2">
        {session.direction === 'incoming' && session.status === 'ringing' ? (
          <>
            <button
              type="button"
              onClick={handleDeclineOrEnd}
              className="h-14 px-7 rounded-2xl bg-rose-600 hover:bg-rose-500 text-white font-semibold text-sm inline-flex items-center gap-2 transition-colors"
            >
              <PhoneOff className="w-5 h-5" />
              Decline
            </button>
            <button
              type="button"
              onClick={handleAcceptIncoming}
              className="h-14 px-8 rounded-2xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-sm inline-flex items-center gap-2 transition-colors"
            >
              <Phone className="w-5 h-5" />
              Accept
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={toggleMic}
              aria-label={micMuted ? 'Unmute microphone' : 'Mute microphone'}
              className={`w-13 h-13 rounded-2xl flex items-center justify-center transition-colors ${
                micMuted ? 'bg-rose-600 text-white' : 'bg-slate-800 hover:bg-slate-700 text-white'
              }`}
            >
              {micMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
            </button>

            {session.callType !== 'audio' && (
              <>
                <button
                  type="button"
                  onClick={() => void toggleCamera()}
                  aria-label={camOff ? 'Turn camera on' : 'Turn camera off'}
                  className={`w-13 h-13 rounded-2xl flex items-center justify-center transition-colors ${
                    camOff ? 'bg-rose-600 text-white' : 'bg-slate-800 hover:bg-slate-700 text-white'
                  }`}
                >
                  {camOff ? <VideoOff className="w-5 h-5" /> : <Video className="w-5 h-5" />}
                </button>
                <button
                  type="button"
                  onClick={() => void switchCameraFacing()}
                  aria-label="Switch front or back camera"
                  title="Switch Camera"
                  className="w-13 h-13 rounded-2xl flex items-center justify-center bg-slate-800 hover:bg-slate-700 text-white transition-colors"
                >
                  <SwitchCamera className="w-5 h-5" />
                </button>
              </>
            )}

            <button
              type="button"
              onClick={toggleScreenShare}
              aria-label="Share screen"
              className={`w-13 h-13 rounded-2xl flex items-center justify-center transition-colors ${
                screenSharing ? 'bg-sky-600 text-white' : 'bg-slate-800 hover:bg-slate-700 text-white'
              }`}
            >
              <MonitorUp className="w-5 h-5" />
            </button>

            <button
              type="button"
              onClick={handleDeclineOrEnd}
              aria-label="End call"
              className="h-13 px-6 rounded-2xl bg-rose-600 hover:bg-rose-500 text-white font-semibold text-sm inline-flex items-center gap-2 transition-colors"
            >
              <PhoneOff className="w-5 h-5" />
              End
            </button>
          </>
        )}
      </div>

      <span className="sr-only">Active user: {currentUid}</span>
    </div>
  );
}

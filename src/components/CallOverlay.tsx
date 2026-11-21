import { useEffect, useRef, useState } from 'react';
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
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
} from 'lucide-react';
import { db } from '../lib/firebase';
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
  sendSocketEvent: (payload: Record<string, unknown>) => void;
  incomingSignal: WebRtcSignalEvent | null;
  onUpdateStatus: (status: ActiveCallSession['status']) => void;
  onClose: () => void;
}

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

export function CallOverlay({
  session,
  currentUid,
  sendSocketEvent,
  incomingSignal,
  onUpdateStatus,
  onClose,
}: CallOverlayProps) {
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  const [micMuted, setMicMuted] = useState(false);
  const [camOff, setCamOff] = useState(false);
  const [screenSharing, setScreenSharing] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [mediaError, setMediaError] = useState('');
  const [hasRemoteStream, setHasRemoteStream] = useState(false);

  const sessionRef = useRef(session);
  sessionRef.current = session;

  // Clean up streams and PeerConnection
  const cleanupCallMedia = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    setHasRemoteStream(false);
    setElapsedSec(0);
    setMicMuted(false);
    setCamOff(false);
    setScreenSharing(false);
    setMediaError('');
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
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
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

  // Initialize local media + PeerConnection
  const setupPeerConnection = async (withVideo: boolean) => {
    if (pcRef.current) return pcRef.current;

    const pc = new RTCPeerConnection(ICE_SERVERS);
    pcRef.current = pc;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: withVideo,
      });
      localStreamRef.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
      stream.getTracks().forEach((track) => {
        pc.addTrack(track, stream);
      });
    } catch {
      setMediaError('Camera or microphone access is unavailable. Audio/video preview disabled.');
    }

    pc.ontrack = (event) => {
      const [remoteStream] = event.streams;
      if (remoteStream && remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStream;
        setHasRemoteStream(true);
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && sessionRef.current) {
        sendSocketEvent({
          type: 'webrtc:ice-candidate',
          targetUid: sessionRef.current.peerId,
          callId: sessionRef.current.callId,
          candidate: event.candidate.toJSON(),
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        onUpdateStatus('connected');
      }
    };

    return pc;
  };

  // Start outgoing media preview immediately when dialing
  useEffect(() => {
    if (!session) {
      cleanupCallMedia();
      return;
    }
    if (session.direction === 'outgoing' && session.status === 'ringing') {
      void setupPeerConnection(session.callType !== 'audio');
    }
  }, [session?.callId]);

  // Handle incoming WebRTC signaling events
  useEffect(() => {
    if (!incomingSignal || !sessionRef.current) return;
    const active = sessionRef.current;
    if (incomingSignal.callId && incomingSignal.callId !== active.callId) return;

    const handleSignal = async () => {
      if (incomingSignal.type === 'call:accept') {
        onUpdateStatus('connecting');
        const pc = await setupPeerConnection(active.callType !== 'audio');
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSocketEvent({
          type: 'webrtc:offer',
          targetUid: active.peerId,
          callId: active.callId,
          offer,
        });
      } else if (incomingSignal.type === 'webrtc:offer' && incomingSignal.offer) {
        onUpdateStatus('connecting');
        const pc = await setupPeerConnection(active.callType !== 'audio');
        await pc.setRemoteDescription(new RTCSessionDescription(incomingSignal.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSocketEvent({
          type: 'webrtc:answer',
          targetUid: active.peerId,
          callId: active.callId,
          answer,
        });
        onUpdateStatus('connected');
      } else if (incomingSignal.type === 'webrtc:answer' && incomingSignal.answer) {
        if (pcRef.current) {
          await pcRef.current.setRemoteDescription(new RTCSessionDescription(incomingSignal.answer));
          onUpdateStatus('connected');
        }
      } else if (incomingSignal.type === 'webrtc:ice-candidate' && incomingSignal.candidate) {
        if (pcRef.current) {
          await pcRef.current.addIceCandidate(new RTCIceCandidate(incomingSignal.candidate)).catch(() => {});
        }
      } else if (incomingSignal.type === 'call:decline' || incomingSignal.type === 'call:end') {
        cleanupCallMedia();
        onClose();
      }
    };

    void handleSignal();
  }, [incomingSignal]);

  if (!session) return null;

  const handleAcceptIncoming = async () => {
    onUpdateStatus('connecting');
    await setupPeerConnection(session.callType !== 'audio');
    sendSocketEvent({
      type: 'call:accept',
      targetUid: session.peerId,
      callId: session.callId,
    });
    void updateDoc(doc(db, 'calls', session.callId), {
      status: 'active',
      updatedAt: serverTimestamp(),
    }).catch(() => {});
  };

  const handleDeclineOrEnd = () => {
    const isIncomingRinging = session.direction === 'incoming' && session.status === 'ringing';
    sendSocketEvent({
      type: isIncomingRinging ? 'call:decline' : 'call:end',
      targetUid: session.peerId,
      callId: session.callId,
    });
    void updateDoc(doc(db, 'calls', session.callId), {
      status: isIncomingRinging ? 'declined' : 'ended',
      durationSeconds: elapsedSec,
      updatedAt: serverTimestamp(),
    }).catch(() => {});
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

  const toggleCamera = () => {
    const stream = localStreamRef.current;
    if (stream) {
      stream.getVideoTracks().forEach((t) => {
        t.enabled = camOff;
      });
    }
    setCamOff(!camOff);
  };

  const toggleScreenShare = async () => {
    if (!pcRef.current) return;
    if (!screenSharing) {
      try {
        const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = displayStream.getVideoTracks()[0];
        const sender = pcRef.current.getSenders().find((s) => s.track?.kind === 'video');
        if (sender && screenTrack) {
          await sender.replaceTrack(screenTrack);
          if (localVideoRef.current) {
            localVideoRef.current.srcObject = displayStream;
          }
          setScreenSharing(true);
          screenTrack.onended = () => {
            setScreenSharing(false);
            const camTrack = localStreamRef.current?.getVideoTracks()[0];
            if (camTrack && sender) void sender.replaceTrack(camTrack);
            if (localVideoRef.current && localStreamRef.current) {
              localVideoRef.current.srcObject = localStreamRef.current;
            }
          };
        }
      } catch {
        // User cancelled screen share
      }
    } else {
      const camTrack = localStreamRef.current?.getVideoTracks()[0];
      const sender = pcRef.current.getSenders().find((s) => s.track?.kind === 'video');
      if (camTrack && sender) await sender.replaceTrack(camTrack);
      if (localVideoRef.current && localStreamRef.current) {
        localVideoRef.current.srcObject = localStreamRef.current;
      }
      setScreenSharing(false);
    }
  };

  if (minimized) {
    return (
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
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/95 backdrop-blur-md flex flex-col justify-between p-4 sm:p-8 text-white">
      {/* Top Bar */}
      <div className="flex items-center justify-between max-w-5xl w-full mx-auto">
        <div className="flex items-center gap-2 text-xs text-slate-300">
          <ShieldCheck className="w-4 h-4 text-emerald-400" />
          <span>Encrypted WebRTC {session.callType === 'audio' ? 'Audio' : 'HD Video'} Call</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono text-sky-400">
            {session.status === 'connected'
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
          className={`w-full h-full object-cover ${hasRemoteStream && session.callType !== 'audio' ? 'block' : 'hidden'}`}
        />

        {(!hasRemoteStream || session.callType === 'audio') && (
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
              {mediaError && <p className="text-xs text-amber-400 mt-2 max-w-sm">{mediaError}</p>}
            </div>
          </div>
        )}

        {/* Local Self-View PiP */}
        {session.callType !== 'audio' && (
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
              <button
                type="button"
                onClick={toggleCamera}
                aria-label={camOff ? 'Turn camera on' : 'Turn camera off'}
                className={`w-13 h-13 rounded-2xl flex items-center justify-center transition-colors ${
                  camOff ? 'bg-rose-600 text-white' : 'bg-slate-800 hover:bg-slate-700 text-white'
                }`}
              >
                {camOff ? <VideoOff className="w-5 h-5" /> : <Video className="w-5 h-5" />}
              </button>
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

      {/* Hidden audio tag for audio-only remote stream */}
      {session.callType === 'audio' && (
        <video ref={remoteVideoRef} autoPlay playsInline className="sr-only" />
      )}
      <span className="sr-only">Active user: {currentUid}</span>
    </div>
  );
}

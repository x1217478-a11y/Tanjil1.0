import React, { useEffect, useRef, useState } from 'react';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  increment,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  Film,
  Plus,
  Heart,
  MessageSquare,
  Volume2,
  VolumeX,
  Play,
  Pause,
  ChevronUp,
  ChevronDown,
  Video,
  Upload,
  Scissors,
  Trash2,
  X,
  Send,
  Square,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { getVideoDuration, uploadMediaBlob } from '../lib/mediaUpload';
import { formatDurationClock, sanitizeMediaUrl } from '../lib/security';
import { Avatar, VerifiedBadge } from './Avatar';
import {
  VALIDATION_CONSTRAINTS,
  type ReelComment,
  type ShortReel,
  type UserPublicProfile,
} from '../types/app';

interface ReelsViewProps {
  currentUser: UserPublicProfile;
  onViewProfile: (uid: string) => void;
}

export function ReelsView({ currentUser, onViewProfile }: ReelsViewProps) {
  const [reels, setReels] = useState<ShortReel[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [muted, setMuted] = useState(false);
  const [paused, setPaused] = useState(false);
  const [likedIds, setLikedIds] = useState<Record<string, boolean>>({});
  const [showComments, setShowComments] = useState(false);
  const [comments, setComments] = useState<ReelComment[]>([]);
  const [commentInput, setCommentInput] = useState('');

  // Uploader & 15s-60s Recorder / Trimmer state
  const [showUploader, setShowUploader] = useState(false);
  const [uploadTab, setUploadTab] = useState<'file' | 'record'>('file');
  const [selectedFile, setSelectedFile] = useState<File | Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [rawDuration, setRawDuration] = useState(0);
  const [trimStart, setTrimStart] = useState(0);
  const [trimLength, setTrimLength] = useState(20);
  const [caption, setCaption] = useState('');
  const [audioTrack, setAudioTrack] = useState('Original Audio');
  const [uploadError, setUploadError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [trimmingProgress, setTrimmingProgress] = useState(false);

  // Live 15s-60s Webcam Recorder
  const recordVideoRef = useRef<HTMLVideoElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordStartMsRef = useRef<number>(0);
  const [isRecording, setIsRecording] = useState(false);
  const [recordSec, setRecordSec] = useState(0);

  const playerRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const q = query(
      collection(db, 'reels'),
      where('durationSeconds', '>=', VALIDATION_CONSTRAINTS.REEL_MIN_DURATION),
      where('durationSeconds', '<=', VALIDATION_CONSTRAINTS.REEL_MAX_DURATION),
      limit(30)
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ShortReel, 'id'>) }));
        list.sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0));
        setReels(list);
        setActiveIndex((prev) => (list.length === 0 ? 0 : Math.min(prev, list.length - 1)));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'reels')
    );
    return () => unsub();
  }, []);

  const activeReel = reels[activeIndex] || null;

  useEffect(() => {
    if (!activeReel) return;
    let cancelled = false;
    void getDoc(doc(db, 'reels', activeReel.id, 'likes', currentUser.uid))
      .then((snap) => {
        if (!cancelled) {
          setLikedIds((prev) => ({ ...prev, [activeReel.id]: snap.exists() }));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeReel?.id, currentUser.uid]);

  useEffect(() => {
    if (!activeReel || !showComments) {
      setComments([]);
      return;
    }
    const q = query(
      collection(db, 'reels', activeReel.id, 'comments'),
      where('reelId', '==', activeReel.id),
      limit(50)
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<ReelComment, 'id'>) }))
          .sort((a, b) => (a.createdAt?.toMillis() || 0) - (b.createdAt?.toMillis() || 0));
        setComments(list);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, `reels/${activeReel.id}/comments`)
    );
    return () => unsub();
  }, [activeReel?.id, showComments]);

  // Live recorder clock (auto-stops at 60s)
  useEffect(() => {
    if (!isRecording) return;
    const id = setInterval(() => {
      setRecordSec((s) => {
        if (s + 1 >= 60) {
          stopCameraRecording();
          return 60;
        }
        return s + 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [isRecording]);

  const resetUploader = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    if (recordVideoRef.current?.srcObject) {
      const stream = recordVideoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach((t) => t.stop());
      recordVideoRef.current.srcObject = null;
    }
    setSelectedFile(null);
    setPreviewUrl('');
    setRawDuration(0);
    setTrimStart(0);
    setTrimLength(20);
    setCaption('');
    setUploadError('');
    setRecordSec(0);
    setIsRecording(false);
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    }
  };

  const handleVideoFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError('');
    try {
      const dur = await getVideoDuration(file);
      if (dur < VALIDATION_CONSTRAINTS.REEL_MIN_DURATION) {
        setUploadError(
          `Video is ${Math.round(dur)}s long. Reels require at least 15 seconds (15s–60s).`
        );
        return;
      }
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      const url = URL.createObjectURL(file);
      setSelectedFile(file);
      setPreviewUrl(url);
      setRawDuration(dur);
      setTrimStart(0);
      setTrimLength(Math.min(60, Math.max(15, Math.floor(dur))));
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Unable to read video metadata');
    } finally {
      e.target.value = '';
    }
  };

  const startCameraRecording = async () => {
    setUploadError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: 720, height: 1280 },
        audio: true,
      });
      if (recordVideoRef.current) {
        recordVideoRef.current.srcObject = stream;
      }
      const recorder = new MediaRecorder(stream);
      recordedChunksRef.current = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) recordedChunksRef.current.push(ev.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(recordedChunksRef.current, {
          type: recorder.mimeType || 'video/webm',
        });
        const url = URL.createObjectURL(blob);
        setSelectedFile(blob);
        setPreviewUrl(url);
        const elapsedSec = Math.round((Date.now() - recordStartMsRef.current) / 1000);
        const dur = Math.max(15, Math.min(60, elapsedSec));
        setRawDuration(dur);
        setTrimStart(0);
        setTrimLength(dur);
      };
      recorderRef.current = recorder;
      recordStartMsRef.current = Date.now();
      setRecordSec(0);
      recorder.start();
      setIsRecording(true);
    } catch {
      setUploadError('Camera and microphone permission required to record a Reel.');
    }
  };

  const stopCameraRecording = () => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      rec.stop();
    }
    setIsRecording(false);
  };

  // Trim video > 60s into a clean 15s-60s clip using an offscreen video + MediaRecorder
  const trimVideoToWindow = async (sourceBlob: Blob, startSec: number, lenSec: number): Promise<Blob> => {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.src = URL.createObjectURL(sourceBlob);
      video.muted = false;
      video.playsInline = true;

      video.onloadedmetadata = async () => {
        video.currentTime = startSec;
      };

      video.onseeked = () => {
        const streamFn = (video as unknown as { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream });
        const stream = streamFn.captureStream ? streamFn.captureStream() : streamFn.mozCaptureStream?.();
        if (!stream) {
          URL.revokeObjectURL(video.src);
          reject(new Error('Browser video trimming is unavailable; upload a 15s–60s video directly.'));
          return;
        }
        const rec = new MediaRecorder(stream);
        const chunks: Blob[] = [];
        rec.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data);
        };
        rec.onstop = () => {
          URL.revokeObjectURL(video.src);
          resolve(new Blob(chunks, { type: rec.mimeType || 'video/webm' }));
        };
        rec.start();
        void video.play();
        setTimeout(() => {
          video.pause();
          if (rec.state !== 'inactive') rec.stop();
        }, lenSec * 1000);
      };

      video.onerror = () => {
        URL.revokeObjectURL(video.src);
        reject(new Error('Failed to trim video'));
      };
    });
  };

  const handlePublishReel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile) return;

    const finalDuration = rawDuration > 60 ? trimLength : Math.round(rawDuration);
    if (finalDuration < 15 || finalDuration > 60) {
      setUploadError('Reel duration must be strictly between 15 and 60 seconds.');
      return;
    }

    setUploading(true);
    setUploadError('');
    try {
      let blobToUpload: Blob = selectedFile;
      if (rawDuration > 60) {
        setTrimmingProgress(true);
        blobToUpload = await trimVideoToWindow(selectedFile, trimStart, trimLength);
        setTrimmingProgress(false);
      }

      const mime = blobToUpload.type || 'video/mp4';
      const videoUrl = await uploadMediaBlob(blobToUpload, mime, 'reel', finalDuration);

      await addDoc(collection(db, 'reels'), {
        authorId: currentUser.uid,
        authorName: currentUser.displayName.slice(0, VALIDATION_CONSTRAINTS.DISPLAY_NAME_MAX),
        authorUsername: currentUser.username,
        authorAvatar: currentUser.avatarUrl || '',
        authorVerified: currentUser.isVerified,
        videoUrl,
        thumbnailUrl: '',
        caption: caption.trim().slice(0, VALIDATION_CONSTRAINTS.REEL_CAPTION_MAX),
        audioTrack: audioTrack.trim().slice(0, 120) || 'Original Audio',
        durationSeconds: finalDuration,
        likesCount: 0,
        commentsCount: 0,
        viewsCount: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      resetUploader();
      setShowUploader(false);
      setActiveIndex(0);
    } catch (err) {
      setTrimmingProgress(false);
      setUploadError(err instanceof Error ? err.message : 'Failed to publish Reel');
    } finally {
      setUploading(false);
    }
  };

  const toggleReelLike = async (reel: ShortReel) => {
    const isLiked = likedIds[reel.id];
    const likeRef = doc(db, 'reels', reel.id, 'likes', currentUser.uid);
    const reelRef = doc(db, 'reels', reel.id);
    try {
      const batch = writeBatch(db);
      if (isLiked) {
        batch.delete(likeRef);
        batch.update(reelRef, { likesCount: increment(-1), updatedAt: serverTimestamp() });
        setLikedIds((p) => ({ ...p, [reel.id]: false }));
      } else {
        batch.set(likeRef, {
          reelId: reel.id,
          userId: currentUser.uid,
          createdAt: serverTimestamp(),
        });
        batch.update(reelRef, { likesCount: increment(1), updatedAt: serverTimestamp() });
        setLikedIds((p) => ({ ...p, [reel.id]: true }));
      }
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `reels/${reel.id}/likes`);
    }
  };

  const handleAddComment = async () => {
    if (!activeReel || !commentInput.trim()) return;
    try {
      const batch = writeBatch(db);
      const commentRef = doc(collection(db, 'reels', activeReel.id, 'comments'));
      batch.set(commentRef, {
        reelId: activeReel.id,
        authorId: currentUser.uid,
        authorName: currentUser.displayName.slice(0, VALIDATION_CONSTRAINTS.DISPLAY_NAME_MAX),
        authorAvatar: currentUser.avatarUrl || '',
        authorVerified: currentUser.isVerified,
        text: commentInput.trim().slice(0, 500),
        createdAt: serverTimestamp(),
      });
      batch.update(doc(db, 'reels', activeReel.id), {
        commentsCount: increment(1),
        updatedAt: serverTimestamp(),
      });
      await batch.commit();
      setCommentInput('');
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `reels/${activeReel.id}/comments`);
    }
  };

  const togglePlay = () => {
    const vid = playerRef.current;
    if (!vid) return;
    if (vid.paused) {
      void vid.play();
      setPaused(false);
    } else {
      vid.pause();
      setPaused(true);
    }
  };

  return (
    <div className="min-h-[calc(100vh-4.5rem)] lg:h-screen flex flex-col bg-slate-950 text-white p-4 sm:p-6 overflow-hidden">
      {/* Top Bar */}
      <div className="max-w-5xl w-full mx-auto flex items-center justify-between gap-4 pb-4 shrink-0">
        <div>
          <h2 className="font-display text-xl font-bold">Reels · 15s to 60s</h2>
          <p className="text-xs text-slate-400">Short vertical videos verified at 15–60 seconds</p>
        </div>
        <button
          type="button"
          onClick={() => setShowUploader(true)}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold transition-colors"
        >
          <Plus className="w-4 h-4" />
          Upload 15–60s Reel
        </button>
      </div>

      {/* Main Reels Player Stage */}
      <div className="flex-1 flex items-center justify-center gap-6 min-h-0">
        {!activeReel ? (
          <div className="max-w-md text-center space-y-4 p-8 rounded-3xl bg-slate-900 border border-slate-800">
            <div className="w-14 h-14 rounded-2xl bg-sky-950 text-sky-400 flex items-center justify-center mx-auto">
              <Film className="w-7 h-7" />
            </div>
            <h3 className="font-display text-lg font-bold">No Reels Published Yet</h3>
            <p className="text-sm text-slate-400">
              Upload a video or record directly with your camera between 15 and 60 seconds to launch the Reels feed.
            </p>
            <button
              type="button"
              onClick={() => setShowUploader(true)}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-sm font-semibold"
            >
              <Plus className="w-4 h-4" />
              Create First Reel
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-4 h-full max-h-[760px]">
            {/* 9:16 Vertical Player */}
            <div className="relative h-full aspect-[9/16] max-w-[92vw] rounded-3xl overflow-hidden bg-black border border-slate-800 shadow-2xl">
              <video
                ref={playerRef}
                key={activeReel.id}
                src={sanitizeMediaUrl(activeReel.videoUrl)}
                autoPlay
                loop
                muted={muted}
                playsInline
                onClick={togglePlay}
                className="w-full h-full object-cover cursor-pointer"
              />

              {/* Top Controls */}
              <div className="absolute top-4 left-4 right-4 flex items-center justify-between pointer-events-none">
                <span className="px-2.5 py-1 rounded-lg bg-black/50 backdrop-blur-md font-mono text-xs">
                  {formatDurationClock(activeReel.durationSeconds)}
                </span>
                <div className="flex items-center gap-2 pointer-events-auto">
                  <button
                    type="button"
                    onClick={() => setMuted(!muted)}
                    className="p-2 rounded-full bg-black/50 backdrop-blur-md hover:bg-black/70"
                  >
                    {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                  </button>
                  {activeReel.authorId === currentUser.uid && (
                    <button
                      type="button"
                      onClick={() => deleteDoc(doc(db, 'reels', activeReel.id))}
                      className="p-2 rounded-full bg-black/50 backdrop-blur-md hover:bg-rose-600"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>

              {paused && (
                <div
                  onClick={togglePlay}
                  className="absolute inset-0 flex items-center justify-center bg-black/25 cursor-pointer"
                >
                  <div className="w-16 h-16 rounded-full bg-black/60 flex items-center justify-center">
                    <Play className="w-7 h-7 fill-white ml-0.5" />
                  </div>
                </div>
              )}

              {/* Bottom Scrim & Metadata */}
              <div className="absolute bottom-0 left-0 right-0 p-5 bg-gradient-to-t from-black/90 via-black/40 to-transparent flex items-end justify-between gap-4">
                <div className="min-w-0 space-y-2">
                  <button
                    type="button"
                    onClick={() => onViewProfile(activeReel.authorId)}
                    className="flex items-center gap-2.5 text-left"
                  >
                    <Avatar src={activeReel.authorAvatar} name={activeReel.authorName} size="sm" />
                    <div>
                      <p className="text-sm font-bold inline-flex items-center gap-1">
                        {activeReel.authorName}
                        {activeReel.authorVerified && <VerifiedBadge className="w-3.5 h-3.5" />}
                      </p>
                      <p className="text-xs text-slate-300">@{activeReel.authorUsername}</p>
                    </div>
                  </button>
                  {activeReel.caption && (
                    <p className="text-sm text-white/95 line-clamp-2">{activeReel.caption}</p>
                  )}
                  <p className="text-xs text-slate-300 truncate">
                    ♪ {activeReel.audioTrack || 'Original Audio'}
                  </p>
                </div>

                {/* Right Overlay Actions */}
                <div className="flex flex-col items-center gap-4 shrink-0">
                  <button
                    type="button"
                    onClick={() => toggleReelLike(activeReel)}
                    className="flex flex-col items-center gap-1"
                  >
                    <div
                      className={`w-11 h-11 rounded-full flex items-center justify-center backdrop-blur-md ${
                        likedIds[activeReel.id] ? 'bg-rose-600 text-white' : 'bg-black/50 text-white'
                      }`}
                    >
                      <Heart className={`w-5 h-5 ${likedIds[activeReel.id] ? 'fill-white' : ''}`} />
                    </div>
                    <span className="text-xs font-mono">{activeReel.likesCount}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setShowComments(!showComments)}
                    className="flex flex-col items-center gap-1"
                  >
                    <div className="w-11 h-11 rounded-full bg-black/50 backdrop-blur-md flex items-center justify-center">
                      <MessageSquare className="w-5 h-5" />
                    </div>
                    <span className="text-xs font-mono">{activeReel.commentsCount}</span>
                  </button>

                  <button
                    type="button"
                    onClick={togglePlay}
                    className="w-11 h-11 rounded-full bg-black/50 backdrop-blur-md flex items-center justify-center"
                  >
                    {paused ? <Play className="w-5 h-5" /> : <Pause className="w-5 h-5" />}
                  </button>
                </div>
              </div>
            </div>

            {/* Reel Up / Down Switcher */}
            <div className="hidden sm:flex flex-col gap-2">
              <button
                type="button"
                disabled={activeIndex === 0}
                onClick={() => setActiveIndex((i) => Math.max(0, i - 1))}
                className="p-3 rounded-2xl bg-slate-900 border border-slate-800 hover:bg-slate-800 disabled:opacity-30"
              >
                <ChevronUp className="w-5 h-5" />
              </button>
              <button
                type="button"
                disabled={activeIndex >= reels.length - 1}
                onClick={() => setActiveIndex((i) => Math.min(reels.length - 1, i + 1))}
                className="p-3 rounded-2xl bg-slate-900 border border-slate-800 hover:bg-slate-800 disabled:opacity-30"
              >
                <ChevronDown className="w-5 h-5" />
              </button>
            </div>

            {/* Reel Comments Drawer */}
            {showComments && (
              <div className="fixed inset-x-4 bottom-20 top-24 z-40 sm:static sm:z-auto sm:w-80 sm:h-full bg-slate-900 border border-slate-800 rounded-3xl p-4 flex flex-col shadow-2xl sm:shadow-none">
                <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                  <h4 className="font-display font-bold text-sm">
                    Comments ({activeReel.commentsCount})
                  </h4>
                  <button type="button" onClick={() => setShowComments(false)}>
                    <X className="w-4 h-4 text-slate-400" />
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto py-3 space-y-3">
                  {comments.map((c) => (
                    <div key={c.id} className="flex items-start gap-2.5">
                      <Avatar src={c.authorAvatar} name={c.authorName} size="xs" />
                      <div className="text-xs">
                        <p className="font-semibold text-white">{c.authorName}</p>
                        <p className="text-slate-300 mt-0.5">{c.text}</p>
                      </div>
                    </div>
                  ))}
                  {comments.length === 0 && (
                    <p className="text-xs text-slate-500 text-center py-8">Be the first to comment</p>
                  )}
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void handleAddComment();
                  }}
                  className="flex items-center gap-2 pt-3 border-t border-slate-800"
                >
                  <input
                    type="text"
                    value={commentInput}
                    onChange={(e) => setCommentInput(e.target.value)}
                    placeholder="Add a comment..."
                    className="flex-1 px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-white focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={!commentInput.trim()}
                    className="p-2 rounded-xl bg-sky-600 disabled:opacity-40 text-white"
                  >
                    <Send className="w-3.5 h-3.5" />
                  </button>
                </form>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Modal: 15s-60s Reel Uploader & Trimmer */}
      {showUploader && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4">
          <form
            onSubmit={handlePublishReel}
            className="w-full max-w-lg bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4 text-white max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-display font-bold text-lg">Upload 15s–60s Video Reel</h3>
                <p className="text-xs text-slate-400">
                  Strict duration check: 15 seconds minimum, 60 seconds maximum.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  resetUploader();
                  setShowUploader(false);
                }}
                className="p-1 text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-slate-950 border border-slate-800">
              <button
                type="button"
                onClick={() => {
                  resetUploader();
                  setUploadTab('file');
                }}
                className={`py-2 text-xs font-semibold rounded-lg inline-flex items-center justify-center gap-1.5 ${
                  uploadTab === 'file' ? 'bg-slate-800 text-white' : 'text-slate-400'
                }`}
              >
                <Upload className="w-3.5 h-3.5" />
                Upload & Trim Video
              </button>
              <button
                type="button"
                onClick={() => {
                  resetUploader();
                  setUploadTab('record');
                }}
                className={`py-2 text-xs font-semibold rounded-lg inline-flex items-center justify-center gap-1.5 ${
                  uploadTab === 'record' ? 'bg-slate-800 text-white' : 'text-slate-400'
                }`}
              >
                <Video className="w-3.5 h-3.5" />
                Record 15s–60s Live
              </button>
            </div>

            {uploadTab === 'file' && !previewUrl && (
              <label className="block border border-dashed border-slate-700 hover:border-sky-500 rounded-2xl p-8 text-center cursor-pointer transition-colors">
                <Film className="w-8 h-8 text-sky-400 mx-auto mb-2" />
                <p className="text-sm font-semibold">Select MP4, WebM, or MOV video</p>
                <p className="text-xs text-slate-400 mt-1">
                  Videos over 60s open the built-in 15–60s trimmer
                </p>
                <input
                  type="file"
                  accept="video/mp4,video/webm,video/quicktime"
                  onChange={handleVideoFileSelect}
                  className="sr-only"
                />
              </label>
            )}

            {uploadTab === 'record' && !previewUrl && (
              <div className="space-y-3">
                <div className="relative h-64 rounded-2xl overflow-hidden bg-black border border-slate-800">
                  <video
                    ref={recordVideoRef}
                    autoPlay
                    muted
                    playsInline
                    className="w-full h-full object-cover -scale-x-100"
                  />
                  <div className="absolute top-3 left-3 px-2.5 py-1 rounded-lg bg-black/60 font-mono text-xs">
                    {formatDurationClock(recordSec)} / 01:00
                  </div>
                </div>
                <div className="flex justify-center">
                  {!isRecording ? (
                    <button
                      type="button"
                      onClick={startCameraRecording}
                      className="px-5 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold inline-flex items-center gap-2"
                    >
                      <Video className="w-4 h-4" />
                      Start Recording (Min 15s)
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={recordSec < 15}
                      onClick={stopCameraRecording}
                      className="px-5 py-2.5 rounded-xl bg-emerald-600 disabled:bg-slate-700 text-white text-xs font-semibold inline-flex items-center gap-2"
                    >
                      <Square className="w-4 h-4 fill-current" />
                      {recordSec < 15
                        ? `Keep recording (${15 - recordSec}s left)...`
                        : `Finish Reel (${recordSec}s)`}
                    </button>
                  )}
                </div>
              </div>
            )}

            {previewUrl && (
              <div className="space-y-3">
                <video
                  src={previewUrl}
                  controls
                  className="w-full max-h-60 rounded-2xl bg-black border border-slate-800"
                />

                {rawDuration > 60 && (
                  <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 space-y-2.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="inline-flex items-center gap-1.5 font-semibold text-sky-400">
                        <Scissors className="w-3.5 h-3.5" />
                        Video Trimmer ({Math.round(rawDuration)}s total)
                      </span>
                      <span className="font-mono">
                        Clip: {trimStart}s → {trimStart + trimLength}s ({trimLength}s)
                      </span>
                    </div>
                    <div className="space-y-2 text-xs">
                      <label className="block">
                        Start second ({trimStart}s)
                        <input
                          type="range"
                          min={0}
                          max={Math.max(0, Math.floor(rawDuration - trimLength))}
                          value={trimStart}
                          onChange={(e) => setTrimStart(Number(e.target.value))}
                          className="w-full mt-1"
                        />
                      </label>
                      <label className="block">
                        Reel duration ({trimLength}s · 15–60s)
                        <input
                          type="range"
                          min={15}
                          max={60}
                          value={trimLength}
                          onChange={(e) => setTrimLength(Number(e.target.value))}
                          className="w-full mt-1"
                        />
                      </label>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <input
                    type="text"
                    maxLength={VALIDATION_CONSTRAINTS.REEL_CAPTION_MAX}
                    value={caption}
                    onChange={(e) => setCaption(e.target.value)}
                    placeholder="Write a reel caption..."
                    className="px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-xs"
                  />
                  <input
                    type="text"
                    maxLength={120}
                    value={audioTrack}
                    onChange={(e) => setAudioTrack(e.target.value)}
                    placeholder="Audio track title"
                    className="px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-xs"
                  />
                </div>
              </div>
            )}

            {uploadError && (
              <p className="text-xs text-rose-400 bg-rose-950/50 border border-rose-900 rounded-xl px-3 py-2">
                {uploadError}
              </p>
            )}

            {previewUrl && (
              <button
                type="submit"
                disabled={uploading}
                className="w-full py-3 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white text-sm font-semibold"
              >
                {trimmingProgress
                  ? 'Trimming video segment...'
                  : uploading
                    ? 'Uploading Reel...'
                    : 'Publish Reel'}
              </button>
            )}
          </form>
        </div>
      )}
    </div>
  );
}

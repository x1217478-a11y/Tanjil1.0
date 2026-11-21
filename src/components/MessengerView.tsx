import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  doc,
  getDoc,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  Search,
  Plus,
  Users,
  Phone,
  Video,
  Info,
  Send,
  Mic,
  Square,
  Image as ImageIcon,
  Smile,
  Lock,
  Unlock,
  Clock,
  Reply,
  Trash2,
  Edit3,
  Check,
  CheckCheck,
  Pin,
  BellOff,
  Archive,
  ShieldCheck,
  UserPlus,
  X,
  ArrowLeft,
  Sparkles,
  FileText,
  Download,
  Copy,
  PhoneCall,
  UserMinus,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { generateAiText } from '../lib/aiClient';
import { compressImageFile, uploadMediaBlob } from '../lib/mediaUpload';
import {
  checkDevicePermissions,
  requestMediaPermission,
  requestNotificationPermission,
} from '../lib/permissions';
import { formatDurationClock, formatRelativeTime, generateSafetyCode, sanitizeMediaUrl, sha256Hex } from '../lib/security';
import { Avatar, VerifiedBadge } from './Avatar';
import {
  VALIDATION_CONSTRAINTS,
  type CallType,
  type ChatMember,
  type ChatMessage,
  type ChatRoom,
  type UserPrivateInfo,
  type UserPublicProfile,
} from '../types/app';

interface MessengerViewProps {
  currentUser: UserPublicProfile;
  privateInfo: UserPrivateInfo | null;
  allUsers: UserPublicProfile[];
  onlineUserIds: string[];
  typingByChat: Record<string, Record<string, number>>;
  wsConnected?: boolean;
  sendSocketEvent: (payload: Record<string, unknown>) => void;
  initialChatId?: string | null;
  initialDraftText?: string | null;
  onConsumeDraft?: () => void;
  onStartCall: (chat: ChatRoom, peer: UserPublicProfile | null, callType: CallType) => void;
  onViewProfile: (uid: string) => void;
}

const QUICK_EMOJIS = ['❤️', '😂', '😮', '😢', '👍', '🔥', '🎉', '🙏'];

export function MessengerView({
  currentUser,
  privateInfo,
  allUsers,
  onlineUserIds,
  typingByChat,
  wsConnected = true,
  sendSocketEvent,
  initialChatId,
  initialDraftText,
  onConsumeDraft,
  onStartCall,
  onViewProfile,
}: MessengerViewProps) {
  const [chats, setChats] = useState<ChatRoom[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(initialChatId || null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [memberSettings, setMemberSettings] = useState<Record<string, ChatMember>>({});
  const [myMemberByChat, setMyMemberByChat] = useState<Record<string, ChatMember>>({});
  const [chatFilter, setChatFilter] = useState<'all' | 'direct' | 'group' | 'archived'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [showInspector, setShowInspector] = useState(false);

  // Composer state
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [composerError, setComposerError] = useState('');

  // Voice Note recording
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  const [recordingSec, setRecordingSec] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const voiceStartMsRef = useRef<number>(0);

  // Modals
  const [showNewDirectModal, setShowNewDirectModal] = useState(false);
  const [showNewGroupModal, setShowNewGroupModal] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [selectedGroupUids, setSelectedGroupUids] = useState<string[]>([]);
  const [addMemberUid, setAddMemberUid] = useState('');

  // Chat PIN Lock Gate
  const [unlockedChatIds, setUnlockedChatIds] = useState<Record<string, boolean>>({});
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState('');

  // Gemini AI Assist
  const [showAiAssist, setShowAiAssist] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiResult, setAiResult] = useState('');
  const [aiError, setAiError] = useState('');
  const [aiLoading, setAiLoading] = useState(false);

  // Thread UX enhancements & group admin controls
  const [lightboxImageUrl, setLightboxImageUrl] = useState<string | null>(null);
  const [threadSearchOpen, setThreadSearchOpen] = useState(false);
  const [threadSearchQuery, setThreadSearchQuery] = useState('');
  const [editingGroupName, setEditingGroupName] = useState(false);
  const [groupNameDraft, setGroupNameDraft] = useState('');
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [showMediaPermBar, setShowMediaPermBar] = useState(false);
  const [networkOnline, setNetworkOnline] = useState<boolean>(
    typeof navigator === 'undefined' ? true : navigator.onLine
  );

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastReadWriteRef = useRef<Record<string, number>>({});

  useEffect(() => {
    void checkDevicePermissions().then((p) => {
      if (p.camera !== 'granted' || p.microphone !== 'granted') {
        setShowMediaPermBar(true);
      }
    });
    const onOnline = () => setNetworkOnline(true);
    const onOffline = () => setNetworkOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  const handleRunAiAssist = async (mode: 'ask' | 'smart_reply') => {
    setAiLoading(true);
    setAiError('');
    try {
      const recentContext = messages
        .filter((m) => !m.isDeleted && m.text)
        .slice(-6)
        .map((m) => `${m.senderName}: ${m.text}`)
        .join('\n');

      const prompt =
        mode === 'smart_reply'
          ? aiPrompt.trim() || 'Suggest a friendly, concise reply to the latest message.'
          : aiPrompt.trim() || 'Explain how AI works in a few words';

      const res = await generateAiText({
        prompt,
        mode,
        context: mode === 'smart_reply' ? recentContext : undefined,
      });
      setAiResult(res.text);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'AI request failed');
    } finally {
      setAiLoading(false);
    }
  };

  useEffect(() => {
    if (initialChatId) setActiveChatId(initialChatId);
  }, [initialChatId]);

  useEffect(() => {
    if (initialDraftText) {
      setText(initialDraftText);
      onConsumeDraft?.();
    }
  }, [initialDraftText, onConsumeDraft]);

  const userMap = useMemo(() => {
    const m: Record<string, UserPublicProfile> = {};
    for (const u of allUsers) m[u.uid] = u;
    return m;
  }, [allUsers]);

  // Listen to user's chats
  useEffect(() => {
    const q = query(
      collection(db, 'chats'),
      where('memberIds', 'array-contains', currentUser.uid),
      limit(50)
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ChatRoom, 'id'>) }));
        list.sort((a, b) => {
          const at = a.lastMessageAt?.toMillis() || a.updatedAt?.toMillis() || 0;
          const bt = b.lastMessageAt?.toMillis() || b.updatedAt?.toMillis() || 0;
          return bt - at;
        });
        setChats(list);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'chats')
    );
    return () => unsub();
  }, [currentUser.uid]);

  const activeChat = useMemo(
    () => chats.find((c) => c.id === activeChatId) || null,
    [chats, activeChatId]
  );

  // Load my member settings across all user's chats for archive/pin/lock badges
  useEffect(() => {
    if (chats.length === 0) return;
    let cancelled = false;
    void Promise.all(
      chats.map(async (c) => {
        try {
          const snap = await getDoc(doc(db, 'chats', c.id, 'members', currentUser.uid));
          if (snap.exists()) return [c.id, snap.data() as ChatMember] as const;
        } catch {
          // Ignore individual member read error
        }
        return null;
      })
    ).then((entries) => {
      if (cancelled) return;
      setMyMemberByChat((prev) => {
        const next = { ...prev };
        for (const item of entries) {
          if (item) next[item[0]] = item[1];
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [chats, currentUser.uid]);

  // Listen to active chat members
  useEffect(() => {
    if (!activeChatId) {
      setMemberSettings({});
      return;
    }
    const q = query(
      collection(db, 'chats', activeChatId, 'members'),
      where('chatId', '==', activeChatId)
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const map: Record<string, ChatMember> = {};
        for (const d of snap.docs) {
          const data = d.data() as ChatMember;
          map[data.userId] = data;
        }
        setMemberSettings(map);
        if (map[currentUser.uid]) {
          setMyMemberByChat((prev) => ({ ...prev, [activeChatId]: map[currentUser.uid] }));
        }
      },
      (err) => handleFirestoreError(err, OperationType.LIST, `chats/${activeChatId}/members`)
    );
    return () => unsub();
  }, [activeChatId, currentUser.uid]);

  // Reset transient thread UI when switching chats
  useEffect(() => {
    setThreadSearchOpen(false);
    setThreadSearchQuery('');
    setEditingGroupName(false);
    setReplyTo(null);
    setEditingMessage(null);
    setComposerError('');
  }, [activeChatId]);

  // Listen to active chat messages
  useEffect(() => {
    if (!activeChatId) {
      setMessages([]);
      return;
    }
    const q = query(
      collection(db, 'chats', activeChatId, 'messages'),
      where('chatId', '==', activeChatId),
      limit(100)
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const now = Date.now();
        const list = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<ChatMessage, 'id'>) }))
          .filter((m) => m.expiresAtMs === 0 || m.expiresAtMs > now)
          .sort((a, b) => (a.createdAt?.toMillis() || 0) - (b.createdAt?.toMillis() || 0));
        setMessages(list);
        setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 60);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, `chats/${activeChatId}/messages`)
    );
    return () => unsub();
  }, [activeChatId]);

  // Voice recording timer (caps at 120s to protect free-tier storage)
  useEffect(() => {
    if (!isRecordingVoice) {
      setRecordingSec(0);
      return;
    }
    const id = setInterval(() => {
      setRecordingSec((s) => {
        if (s + 1 >= 120) {
          stopVoiceRecording(false);
          return 120;
        }
        return s + 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [isRecordingVoice]);

  const getDirectPeer = (chat: ChatRoom): UserPublicProfile | null => {
    if (chat.type !== 'direct') return null;
    const otherUid = chat.memberIds.find((id) => id !== currentUser.uid);
    return otherUid ? userMap[otherUid] || null : null;
  };

  const getChatDisplayName = (chat: ChatRoom): string => {
    if (chat.type === 'group') return chat.name || 'Group Chat';
    return getDirectPeer(chat)?.displayName || 'Conversation';
  };

  const filteredChats = useMemo(() => {
    const qLower = searchQuery.trim().toLowerCase();
    return chats
      .filter((chat) => {
        const myMem = myMemberByChat[chat.id];
        if (chatFilter === 'archived') {
          if (!myMem?.isArchived) return false;
        } else {
          if (myMem?.isArchived) return false;
          if (chatFilter === 'direct' && chat.type !== 'direct') return false;
          if (chatFilter === 'group' && chat.type !== 'group') return false;
        }
        if (!qLower) return true;
        const name = getChatDisplayName(chat).toLowerCase();
        return (
          name.includes(qLower) || (chat.lastMessageText || '').toLowerCase().includes(qLower)
        );
      })
      .sort((a, b) => {
        const aPinned = myMemberByChat[a.id]?.isPinned ? 1 : 0;
        const bPinned = myMemberByChat[b.id]?.isPinned ? 1 : 0;
        if (aPinned !== bPinned) return bPinned - aPinned;
        const at = a.lastMessageAt?.toMillis() || a.updatedAt?.toMillis() || 0;
        const bt = b.lastMessageAt?.toMillis() || b.updatedAt?.toMillis() || 0;
        return bt - at;
      });
  }, [chats, chatFilter, searchQuery, myMemberByChat, userMap]);

  const startDirectChat = async (peer: UserPublicProfile) => {
    const existing = chats.find(
      (c) => c.type === 'direct' && c.memberIds.includes(peer.uid) && c.memberIds.length === 2
    );
    if (existing) {
      setActiveChatId(existing.id);
      setShowNewDirectModal(false);
      return;
    }

    const sorted = [currentUser.uid, peer.uid].sort();
    const chatId = `dm_${sorted[0].slice(0, 14)}_${sorted[1].slice(0, 14)}`;
    const safetyCode = await generateSafetyCode(sorted.join(':'));

    try {
      const batch = writeBatch(db);
      const chatRef = doc(db, 'chats', chatId);
      batch.set(chatRef, {
        type: 'direct',
        name: peer.displayName.slice(0, VALIDATION_CONSTRAINTS.CHAT_NAME_MAX),
        avatarUrl: '',
        createdBy: currentUser.uid,
        memberIds: sorted,
        adminIds: sorted,
        lastMessageText: '',
        lastMessageSenderId: currentUser.uid,
        isEncrypted: true,
        disappearingSeconds: 0,
        safetyCode,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      for (const uid of sorted) {
        batch.set(doc(db, 'chats', chatId, 'members', uid), {
          userId: uid,
          chatId,
          role: 'admin',
          nickname: '',
          isMuted: false,
          isPinned: false,
          isArchived: false,
          isLocked: false,
          joinedAt: serverTimestamp(),
        });
      }

      await batch.commit();
      setActiveChatId(chatId);
      setShowNewDirectModal(false);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `chats/${chatId}`);
    }
  };

  const createGroupChat = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = groupName.trim().slice(0, VALIDATION_CONSTRAINTS.CHAT_NAME_MAX);
    if (!cleanName || selectedGroupUids.length === 0) return;

    const members = Array.from(new Set([currentUser.uid, ...selectedGroupUids])).slice(0, 50);
    const safetyCode = await generateSafetyCode(members.sort().join(':') + Date.now());
    const chatRef = doc(collection(db, 'chats'));

    try {
      const batch = writeBatch(db);
      batch.set(chatRef, {
        type: 'group',
        name: cleanName,
        avatarUrl: '',
        createdBy: currentUser.uid,
        memberIds: members,
        adminIds: [currentUser.uid],
        lastMessageText: `${currentUser.displayName} created group "${cleanName}"`,
        lastMessageSenderId: currentUser.uid,
        lastMessageAt: serverTimestamp(),
        isEncrypted: true,
        disappearingSeconds: 0,
        safetyCode,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      for (const uid of members) {
        batch.set(doc(db, 'chats', chatRef.id, 'members', uid), {
          userId: uid,
          chatId: chatRef.id,
          role: uid === currentUser.uid ? 'admin' : 'member',
          nickname: '',
          isMuted: false,
          isPinned: false,
          isArchived: false,
          isLocked: false,
          joinedAt: serverTimestamp(),
        });
      }

      await batch.commit();
      setActiveChatId(chatRef.id);
      setGroupName('');
      setSelectedGroupUids([]);
      setShowNewGroupModal(false);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'chats');
    }
  };

  const emitTyping = (typing: boolean) => {
    if (!activeChat) return;
    sendSocketEvent({
      type: 'typing',
      chatId: activeChat.id,
      targetUserIds: activeChat.memberIds,
      isTyping: typing,
    });
  };

  const sendMessage = async (
    msgType: ChatMessage['type'],
    msgText: string,
    mediaUrl = '',
    mediaDurationSec?: number
  ) => {
    if (!activeChat) return;
    const cleanText = msgText.trim().slice(0, VALIDATION_CONSTRAINTS.MESSAGE_TEXT_MAX);
    if (msgType === 'text' && !cleanText) return;

    if (editingMessage && msgType === 'text') {
      try {
        await updateDoc(doc(db, 'chats', activeChat.id, 'messages', editingMessage.id), {
          text: cleanText,
          isEdited: true,
          updatedAt: serverTimestamp(),
        });
        setEditingMessage(null);
        setText('');
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `chats/${activeChat.id}/messages/${editingMessage.id}`);
      }
      return;
    }

    const expiresAtMs =
      activeChat.disappearingSeconds > 0
        ? Date.now() + activeChat.disappearingSeconds * 1000
        : 0;

    try {
      const msgRef = doc(collection(db, 'chats', activeChat.id, 'messages'));
      const batch = writeBatch(db);
      const payload: Record<string, unknown> = {
        chatId: activeChat.id,
        senderId: currentUser.uid,
        senderName: currentUser.displayName.slice(0, VALIDATION_CONSTRAINTS.DISPLAY_NAME_MAX),
        type: msgType,
        text: cleanText,
        mediaUrl,
        replyToId: replyTo?.id || '',
        replyToPreview: replyTo ? (replyTo.text || `[${replyTo.type}]`).slice(0, 150) : '',
        reactions: [],
        isEdited: false,
        isDeleted: false,
        expiresAtMs,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      if (typeof mediaDurationSec === 'number') {
        payload.mediaDurationSec = mediaDurationSec;
      }
      batch.set(msgRef, payload);

      const preview =
        msgType === 'text'
          ? cleanText.slice(0, 120)
          : msgType === 'audio'
            ? 'Voice message'
            : msgType === 'image'
              ? 'Sent a photo'
              : msgType === 'file'
                ? 'Sent a file attachment'
                : 'Sent a video';

      batch.update(doc(db, 'chats', activeChat.id), {
        lastMessageText: preview,
        lastMessageSenderId: currentUser.uid,
        lastMessageAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      await batch.commit();
      setText('');
      setReplyTo(null);
      setComposerError('');
      emitTyping(false);
    } catch (err) {
      setComposerError(err instanceof Error ? err.message : 'Message could not be sent.');
      handleFirestoreError(err, OperationType.CREATE, `chats/${activeChat.id}/messages`);
    }
  };

  const handleMediaFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !activeChat) return;
    setComposerError('');
    setUploadingMedia(true);
    try {
      const isVideo = file.type.startsWith('video/');
      const isPdf = file.type === 'application/pdf';
      const isImage = file.type.startsWith('image/');

      if (!isVideo && !isPdf && !isImage) {
        throw new Error('Supported attachments: images, videos (MP4/WebM/MOV), and PDF files.');
      }

      if (isVideo && file.size > 25 * 1024 * 1024) {
        throw new Error('Video exceeds 25 MB free-tier attachment limit.');
      }
      if (isPdf && file.size > 5 * 1024 * 1024) {
        throw new Error('PDF file exceeds 5 MB free-tier attachment limit.');
      }

      const blob = isVideo || isPdf ? file : await compressImageFile(file);
      const mime = isVideo || isPdf ? file.type : 'image/jpeg';
      const url = await uploadMediaBlob(blob, mime, 'general');
      const msgType: ChatMessage['type'] = isVideo ? 'video' : isPdf ? 'file' : 'image';
      const label = isPdf ? file.name.slice(0, 120) : '';
      await sendMessage(msgType, label, url);
    } catch (err) {
      setComposerError(err instanceof Error ? err.message : 'Attachment upload failed.');
    } finally {
      setUploadingMedia(false);
      e.target.value = '';
    }
  };

  const startVoiceRecording = async () => {
    setComposerError('');
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setComposerError('Voice recording is not supported on this browser.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const candidateMimeTypes = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/ogg;codecs=opus',
      ];
      const supportedMime =
        candidateMimeTypes.find((m) => MediaRecorder.isTypeSupported(m)) || '';
      const recorder = supportedMime
        ? new MediaRecorder(stream, { mimeType: supportedMime })
        : new MediaRecorder(stream);

      audioChunksRef.current = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) audioChunksRef.current.push(ev.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const durationSec = Math.max(1, Math.round((Date.now() - voiceStartMsRef.current) / 1000));
        const rawMime = (recorder.mimeType || supportedMime || 'audio/webm').split(';')[0];
        const blob = new Blob(audioChunksRef.current, { type: rawMime });
        if (blob.size > 0) {
          setUploadingMedia(true);
          try {
            const url = await uploadMediaBlob(blob, rawMime, 'voice');
            await sendMessage('audio', '', url, durationSec);
          } catch (err) {
            setComposerError(err instanceof Error ? err.message : 'Voice upload failed.');
          } finally {
            setUploadingMedia(false);
          }
        }
      };
      mediaRecorderRef.current = recorder;
      voiceStartMsRef.current = Date.now();
      recorder.start();
      setIsRecordingVoice(true);
    } catch {
      setComposerError('Microphone access denied. Allow microphone permission to send voice notes.');
    }
  };

  const stopVoiceRecording = (cancel = false) => {
    const rec = mediaRecorderRef.current;
    if (!rec) return;
    if (cancel) {
      rec.onstop = null;
      rec.stream.getTracks().forEach((t) => t.stop());
    }
    if (rec.state !== 'inactive') {
      rec.stop();
    }
    setIsRecordingVoice(false);
  };

  const toggleReaction = async (msg: ChatMessage, emoji: string) => {
    if (!activeChat) return;
    const key = `${emoji}:${currentUser.uid}`;
    const next = msg.reactions.includes(key)
      ? msg.reactions.filter((r) => r !== key)
      : [...msg.reactions, key].slice(0, 100);
    try {
      await updateDoc(doc(db, 'chats', activeChat.id, 'messages', msg.id), {
        reactions: next,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `chats/${activeChat.id}/messages/${msg.id}`);
    }
  };

  const unsendMessage = async (msg: ChatMessage) => {
    if (!activeChat) return;
    try {
      await updateDoc(doc(db, 'chats', activeChat.id, 'messages', msg.id), {
        text: 'This message was unsent',
        isDeleted: true,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `chats/${activeChat.id}/messages/${msg.id}`);
    }
  };

  const updateDisappearingTimer = async (seconds: 0 | 10 | 60 | 86400) => {
    if (!activeChat) return;
    try {
      await updateDoc(doc(db, 'chats', activeChat.id), {
        disappearingSeconds: seconds,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `chats/${activeChat.id}`);
    }
  };

  const toggleMemberFlag = async (field: 'isMuted' | 'isPinned' | 'isArchived' | 'isLocked') => {
    if (!activeChat) return;
    const currentMem = memberSettings[currentUser.uid];
    if (!currentMem) return;
    if (field === 'isLocked' && !privateInfo?.chatLockPinHash) {
      setPinError('Set a Chat Lock PIN in Verify & Security first.');
      return;
    }
    try {
      await updateDoc(doc(db, 'chats', activeChat.id, 'members', currentUser.uid), {
        [field]: !currentMem[field],
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `chats/${activeChat.id}/members/${currentUser.uid}`);
    }
  };

  const addMemberToGroup = async () => {
    if (!activeChat || !addMemberUid) return;
    if (activeChat.memberIds.includes(addMemberUid)) return;
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'chats', activeChat.id), {
        memberIds: arrayUnion(addMemberUid),
        updatedAt: serverTimestamp(),
      });
      batch.set(doc(db, 'chats', activeChat.id, 'members', addMemberUid), {
        userId: addMemberUid,
        chatId: activeChat.id,
        role: 'member',
        nickname: '',
        isMuted: false,
        isPinned: false,
        isArchived: false,
        isLocked: false,
        joinedAt: serverTimestamp(),
      });
      await batch.commit();
      setAddMemberUid('');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `chats/${activeChat.id}`);
    }
  };

  const removeMemberFromGroup = async (uid: string) => {
    if (!activeChat || activeChat.type !== 'group') return;
    if (!activeChat.adminIds.includes(currentUser.uid)) return;
    if (uid === currentUser.uid || activeChat.memberIds.length <= 1) return;

    const remainingAdmins = activeChat.adminIds.filter((id) => id !== uid);
    try {
      const batch = writeBatch(db);
      const chatUpdates: Record<string, unknown> = {
        memberIds: arrayRemove(uid),
        updatedAt: serverTimestamp(),
      };
      if (remainingAdmins.length >= 1 && activeChat.adminIds.includes(uid)) {
        chatUpdates.adminIds = arrayRemove(uid);
      }
      batch.update(doc(db, 'chats', activeChat.id), chatUpdates);
      batch.delete(doc(db, 'chats', activeChat.id, 'members', uid));
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `chats/${activeChat.id}`);
    }
  };

  const renameGroupChat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeChat || activeChat.type !== 'group') return;
    if (!activeChat.adminIds.includes(currentUser.uid)) return;
    const cleanName = groupNameDraft.trim().slice(0, VALIDATION_CONSTRAINTS.CHAT_NAME_MAX);
    if (!cleanName) return;
    try {
      await updateDoc(doc(db, 'chats', activeChat.id), {
        name: cleanName,
        updatedAt: serverTimestamp(),
      });
      setEditingGroupName(false);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `chats/${activeChat.id}`);
    }
  };

  const copyMessageText = async (msg: ChatMessage) => {
    const content = msg.text || msg.mediaUrl || '';
    if (!content) return;
    try {
      await navigator.clipboard?.writeText(content);
      setCopiedMsgId(msg.id);
      setTimeout(() => setCopiedMsgId((prev) => (prev === msg.id ? null : prev)), 1500);
    } catch {
      // Clipboard write unavailable
    }
  };

  const unlockChatWithPin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeChat || !privateInfo?.chatLockPinHash) return;
    const hash = await sha256Hex(pinInput.trim());
    if (hash === privateInfo.chatLockPinHash) {
      setUnlockedChatIds((prev) => ({ ...prev, [activeChat.id]: true }));
      setPinInput('');
      setPinError('');
    } else {
      setPinError('Incorrect PIN code');
    }
  };

  const activePeer = activeChat ? getDirectPeer(activeChat) : null;
  const myMember = memberSettings[currentUser.uid];
  const isChatLockedForMe = Boolean(
    activeChat && myMember?.isLocked && !unlockedChatIds[activeChat.id]
  );

  // Throttled lastReadAt receipt updates when viewing an unlocked chat thread (Spark free-tier friendly)
  useEffect(() => {
    if (!activeChat || isChatLockedForMe || !myMember) return;
    const latestMs = activeChat.lastMessageAt?.toMillis() || 0;
    const readMs = myMember.lastReadAt?.toMillis() || 0;
    if (latestMs > 0 && latestMs <= readMs) return;

    const now = Date.now();
    const lastWrite = lastReadWriteRef.current[activeChat.id] || 0;
    if (now - lastWrite < 2000) return;
    lastReadWriteRef.current[activeChat.id] = now;

    void updateDoc(doc(db, 'chats', activeChat.id, 'members', currentUser.uid), {
      lastReadAt: serverTimestamp(),
    }).catch(() => {});
  }, [activeChat?.id, activeChat?.lastMessageAt, isChatLockedForMe, myMember, currentUser.uid]);

  const activeTypers = activeChat
    ? Object.keys(typingByChat[activeChat.id] || {}).filter((uid) => uid !== currentUser.uid)
    : [];

  const visibleMessages = useMemo(() => {
    const q = threadSearchQuery.trim().toLowerCase();
    if (!q) return messages;
    return messages.filter(
      (m) =>
        m.text.toLowerCase().includes(q) ||
        m.senderName.toLowerCase().includes(q)
    );
  }, [messages, threadSearchQuery]);

  return (
    <div className="h-[calc(100vh-4.5rem)] lg:h-screen flex bg-white dark:bg-slate-950 overflow-hidden">
      {/* Left Pane: Conversations List */}
      <div
        className={`${
          activeChat ? 'hidden md:flex' : 'flex'
        } w-full md:w-80 lg:w-88 flex-col border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/50`}
      >
        <div className="p-4 border-b border-slate-100 dark:border-slate-800 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white">
                Messages
              </h2>
              {!networkOnline ? (
                <span className="text-[11px] font-medium text-rose-600 dark:text-rose-400">
                  Offline
                </span>
              ) : !wsConnected ? (
                <span className="text-[11px] font-medium text-amber-600 dark:text-amber-400">
                  HTTPS Sync
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setShowNewDirectModal(true)}
                title="New Personal Chat"
                className="p-2 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 transition-colors"
              >
                <Plus className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setShowNewGroupModal(true)}
                title="Create Group Chat"
                className="p-2 rounded-xl bg-sky-50 dark:bg-sky-950/60 hover:bg-sky-100 dark:hover:bg-sky-900/60 text-sky-600 dark:text-sky-400 transition-colors"
              >
                <Users className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search chats or people..."
              className="w-full pl-9 pr-3 py-2 rounded-xl bg-slate-100 dark:bg-slate-800/80 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/40"
            />
          </div>

          <div className="grid grid-cols-4 gap-1 p-1 rounded-xl bg-slate-100 dark:bg-slate-800/70">
            {(['all', 'direct', 'group', 'archived'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setChatFilter(tab)}
                className={`py-1.5 text-xs font-medium rounded-lg capitalize transition-colors ${
                  chatFilter === tab
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>

          {showMediaPermBar && (
            <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-sky-50 dark:bg-sky-950/50 border border-sky-200/70 dark:border-sky-900/60">
              <button
                type="button"
                onClick={async () => {
                  const cam = await requestMediaPermission('camera');
                  const mic = await requestMediaPermission('microphone');
                  await requestNotificationPermission();
                  if (cam === 'granted' && mic === 'granted') {
                    setShowMediaPermBar(false);
                  }
                }}
                className="text-left text-[11px] font-semibold text-sky-700 dark:text-sky-300 hover:underline"
              >
                Enable Mic, Camera &amp; Call Alerts
              </button>
              <button
                type="button"
                onClick={() => setShowMediaPermBar(false)}
                aria-label="Dismiss permission banner"
                className="p-0.5 text-sky-500 hover:text-sky-700 dark:hover:text-sky-200"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-thin divide-y divide-slate-100 dark:divide-slate-800/60">
          {filteredChats.length === 0 ? (
            <div className="p-8 text-center space-y-3">
              <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
                No conversations yet
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Start a private chat or create a group room to message and call friends.
              </p>
              <button
                type="button"
                onClick={() => setShowNewDirectModal(true)}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-xs font-semibold transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                Start Conversation
              </button>
            </div>
          ) : (
            filteredChats.map((chat) => {
              const peer = getDirectPeer(chat);
              const myMem = myMemberByChat[chat.id];
              const isSelected = chat.id === activeChatId;
              const isOnline = peer ? onlineUserIds.includes(peer.uid) : false;
              const name = getChatDisplayName(chat);
              const lastMsgMs = chat.lastMessageAt?.toMillis() || 0;
              const lastReadMs = myMem?.lastReadAt?.toMillis() || 0;
              const isUnread = Boolean(
                lastMsgMs > 0 &&
                  chat.lastMessageSenderId !== currentUser.uid &&
                  lastMsgMs > lastReadMs &&
                  chat.id !== activeChatId
              );
              return (
                <button
                  key={chat.id}
                  type="button"
                  onClick={() => setActiveChatId(chat.id)}
                  className={`w-full flex items-center gap-3 px-4 py-3.5 text-left transition-colors ${
                    isSelected
                      ? 'bg-sky-50/80 dark:bg-sky-950/30'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                  }`}
                >
                  <Avatar
                    src={chat.type === 'group' ? chat.avatarUrl : peer?.avatarUrl}
                    name={name}
                    size="md"
                    isOnline={isOnline}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate inline-flex items-center gap-1">
                        {name}
                        {peer?.isVerified && <VerifiedBadge className="w-3.5 h-3.5" />}
                        {myMem?.isPinned && <Pin className="w-3 h-3 text-sky-500 shrink-0" />}
                        {myMem?.isMuted && <BellOff className="w-3 h-3 text-slate-400 shrink-0" />}
                        {myMem?.isLocked && <Lock className="w-3 h-3 text-amber-500 shrink-0" />}
                      </span>
                      <span className="inline-flex items-center gap-1.5 text-[11px] font-mono text-slate-400 shrink-0">
                        {isUnread && (
                          <span
                            aria-label="Unread messages"
                            className="w-2 h-2 rounded-full bg-sky-600 dark:bg-sky-400"
                          />
                        )}
                        {chat.lastMessageAt ? formatRelativeTime(chat.lastMessageAt.toMillis()) : ''}
                      </span>
                    </div>
                    <p
                      className={`text-xs truncate mt-0.5 ${
                        isUnread
                          ? 'font-semibold text-slate-900 dark:text-white'
                          : 'text-slate-500 dark:text-slate-400'
                      }`}
                    >
                      {chat.type === 'group' && `${chat.memberIds.length} members · `}
                      {chat.lastMessageText || 'Encrypted chat ready'}
                    </p>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Center Pane: Active Thread */}
      <div className={`${activeChat ? 'flex' : 'hidden md:flex'} flex-1 flex-col min-w-0`}>
        {!activeChat ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-4">
            <div className="w-16 h-16 rounded-2xl bg-sky-50 dark:bg-sky-950/50 text-sky-600 dark:text-sky-400 flex items-center justify-center">
              <Lock className="w-7 h-7" />
            </div>
            <div className="max-w-sm space-y-1.5">
              <h3 className="font-display text-lg font-bold text-slate-900 dark:text-white">
                Select a conversation
              </h3>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Choose a personal or group thread for encrypted messaging, voice notes, and HD audio/video calls.
              </p>
            </div>
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => setShowNewDirectModal(true)}
                className="px-4 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-xs font-semibold transition-colors"
              >
                New Direct Chat
              </button>
              <button
                type="button"
                onClick={() => setShowNewGroupModal(true)}
                className="px-4 py-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 text-xs font-semibold transition-colors"
              >
                Create Group
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Thread Header */}
            <header className="h-16 px-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3 bg-white dark:bg-slate-900/40 shrink-0">
              <div className="flex items-center gap-3 min-w-0">
                <button
                  type="button"
                  onClick={() => setActiveChatId(null)}
                  className="md:hidden p-2 -ml-1 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                  aria-label="Back to chats"
                >
                  <ArrowLeft className="w-5 h-5" />
                </button>
                <button
                  type="button"
                  onClick={() => activePeer && onViewProfile(activePeer.uid)}
                  className="flex items-center gap-3 min-w-0 text-left"
                >
                  <Avatar
                    src={activeChat.type === 'group' ? activeChat.avatarUrl : activePeer?.avatarUrl}
                    name={getChatDisplayName(activeChat)}
                    size="sm"
                    isOnline={activePeer ? onlineUserIds.includes(activePeer.uid) : false}
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <h3 className="text-sm font-bold text-slate-900 dark:text-white truncate">
                        {getChatDisplayName(activeChat)}
                      </h3>
                      {activePeer?.isVerified && <VerifiedBadge className="w-3.5 h-3.5" />}
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                      {!wsConnected
                        ? 'Reconnecting real-time server…'
                        : activeTypers.length > 0
                          ? 'Typing...'
                          : activeChat.type === 'group'
                            ? `${activeChat.memberIds.length} members`
                            : activePeer && onlineUserIds.includes(activePeer.uid)
                              ? 'Active now'
                              : 'Encrypted session'}
                    </p>
                  </div>
                </button>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    setThreadSearchOpen((v) => !v);
                    setThreadSearchQuery('');
                  }}
                  aria-label="Search in conversation"
                  className={`p-2.5 rounded-xl transition-colors ${
                    threadSearchOpen
                      ? 'bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400'
                      : 'text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                >
                  <Search className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => onStartCall(activeChat, activePeer, 'audio')}
                  aria-label="Start audio call"
                  className="p-2.5 rounded-xl text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                >
                  <Phone className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => onStartCall(activeChat, activePeer, activeChat.type === 'group' ? 'group' : 'video')}
                  aria-label="Start video call"
                  className="p-2.5 rounded-xl text-sky-600 dark:text-sky-400 hover:bg-sky-50 dark:hover:bg-sky-950/50 transition-colors"
                >
                  <Video className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setShowInspector(!showInspector)}
                  aria-label="Chat info and security"
                  className={`p-2.5 rounded-xl transition-colors ${
                    showInspector
                      ? 'bg-slate-900 text-white dark:bg-sky-600'
                      : 'text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                >
                  <Info className="w-4 h-4" />
                </button>
              </div>
            </header>

            {threadSearchOpen && !isChatLockedForMe && (
              <div className="px-4 py-2 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 flex items-center gap-2 shrink-0">
                <Search className="w-4 h-4 text-slate-400 shrink-0" />
                <input
                  type="text"
                  autoFocus
                  value={threadSearchQuery}
                  onChange={(e) => setThreadSearchQuery(e.target.value)}
                  placeholder="Search messages in this thread..."
                  className="flex-1 bg-transparent text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none"
                />
                {threadSearchQuery && (
                  <span className="text-[11px] font-mono text-slate-500">
                    {visibleMessages.length} found
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setThreadSearchOpen(false);
                    setThreadSearchQuery('');
                  }}
                  aria-label="Close thread search"
                  className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {/* Chat PIN Lock Screen OR Messages Stream */}
            {isChatLockedForMe ? (
              <div className="flex-1 flex items-center justify-center p-6 bg-slate-50 dark:bg-slate-950">
                <form
                  onSubmit={unlockChatWithPin}
                  className="max-w-xs w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 text-center space-y-4 shadow-sm"
                >
                  <div className="w-12 h-12 rounded-2xl bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400 flex items-center justify-center mx-auto">
                    <Lock className="w-6 h-6" />
                  </div>
                  <div>
                    <h4 className="font-display font-bold text-slate-900 dark:text-white">
                      Chat Locked
                    </h4>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                      Enter your security PIN to view messages in this conversation.
                    </p>
                  </div>
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={6}
                    value={pinInput}
                    onChange={(e) => setPinInput(e.target.value)}
                    placeholder="Enter PIN"
                    className="w-full text-center font-mono tracking-widest px-3 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500/40"
                  />
                  {pinError && <p className="text-xs text-rose-500">{pinError}</p>}
                  <button
                    type="submit"
                    className="w-full py-2.5 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold transition-colors"
                  >
                    Unlock Conversation
                  </button>
                </form>
              </div>
            ) : (
              <>
                <div className="flex-1 overflow-y-auto scrollbar-thin p-4 sm:p-6 space-y-3 bg-slate-50/70 dark:bg-slate-950">
                  <div className="text-center py-3">
                    <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                      <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
                      Safety Code: <span className="font-mono">{activeChat.safetyCode}</span>
                      {activeChat.disappearingSeconds > 0 && (
                        <>
                          <span aria-hidden="true">·</span>
                          <Clock className="w-3 h-3" />
                          <span>Disappearing {activeChat.disappearingSeconds}s</span>
                        </>
                      )}
                    </span>
                  </div>

                  {visibleMessages.length === 0 && threadSearchQuery.trim() && (
                    <p className="text-center text-xs text-slate-500 py-8">
                      No messages matched &ldquo;{threadSearchQuery.trim()}&rdquo;.
                    </p>
                  )}

                  {visibleMessages.map((msg) => {
                    const isMine = msg.senderId === currentUser.uid;
                    const mediaSrc = sanitizeMediaUrl(msg.mediaUrl);
                    const reactionGroups: Record<string, number> = {};
                    for (const entry of msg.reactions || []) {
                      const emoji = entry.split(':')[0];
                      if (emoji) reactionGroups[emoji] = (reactionGroups[emoji] || 0) + 1;
                    }

                    return (
                      <div
                        key={msg.id}
                        className={`group flex flex-col ${isMine ? 'items-end' : 'items-start'}`}
                      >
                        {!isMine && activeChat.type === 'group' && (
                          <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1 px-1">
                            {msg.senderName}
                          </span>
                        )}

                        <div className={`flex items-end gap-2 max-w-[85%] sm:max-w-[70%] ${isMine ? 'flex-row-reverse' : ''}`}>
                          <div
                            className={`rounded-2xl px-4 py-2.5 text-sm shadow-xs ${
                              msg.isDeleted
                                ? 'bg-slate-100 dark:bg-slate-900 text-slate-400 italic border border-slate-200 dark:border-slate-800'
                                : isMine
                                  ? 'bg-sky-600 text-white rounded-br-sm'
                                  : 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 border border-slate-200 dark:border-slate-800 rounded-bl-sm'
                            }`}
                          >
                            {msg.replyToPreview && !msg.isDeleted && (
                              <div
                                className={`text-xs mb-1.5 px-2.5 py-1 rounded-lg ${
                                  isMine
                                    ? 'bg-sky-700/60 text-sky-100'
                                    : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                                }`}
                              >
                                {msg.replyToPreview}
                              </div>
                            )}

                            {!msg.isDeleted && msg.type === 'image' && mediaSrc && (
                              <button
                                type="button"
                                onClick={() => setLightboxImageUrl(mediaSrc)}
                                className="block rounded-xl overflow-hidden mb-1 focus:outline-none focus:ring-2 focus:ring-sky-400"
                              >
                                <img
                                  src={mediaSrc}
                                  alt="Shared attachment"
                                  referrerPolicy="no-referrer"
                                  className="rounded-xl max-h-72 w-auto object-cover hover:opacity-95 transition-opacity"
                                />
                              </button>
                            )}

                            {!msg.isDeleted && msg.type === 'video' && mediaSrc && (
                              <video
                                src={mediaSrc}
                                controls
                                className="rounded-xl max-h-72 w-full mb-1"
                              />
                            )}

                            {!msg.isDeleted && msg.type === 'audio' && mediaSrc && (
                              <div className="flex items-center gap-2 py-1">
                                <audio src={mediaSrc} controls className="h-8 max-w-[220px]" />
                              </div>
                            )}

                            {!msg.isDeleted && msg.type === 'file' && mediaSrc && (
                              <a
                                href={mediaSrc}
                                target="_blank"
                                rel="noopener noreferrer"
                                className={`flex items-center gap-2.5 p-2.5 rounded-xl mb-1 transition-colors ${
                                  isMine
                                    ? 'bg-sky-700/50 hover:bg-sky-700/70 text-white'
                                    : 'bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-100'
                                }`}
                              >
                                <FileText className="w-4 h-4 shrink-0" />
                                <span className="text-xs font-medium truncate max-w-[160px]">
                                  {msg.text || 'Attachment (PDF)'}
                                </span>
                                <Download className="w-3.5 h-3.5 shrink-0 opacity-80" />
                              </a>
                            )}

                            {!msg.isDeleted && msg.type === 'call' && (
                              <div className="flex items-center gap-2">
                                <PhoneCall className="w-3.5 h-3.5 shrink-0 opacity-90" />
                                <span className="text-xs font-medium">
                                  {msg.text || 'Call session'}
                                </span>
                              </div>
                            )}

                            {msg.text && msg.type !== 'file' && msg.type !== 'call' && (
                              <p className="whitespace-pre-wrap break-words leading-relaxed">
                                {msg.text}
                              </p>
                            )}

                            <div
                              className={`flex items-center justify-end gap-1 mt-1 text-[10px] font-mono ${
                                isMine ? 'text-sky-100/80' : 'text-slate-400'
                              }`}
                            >
                              {msg.isEdited && !msg.isDeleted && <span>edited</span>}
                              <span>
                                {msg.createdAt
                                  ? new Date(msg.createdAt.toMillis()).toLocaleTimeString([], {
                                      hour: '2-digit',
                                      minute: '2-digit',
                                    })
                                  : '...'}
                              </span>
                              {isMine &&
                                (msg.createdAt ? (
                                  <CheckCheck className="w-3 h-3" />
                                ) : (
                                  <Check className="w-3 h-3" />
                                ))}
                            </div>
                          </div>

                          {/* Touch-friendly & Hover Message Actions */}
                          {!msg.isDeleted && (
                            <div className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100 transition-opacity flex items-center gap-0.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-0.5 shadow-sm">
                              <button
                                type="button"
                                onClick={() => setReplyTo(msg)}
                                title="Reply"
                                className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-white"
                              >
                                <Reply className="w-3.5 h-3.5" />
                              </button>
                              {(['❤️', '👍', '😂', '😮', '😢'] as const).map((emoji) => (
                                <button
                                  key={emoji}
                                  type="button"
                                  onClick={() => toggleReaction(msg, emoji)}
                                  title={`React ${emoji}`}
                                  className="px-1 py-1 rounded-lg text-xs hover:bg-slate-100 dark:hover:bg-slate-800"
                                >
                                  {emoji}
                                </button>
                              ))}
                              {msg.text && (
                                <button
                                  type="button"
                                  onClick={() => void copyMessageText(msg)}
                                  title="Copy text"
                                  className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-white"
                                >
                                  {copiedMsgId === msg.id ? (
                                    <Check className="w-3.5 h-3.5 text-emerald-500" />
                                  ) : (
                                    <Copy className="w-3.5 h-3.5" />
                                  )}
                                </button>
                              )}
                              {isMine && msg.type === 'text' && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingMessage(msg);
                                    setText(msg.text);
                                  }}
                                  title="Edit"
                                  className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-white"
                                >
                                  <Edit3 className="w-3.5 h-3.5" />
                                </button>
                              )}
                              {isMine && (
                                <button
                                  type="button"
                                  onClick={() => unsendMessage(msg)}
                                  title="Unsend"
                                  className="p-1.5 rounded-lg text-slate-500 hover:text-rose-600"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          )}
                        </div>

                        {Object.keys(reactionGroups).length > 0 && !msg.isDeleted && (
                          <div className="flex items-center gap-1 mt-1 px-1">
                            {Object.entries(reactionGroups).map(([emoji, count]) => (
                              <button
                                key={emoji}
                                type="button"
                                onClick={() => toggleReaction(msg, emoji)}
                                className="px-2 py-0.5 rounded-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs shadow-xs"
                              >
                                {emoji} {count > 1 ? count : ''}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <div ref={messagesEndRef} />
                </div>

                {/* Composer Area */}
                <div className="p-3 sm:p-4 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/40 space-y-2">
                  {composerError && (
                    <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/50 text-xs text-rose-700 dark:text-rose-300">
                      <span>{composerError}</span>
                      <button
                        type="button"
                        onClick={() => setComposerError('')}
                        aria-label="Dismiss error"
                        className="p-0.5 text-rose-500 hover:text-rose-700 dark:hover:text-rose-200"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                  {(replyTo || editingMessage) && (
                    <div className="flex items-center justify-between px-3 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs">
                      <span className="truncate text-slate-700 dark:text-slate-300">
                        {editingMessage
                          ? `Editing: ${editingMessage.text}`
                          : `Replying to ${replyTo?.senderName}: ${replyTo?.text || `[${replyTo?.type}]`}`}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setReplyTo(null);
                          setEditingMessage(null);
                          if (editingMessage) setText('');
                        }}
                        className="p-1 text-slate-500 hover:text-slate-900 dark:hover:text-white"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}

                  {showEmojiPicker && (
                    <div className="flex items-center gap-2 p-2 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                      {QUICK_EMOJIS.map((em) => (
                        <button
                          key={em}
                          type="button"
                          onClick={() => {
                            setText((t) => t + em);
                            setShowEmojiPicker(false);
                          }}
                          className="text-lg hover:scale-125 transition-transform p-1"
                        >
                          {em}
                        </button>
                      ))}
                    </div>
                  )}

                  {showAiAssist && (
                    <div className="p-3 rounded-2xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-2.5">
                      <div className="flex items-center justify-between">
                        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-sky-600 dark:text-sky-400">
                          <Sparkles className="w-3.5 h-3.5" />
                          Gemini AI Assist
                        </span>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            disabled={aiLoading}
                            onClick={() => void handleRunAiAssist('smart_reply')}
                            className="px-2.5 py-1 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-[11px] font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-50"
                          >
                            Suggest Reply
                          </button>
                          <button
                            type="button"
                            onClick={() => setShowAiAssist(false)}
                            aria-label="Close AI Assist"
                            className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={aiPrompt}
                          onChange={(e) => setAiPrompt(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              void handleRunAiAssist('ask');
                            }
                          }}
                          placeholder="Ask Gemini (e.g. Explain how AI works in a few words)..."
                          className="flex-1 min-w-0 px-3 py-2 rounded-xl bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/40"
                        />
                        <button
                          type="button"
                          disabled={aiLoading}
                          onClick={() => void handleRunAiAssist('ask')}
                          className="px-3 py-2 rounded-xl bg-sky-600 hover:bg-sky-700 disabled:opacity-50 text-white text-xs font-semibold shrink-0"
                        >
                          {aiLoading ? 'Thinking...' : 'Generate'}
                        </button>
                      </div>

                      {aiError && (
                        <p className="text-xs text-rose-600 dark:text-rose-400">{aiError}</p>
                      )}

                      {aiResult && (
                        <div className="p-2.5 rounded-xl bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-2">
                          <p className="text-xs text-slate-800 dark:text-slate-200 whitespace-pre-wrap">
                            {aiResult}
                          </p>
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setText(aiResult);
                                setShowAiAssist(false);
                              }}
                              className="px-2.5 py-1 rounded-lg bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400 text-[11px] font-semibold hover:bg-sky-100 dark:hover:bg-sky-900/60"
                            >
                              Use in Message
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {isRecordingVoice ? (
                    <div className="flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/50">
                      <div className="flex items-center gap-2 text-sm text-rose-600 dark:text-rose-400 font-medium">
                        <Mic className="w-4 h-4 animate-pulse" />
                        <span>Recording Voice Note</span>
                        <span className="font-mono">{formatDurationClock(recordingSec)}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => stopVoiceRecording(true)}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-white/60"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => stopVoiceRecording(false)}
                          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-rose-600 text-white text-xs font-semibold"
                        >
                          <Square className="w-3.5 h-3.5 fill-current" />
                          Send Voice
                        </button>
                      </div>
                    </div>
                  ) : (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void sendMessage('text', text);
                      }}
                      className="flex items-center gap-2"
                    >
                      <label
                        title="Send image, video, or PDF"
                        className="p-2.5 rounded-xl text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer transition-colors shrink-0"
                      >
                        <ImageIcon className="w-5 h-5" />
                        <input
                          type="file"
                          accept="image/*,video/*,application/pdf"
                          onChange={handleMediaFile}
                          disabled={uploadingMedia}
                          className="sr-only"
                        />
                      </label>

                      <button
                        type="button"
                        onClick={startVoiceRecording}
                        aria-label="Record voice message"
                        className="p-2.5 rounded-xl text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shrink-0"
                      >
                        <Mic className="w-5 h-5" />
                      </button>

                      <button
                        type="button"
                        onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                        aria-label="Insert emoji"
                        className="p-2.5 rounded-xl text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shrink-0"
                      >
                        <Smile className="w-5 h-5" />
                      </button>

                      <button
                        type="button"
                        onClick={() => setShowAiAssist((v) => !v)}
                        aria-label="Gemini AI Assist"
                        className={`p-2.5 rounded-xl transition-colors shrink-0 ${
                          showAiAssist
                            ? 'bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400'
                            : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                        }`}
                      >
                        <Sparkles className="w-5 h-5" />
                      </button>

                      <input
                        type="text"
                        maxLength={VALIDATION_CONSTRAINTS.MESSAGE_TEXT_MAX}
                        value={text}
                        onChange={(e) => {
                          setText(e.target.value);
                          emitTyping(true);
                          if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
                          typingTimeoutRef.current = setTimeout(() => emitTyping(false), 2500);
                        }}
                        placeholder={uploadingMedia ? 'Uploading attachment...' : 'Write an encrypted message...'}
                        className="flex-1 min-w-0 px-4 py-2.5 rounded-xl bg-slate-100 dark:bg-slate-800/80 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/40"
                      />

                      <button
                        type="submit"
                        disabled={!text.trim() || uploadingMedia}
                        aria-label="Send message"
                        className="p-2.5 rounded-xl bg-sky-600 hover:bg-sky-700 disabled:opacity-40 text-white transition-colors shrink-0"
                      >
                        <Send className="w-4 h-4" />
                      </button>
                    </form>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>

      {/* Right Pane: Chat Security & Group Inspector */}
      {activeChat && showInspector && (
        <aside className="fixed inset-y-0 right-0 z-40 w-80 lg:static lg:z-auto border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 lg:dark:bg-slate-900/60 overflow-y-auto scrollbar-thin p-5 space-y-6 shrink-0 shadow-2xl lg:shadow-none">
          <div className="flex items-center justify-between">
            <h4 className="font-display font-bold text-sm text-slate-900 dark:text-white">
              Chat Security & Info
            </h4>
            <button
              type="button"
              onClick={() => setShowInspector(false)}
              className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="text-center space-y-2 pb-4 border-b border-slate-100 dark:border-slate-800">
            <Avatar
              src={activeChat.type === 'group' ? activeChat.avatarUrl : activePeer?.avatarUrl}
              name={getChatDisplayName(activeChat)}
              size="lg"
              className="mx-auto"
            />
            {editingGroupName && activeChat.type === 'group' ? (
              <form onSubmit={renameGroupChat} className="flex items-center gap-1.5 px-2">
                <input
                  type="text"
                  maxLength={VALIDATION_CONSTRAINTS.CHAT_NAME_MAX}
                  value={groupNameDraft}
                  onChange={(e) => setGroupNameDraft(e.target.value)}
                  className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-xs text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-sky-500/40"
                />
                <button
                  type="submit"
                  className="px-2.5 py-1.5 rounded-lg bg-sky-600 text-white text-xs font-semibold"
                >
                  Save
                </button>
              </form>
            ) : (
              <div className="flex items-center justify-center gap-1.5">
                <h5 className="font-semibold text-slate-900 dark:text-white">
                  {getChatDisplayName(activeChat)}
                </h5>
                {activeChat.type === 'group' && activeChat.adminIds.includes(currentUser.uid) && (
                  <button
                    type="button"
                    onClick={() => {
                      setGroupNameDraft(activeChat.name || '');
                      setEditingGroupName(true);
                    }}
                    title="Rename group"
                    className="p-1 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )}
            <p className="text-xs font-mono text-slate-500 dark:text-slate-400">
              Safety Code: {activeChat.safetyCode}
            </p>
            <div className="grid grid-cols-2 gap-2 pt-2">
              <button
                type="button"
                onClick={() => onStartCall(activeChat, activePeer, 'audio')}
                className="inline-flex items-center justify-center gap-1.5 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-xs font-semibold text-slate-800 dark:text-slate-200 transition-colors"
              >
                <Phone className="w-3.5 h-3.5" />
                Audio Call
              </button>
              <button
                type="button"
                onClick={() =>
                  onStartCall(activeChat, activePeer, activeChat.type === 'group' ? 'group' : 'video')
                }
                className="inline-flex items-center justify-center gap-1.5 py-2 rounded-xl bg-sky-600 hover:bg-sky-700 text-xs font-semibold text-white transition-colors"
              >
                <Video className="w-3.5 h-3.5" />
                Video Call
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">
              Disappearing Messages
            </p>
            <div className="grid grid-cols-4 gap-1 p-1 rounded-xl bg-slate-100 dark:bg-slate-800">
              {([0, 10, 60, 86400] as const).map((sec) => (
                <button
                  key={sec}
                  type="button"
                  onClick={() => updateDisappearingTimer(sec)}
                  className={`py-1.5 text-xs font-medium rounded-lg transition-colors ${
                    activeChat.disappearingSeconds === sec
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                      : 'text-slate-500 dark:text-slate-400'
                  }`}
                >
                  {sec === 0 ? 'Off' : sec === 10 ? '10s' : sec === 60 ? '1m' : '24h'}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <button
              type="button"
              onClick={() => toggleMemberFlag('isLocked')}
              className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 text-sm text-slate-700 dark:text-slate-200 transition-colors"
            >
              <span className="inline-flex items-center gap-2.5">
                {myMember?.isLocked ? <Unlock className="w-4 h-4 text-sky-500" /> : <Lock className="w-4 h-4" />}
                {myMember?.isLocked ? 'Disable Chat Lock' : 'Lock Chat with PIN'}
              </span>
            </button>
            <button
              type="button"
              onClick={() => toggleMemberFlag('isPinned')}
              className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 text-sm text-slate-700 dark:text-slate-200 transition-colors"
            >
              <span className="inline-flex items-center gap-2.5">
                <Pin className="w-4 h-4" />
                {myMember?.isPinned ? 'Unpin Conversation' : 'Pin Conversation'}
              </span>
            </button>
            <button
              type="button"
              onClick={() => toggleMemberFlag('isMuted')}
              className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 text-sm text-slate-700 dark:text-slate-200 transition-colors"
            >
              <span className="inline-flex items-center gap-2.5">
                <BellOff className="w-4 h-4" />
                {myMember?.isMuted ? 'Unmute Notifications' : 'Mute Notifications'}
              </span>
            </button>
            <button
              type="button"
              onClick={() => toggleMemberFlag('isArchived')}
              className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 text-sm text-slate-700 dark:text-slate-200 transition-colors"
            >
              <span className="inline-flex items-center gap-2.5">
                <Archive className="w-4 h-4" />
                {myMember?.isArchived ? 'Unarchive Chat' : 'Archive Chat'}
              </span>
            </button>
          </div>

          {pinError && <p className="text-xs text-rose-500">{pinError}</p>}

          {activeChat.type === 'group' && (
            <div className="space-y-3 pt-3 border-t border-slate-100 dark:border-slate-800">
              <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                Group Members ({activeChat.memberIds.length})
              </p>
              <div className="space-y-2">
                {activeChat.memberIds.map((uid) => {
                  const u = userMap[uid];
                  if (!u) return null;
                  const canRemove =
                    activeChat.adminIds.includes(currentUser.uid) &&
                    uid !== currentUser.uid &&
                    activeChat.memberIds.length > 1;
                  return (
                    <div key={uid} className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => onViewProfile(uid)}
                        className="flex items-center gap-2 min-w-0 text-left"
                      >
                        <Avatar src={u.avatarUrl} name={u.displayName} size="xs" />
                        <span className="text-xs font-medium text-slate-800 dark:text-slate-200 truncate">
                          {u.displayName}
                        </span>
                      </button>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {activeChat.adminIds.includes(uid) && (
                          <span className="text-[11px] text-sky-600 dark:text-sky-400">Admin</span>
                        )}
                        {canRemove && (
                          <button
                            type="button"
                            onClick={() => void removeMemberFromGroup(uid)}
                            title={`Remove ${u.displayName}`}
                            className="p-1 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                          >
                            <UserMinus className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {activeChat.adminIds.includes(currentUser.uid) && (
                <div className="flex items-center gap-1.5 pt-2">
                  <select
                    value={addMemberUid}
                    onChange={(e) => setAddMemberUid(e.target.value)}
                    className="flex-1 min-w-0 text-xs px-2.5 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100"
                  >
                    <option value="">Add member...</option>
                    {allUsers
                      .filter((u) => !activeChat.memberIds.includes(u.uid))
                      .map((u) => (
                        <option key={u.uid} value={u.uid}>
                          {u.displayName}
                        </option>
                      ))}
                  </select>
                  <button
                    type="button"
                    onClick={addMemberToGroup}
                    disabled={!addMemberUid}
                    className="p-2 rounded-xl bg-sky-600 text-white disabled:opacity-40"
                  >
                    <UserPlus className="w-4 h-4" />
                  </button>
                </div>
              )}
            </div>
          )}
        </aside>
      )}

      {/* Modal: New Direct Chat */}
      {showNewDirectModal && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display font-bold text-slate-900 dark:text-white">
                Start Personal Chat
              </h3>
              <button
                type="button"
                onClick={() => setShowNewDirectModal(false)}
                className="p-1 text-slate-400 hover:text-slate-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="max-h-72 overflow-y-auto space-y-1.5">
              {allUsers
                .filter((u) => u.uid !== currentUser.uid)
                .map((u) => (
                  <button
                    key={u.uid}
                    type="button"
                    onClick={() => startDirectChat(u)}
                    className="w-full flex items-center gap-3 p-2.5 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 text-left transition-colors"
                  >
                    <Avatar
                      src={u.avatarUrl}
                      name={u.displayName}
                      size="sm"
                      isOnline={onlineUserIds.includes(u.uid)}
                    />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-900 dark:text-white truncate inline-flex items-center gap-1">
                        {u.displayName}
                        {u.isVerified && <VerifiedBadge className="w-3.5 h-3.5" />}
                      </p>
                      <p className="text-xs text-slate-500">@{u.username}</p>
                    </div>
                  </button>
                ))}
              {allUsers.filter((u) => u.uid !== currentUser.uid).length === 0 && (
                <p className="text-sm text-slate-500 text-center py-6">
                  Invite another user to sign in so you can chat and call together.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal: Create Group Chat */}
      {showNewGroupModal && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <form
            onSubmit={createGroupChat}
            className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-display font-bold text-slate-900 dark:text-white">
                Create Group Chat
              </h3>
              <button
                type="button"
                onClick={() => setShowNewGroupModal(false)}
                className="p-1 text-slate-400 hover:text-slate-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <input
              type="text"
              required
              maxLength={VALIDATION_CONSTRAINTS.CHAT_NAME_MAX}
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder="Group name (e.g. Weekend Trip)"
              className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500/40"
            />
            <div className="max-h-56 overflow-y-auto space-y-1.5">
              {allUsers
                .filter((u) => u.uid !== currentUser.uid)
                .map((u) => {
                  const checked = selectedGroupUids.includes(u.uid);
                  return (
                    <label
                      key={u.uid}
                      className="flex items-center justify-between p-2 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                    >
                      <div className="flex items-center gap-2.5">
                        <Avatar src={u.avatarUrl} name={u.displayName} size="xs" />
                        <span className="text-sm text-slate-800 dark:text-slate-200">
                          {u.displayName}
                        </span>
                      </div>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setSelectedGroupUids((prev) =>
                            checked ? prev.filter((id) => id !== u.uid) : [...prev, u.uid]
                          )
                        }
                        className="rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                      />
                    </label>
                  );
                })}
            </div>
            <button
              type="submit"
              disabled={!groupName.trim() || selectedGroupUids.length === 0}
              className="w-full py-2.5 rounded-xl bg-sky-600 hover:bg-sky-700 disabled:opacity-40 text-white text-sm font-semibold transition-colors"
            >
              Create Group ({selectedGroupUids.length + 1} members)
            </button>
          </form>
        </div>
      )}

      {/* Lightbox: Fullscreen Image Preview */}
      {lightboxImageUrl && (
        <div
          className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setLightboxImageUrl(null)}
        >
          <button
            type="button"
            onClick={() => setLightboxImageUrl(null)}
            aria-label="Close image preview"
            className="absolute top-4 right-4 p-2.5 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
          <img
            src={lightboxImageUrl}
            alt="Full preview"
            referrerPolicy="no-referrer"
            onClick={(e) => e.stopPropagation()}
            className="max-h-[90vh] max-w-[95vw] rounded-2xl object-contain shadow-2xl"
          />
        </div>
      )}
    </div>
  );
}

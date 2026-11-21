/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import {
  addDoc,
  collection,
  doc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  Home,
  MessageCircle,
  Film,
  Users,
  ShieldCheck,
  User as UserIcon,
  Sun,
  Moon,
} from 'lucide-react';
import { auth, db, handleFirestoreError, OperationType } from './lib/firebase';
import { generateSafetyCode } from './lib/security';
import { useRealtimeSocket, type IncomingCallSignal, type WebRtcSignalEvent } from './hooks/useRealtimeSocket';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AuthGate } from './components/AuthGate';
import { Avatar, VerifiedBadge } from './components/Avatar';
import { FeedAndStoriesView } from './components/FeedAndStoriesView';
import { MessengerView } from './components/MessengerView';
import { ReelsView } from './components/ReelsView';
import { FriendsView } from './components/FriendsView';
import { VerifyAndSecurityView } from './components/VerifyAndSecurityView';
import { ProfileView } from './components/ProfileView';
import { CallOverlay, type ActiveCallSession } from './components/CallOverlay';
import type {
  CallType,
  ChatRoom,
  Friendship,
  NavTab,
  UserPrivateInfo,
  UserPublicProfile,
} from './types/app';

function AlapApp() {
  const [authReady, setAuthReady] = useState(false);
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [currentUser, setCurrentUser] = useState<UserPublicProfile | null>(null);
  const [privateInfo, setPrivateInfo] = useState<UserPrivateInfo | null>(null);

  const [allUsers, setAllUsers] = useState<UserPublicProfile[]>([]);
  const [friendships, setFriendships] = useState<Friendship[]>([]);

  const [activeTab, setActiveTab] = useState<NavTab>('feed');
  const [viewingUid, setViewingUid] = useState<string | null>(null);
  const [openChatId, setOpenChatId] = useState<string | null>(null);
  const [chatDraftText, setChatDraftText] = useState<string | null>(null);

  // Dark / Light Theme
  const [isDark, setIsDark] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('alap_theme') === 'dark';
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
    localStorage.setItem('alap_theme', isDark ? 'dark' : 'light');
  }, [isDark]);

  // Call State
  const [activeCall, setActiveCall] = useState<ActiveCallSession | null>(null);
  const [latestSignal, setLatestSignal] = useState<WebRtcSignalEvent | null>(null);

  const handleIncomingCall = useCallback((sig: IncomingCallSignal) => {
    setActiveCall((prev) => {
      if (prev) return prev; // Busy
      return {
        callId: sig.callId,
        chatId: sig.chatId,
        direction: 'incoming',
        callType: sig.callType,
        peerId: sig.callerId,
        peerName: sig.callerName,
        peerAvatar: sig.callerAvatar,
        status: 'ringing',
      };
    });
  }, []);

  const handleWebRtcSignal = useCallback((ev: WebRtcSignalEvent) => {
    setLatestSignal(ev);
  }, []);

  const { onlineUserIds, typingByChat, sendSocketEvent } = useRealtimeSocket(
    currentUser?.uid,
    handleIncomingCall,
    handleWebRtcSignal
  );

  // 1. Auth Listener
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      setFirebaseUser(user);
      setAuthReady(true);
      if (!user) {
        setCurrentUser(null);
        setPrivateInfo(null);
        setProfileLoaded(true);
      } else {
        setProfileLoaded(false);
      }
    });
    return () => unsub();
  }, []);

  // 2. Current User Profile & Private Info Listeners
  useEffect(() => {
    if (!authReady || !firebaseUser) return;

    const unsubPublic = onSnapshot(
      doc(db, 'users', firebaseUser.uid),
      (snap) => {
        if (snap.exists()) {
          setCurrentUser(snap.data() as UserPublicProfile);
        } else {
          setCurrentUser(null);
        }
        setProfileLoaded(true);
      },
      (err) => {
        setProfileLoaded(true);
        handleFirestoreError(err, OperationType.GET, `users/${firebaseUser.uid}`);
      }
    );

    const unsubPrivate = onSnapshot(
      doc(db, 'users', firebaseUser.uid, 'private', 'info'),
      (snap) => {
        if (snap.exists()) {
          setPrivateInfo(snap.data() as UserPrivateInfo);
        }
      },
      () => {}
    );

    return () => {
      unsubPublic();
      unsubPrivate();
    };
  }, [authReady, firebaseUser]);

  // 3. Users Directory & Friendships Listeners
  useEffect(() => {
    if (!currentUser) return;

    const unsubUsers = onSnapshot(
      query(
        collection(db, 'users'),
        where('verificationStatus', 'in', ['none', 'pending', 'verified', 'rejected'])
      ),
      (snap) => {
        setAllUsers(snap.docs.map((d) => d.data() as UserPublicProfile));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'users')
    );

    const qFriends = query(
      collection(db, 'friendships'),
      where('participantIds', 'array-contains', currentUser.uid)
    );
    const unsubFriends = onSnapshot(
      qFriends,
      (snap) => {
        setFriendships(
          snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Friendship, 'id'>) }))
        );
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'friendships')
    );

    return () => {
      unsubUsers();
      unsubFriends();
    };
  }, [currentUser?.uid]);

  const openOrCreateDirectChat = async (peer: UserPublicProfile, initialDraft?: string) => {
    if (!currentUser) return;
    const sorted = [currentUser.uid, peer.uid].sort();
    const chatId = `dm_${sorted[0].slice(0, 14)}_${sorted[1].slice(0, 14)}`;
    const chatRef = doc(db, 'chats', chatId);

    try {
      const myChatsSnap = await getDocs(
        query(collection(db, 'chats'), where('memberIds', 'array-contains', currentUser.uid))
      );
      const existingChat = myChatsSnap.docs.find((d) => {
        const data = d.data() as ChatRoom;
        return data.type === 'direct' && data.memberIds.includes(peer.uid) && data.memberIds.length === 2;
      });

      if (existingChat) {
        if (initialDraft) setChatDraftText(initialDraft);
        setOpenChatId(existingChat.id);
        setActiveTab('messages');
        return;
      }

      const safetyCode = await generateSafetyCode(sorted.join(':'));
      const batch = writeBatch(db);
      batch.set(chatRef, {
        type: 'direct',
        name: peer.displayName.slice(0, 80),
        avatarUrl: '',
        createdBy: currentUser.uid,
        memberIds: sorted,
        adminIds: sorted,
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
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `chats/${chatId}`);
    }

    if (initialDraft) setChatDraftText(initialDraft);
    setOpenChatId(chatId);
    setActiveTab('messages');
  };

  const handleStartCall = async (
    chat: ChatRoom,
    peer: UserPublicProfile | null,
    callType: CallType
  ) => {
    if (!currentUser) return;
    const targetIds = chat.memberIds.filter((id) => id !== currentUser.uid);
    const primaryPeerId = peer?.uid || targetIds[0] || currentUser.uid;
    const primaryPeerName = peer?.displayName || chat.name || 'Group Call';
    const primaryPeerAvatar = peer?.avatarUrl || chat.avatarUrl || '';

    try {
      const callDoc = await addDoc(collection(db, 'calls'), {
        callerId: currentUser.uid,
        callerName: currentUser.displayName,
        callerAvatar: currentUser.avatarUrl || '',
        calleeId: primaryPeerId,
        calleeName: primaryPeerName,
        chatId: chat.id,
        callType,
        status: 'ringing',
        durationSeconds: 0,
        participantIds: chat.memberIds.slice(0, 20),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      setActiveCall({
        callId: callDoc.id,
        chatId: chat.id,
        direction: 'outgoing',
        callType,
        peerId: primaryPeerId,
        peerName: primaryPeerName,
        peerAvatar: primaryPeerAvatar,
        status: 'ringing',
      });

      sendSocketEvent({
        type: 'call:invite',
        callId: callDoc.id,
        chatId: chat.id,
        callType,
        targetUserIds: targetIds,
        callerName: currentUser.displayName,
        callerAvatar: currentUser.avatarUrl || '',
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'calls');
    }
  };

  const handleViewProfile = (uid: string) => {
    setViewingUid(uid);
    setActiveTab('profile');
  };

  if (!authReady || (firebaseUser && !profileLoaded)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950">
        <div className="text-center space-y-3">
          <div className="w-10 h-10 rounded-2xl bg-sky-600 animate-pulse mx-auto" />
          <p className="font-display font-bold text-slate-900 dark:text-white">Alap</p>
        </div>
      </div>
    );
  }

  if (!firebaseUser || !currentUser) {
    return (
      <AuthGate
        firebaseUser={firebaseUser}
        needsOnboarding={Boolean(firebaseUser && !currentUser)}
        onAccountCreated={() => setActiveTab('feed')}
      />
    );
  }

  const profileTarget =
    (viewingUid ? allUsers.find((u) => u.uid === viewingUid) : null) || currentUser;

  const navItems: { id: NavTab; label: string; icon: typeof Home }[] = [
    { id: 'feed', label: 'Feed', icon: Home },
    { id: 'messages', label: 'Messages', icon: MessageCircle },
    { id: 'reels', label: 'Reels', icon: Film },
    { id: 'friends', label: 'People', icon: Users },
    { id: 'verify', label: 'Verify ID', icon: ShieldCheck },
    { id: 'profile', label: 'Account', icon: UserIcon },
  ];

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col lg:flex-row">
      {/* Desktop Navigation Sidebar */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:fixed lg:inset-y-0 border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-4 justify-between z-30">
        <div className="space-y-6">
          <div className="flex items-center justify-between px-2 pt-1">
            <button
              type="button"
              onClick={() => {
                setViewingUid(null);
                setActiveTab('feed');
              }}
              className="font-display text-2xl font-extrabold tracking-tight text-slate-900 dark:text-white"
            >
              Alap
            </button>
            <button
              type="button"
              onClick={() => setIsDark(!isDark)}
              aria-label="Toggle color theme"
              className="p-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
            >
              {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>

          <nav className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    if (item.id === 'profile') setViewingUid(null);
                    setActiveTab(item.id);
                  }}
                  className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-semibold transition-colors whitespace-nowrap ${
                    isActive
                      ? 'bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400'
                      : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/60 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* Bottom Current Account Switch/View */}
        <button
          type="button"
          onClick={() => {
            setViewingUid(null);
            setActiveTab('profile');
          }}
          className="flex items-center gap-3 p-2.5 rounded-2xl border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60 text-left transition-colors"
        >
          <Avatar
            src={currentUser.avatarUrl}
            name={currentUser.displayName}
            size="sm"
            isOnline={true}
          />
          <div className="min-w-0">
            <p className="text-xs font-bold text-slate-900 dark:text-white truncate inline-flex items-center gap-1">
              {currentUser.displayName}
              {currentUser.isVerified && <VerifiedBadge className="w-3.5 h-3.5" />}
            </p>
            <p className="text-[11px] text-slate-500 truncate">@{currentUser.username}</p>
          </div>
        </button>
      </aside>

      {/* Mobile Compact Top Header */}
      <header className="lg:hidden sticky top-0 z-30 h-13 px-4 bg-white/90 dark:bg-slate-900/90 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
        <span className="font-display text-lg font-extrabold text-slate-900 dark:text-white">
          Alap
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setActiveTab('verify')}
            aria-label="ID Verification and Security"
            className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl text-slate-600 dark:text-slate-300"
          >
            <ShieldCheck className="w-5 h-5" />
          </button>
          <button
            type="button"
            onClick={() => setIsDark(!isDark)}
            aria-label="Toggle color theme"
            className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl text-slate-600 dark:text-slate-300"
          >
            {isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 lg:pl-64 pb-16 lg:pb-0 min-w-0">
        {activeTab === 'feed' && (
          <FeedAndStoriesView
            currentUser={currentUser}
            allUsers={allUsers}
            friendships={friendships}
            onlineUserIds={onlineUserIds}
            onViewProfile={handleViewProfile}
            onMessageUser={openOrCreateDirectChat}
            onGoVerify={() => setActiveTab('verify')}
          />
        )}

        {activeTab === 'messages' && (
          <MessengerView
            currentUser={currentUser}
            privateInfo={privateInfo}
            allUsers={allUsers}
            onlineUserIds={onlineUserIds}
            typingByChat={typingByChat}
            sendSocketEvent={sendSocketEvent}
            initialChatId={openChatId}
            initialDraftText={chatDraftText}
            onConsumeDraft={() => setChatDraftText(null)}
            onStartCall={handleStartCall}
            onViewProfile={handleViewProfile}
          />
        )}

        {activeTab === 'reels' && (
          <ReelsView currentUser={currentUser} onViewProfile={handleViewProfile} />
        )}

        {activeTab === 'friends' && (
          <FriendsView
            currentUser={currentUser}
            allUsers={allUsers}
            friendships={friendships}
            onlineUserIds={onlineUserIds}
            onViewProfile={handleViewProfile}
            onMessageUser={openOrCreateDirectChat}
          />
        )}

        {activeTab === 'verify' && (
          <VerifyAndSecurityView currentUser={currentUser} privateInfo={privateInfo} />
        )}

        {activeTab === 'profile' && (
          <ProfileView
            profileUser={profileTarget}
            currentUid={currentUser.uid}
            allUsers={allUsers}
            friendships={friendships}
            isOwnProfile={profileTarget.uid === currentUser.uid}
            onMessageUser={openOrCreateDirectChat}
            onGoVerify={() => setActiveTab('verify')}
            onBackToSelf={() => setViewingUid(null)}
          />
        )}
      </main>

      {/* Mobile Bottom Tab Bar */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-30 h-16 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border-t border-slate-200 dark:border-slate-800 grid grid-cols-5 items-center">
        {(
          [
            { id: 'feed', label: 'Feed', icon: Home },
            { id: 'messages', label: 'Chats', icon: MessageCircle },
            { id: 'reels', label: 'Reels', icon: Film },
            { id: 'friends', label: 'People', icon: Users },
            { id: 'profile', label: 'Account', icon: UserIcon },
          ] as const
        ).map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                if (item.id === 'profile') setViewingUid(null);
                setActiveTab(item.id);
              }}
              className={`min-h-[44px] flex flex-col items-center justify-center gap-0.5 ${
                isActive ? 'text-sky-600 dark:text-sky-400' : 'text-slate-500 dark:text-slate-400'
              }`}
            >
              <Icon className="w-5 h-5" />
              <span className="text-[10px] font-medium">{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Real-Time WebRTC Audio & Video Call Overlay */}
      <CallOverlay
        session={activeCall}
        currentUid={currentUser.uid}
        sendSocketEvent={sendSocketEvent}
        incomingSignal={latestSignal}
        onUpdateStatus={(status) =>
          setActiveCall((prev) => (prev ? { ...prev, status } : null))
        }
        onClose={() => setActiveCall(null)}
      />
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AlapApp />
    </ErrorBoundary>
  );
}

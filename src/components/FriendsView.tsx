import { useMemo, useState } from 'react';
import {
  deleteDoc,
  doc,
  increment,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import {
  Search,
  UserPlus,
  UserCheck,
  UserX,
  MessageCircle,
  Ban,
  Check,
  X,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { Avatar, VerifiedBadge } from './Avatar';
import type { Friendship, UserPublicProfile } from '../types/app';

interface FriendsViewProps {
  currentUser: UserPublicProfile;
  allUsers: UserPublicProfile[];
  friendships: Friendship[];
  onlineUserIds: string[];
  onViewProfile: (uid: string) => void;
  onMessageUser: (peer: UserPublicProfile) => void;
}

export function FriendsView({
  currentUser,
  allUsers,
  friendships,
  onlineUserIds,
  onViewProfile,
  onMessageUser,
}: FriendsViewProps) {
  const [tab, setTab] = useState<'discover' | 'friends' | 'requests' | 'blocked'>('discover');
  const [queryText, setQueryText] = useState('');

  const friendshipMap = useMemo(() => {
    const map: Record<string, Friendship> = {};
    for (const f of friendships) {
      const other = f.participantIds.find((id) => id !== currentUser.uid);
      if (other) map[other] = f;
    }
    return map;
  }, [friendships, currentUser.uid]);

  const sendRequest = async (target: UserPublicProfile) => {
    const sorted = [currentUser.uid, target.uid].sort();
    const fid = `${sorted[0]}_${sorted[1]}`;
    try {
      await setDoc(doc(db, 'friendships', fid), {
        requesterId: currentUser.uid,
        recipientId: target.uid,
        participantIds: sorted,
        status: 'pending',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `friendships/${fid}`);
    }
  };

  const acceptRequest = async (f: Friendship) => {
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'friendships', f.id), {
        status: 'accepted',
        updatedAt: serverTimestamp(),
      });
      batch.update(doc(db, 'users', f.requesterId), {
        friendsCount: increment(1),
        updatedAt: serverTimestamp(),
      });
      batch.update(doc(db, 'users', f.recipientId), {
        friendsCount: increment(1),
        updatedAt: serverTimestamp(),
      });
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `friendships/${f.id}`);
    }
  };

  const removeFriendship = async (f: Friendship) => {
    try {
      const batch = writeBatch(db);
      batch.delete(doc(db, 'friendships', f.id));
      if (f.status === 'accepted') {
        const reqUser = allUsers.find((u) => u.uid === f.requesterId);
        const recUser = allUsers.find((u) => u.uid === f.recipientId);
        if (!reqUser || reqUser.friendsCount > 0) {
          batch.update(doc(db, 'users', f.requesterId), {
            friendsCount: increment(-1),
            updatedAt: serverTimestamp(),
          });
        }
        if (!recUser || recUser.friendsCount > 0) {
          batch.update(doc(db, 'users', f.recipientId), {
            friendsCount: increment(-1),
            updatedAt: serverTimestamp(),
          });
        }
      }
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `friendships/${f.id}`);
    }
  };

  const blockUser = async (target: UserPublicProfile) => {
    const existing = friendshipMap[target.uid];
    const sorted = [currentUser.uid, target.uid].sort();
    const fid = existing?.id || `${sorted[0]}_${sorted[1]}`;
    try {
      if (existing) {
        await updateDoc(doc(db, 'friendships', fid), {
          status: 'blocked',
          blockedBy: currentUser.uid,
          updatedAt: serverTimestamp(),
        });
      } else {
        await setDoc(doc(db, 'friendships', fid), {
          requesterId: currentUser.uid,
          recipientId: target.uid,
          participantIds: sorted,
          status: 'blocked',
          blockedBy: currentUser.uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `friendships/${fid}`);
    }
  };

  const filteredUsers = useMemo(() => {
    const q = queryText.trim().toLowerCase();
    return allUsers
      .filter((u) => u.uid !== currentUser.uid)
      .filter((u) => {
        if (q && !u.displayName.toLowerCase().includes(q) && !u.username.toLowerCase().includes(q)) {
          return false;
        }
        const f = friendshipMap[u.uid];
        if (tab === 'friends') return f?.status === 'accepted';
        if (tab === 'requests') return f?.status === 'pending';
        if (tab === 'blocked') return f?.status === 'blocked' && f.blockedBy === currentUser.uid;
        return f?.status !== 'blocked';
      });
  }, [allUsers, currentUser.uid, queryText, tab, friendshipMap]);

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
            People & Friends
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Find accounts, manage friend requests, and start secure conversations.
          </p>
        </div>

        <div className="relative w-full sm:w-72">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={queryText}
            onChange={(e) => setQueryText(e.target.value)}
            placeholder="Search by name or @username..."
            className="w-full pl-9 pr-3.5 py-2.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500/40"
          />
        </div>
      </div>

      <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-100 dark:bg-slate-900 w-fit border border-slate-200 dark:border-slate-800">
        {(
          [
            { id: 'discover', label: 'All People' },
            { id: 'friends', label: 'Friends' },
            { id: 'requests', label: 'Requests' },
            { id: 'blocked', label: 'Blocked' },
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={`px-4 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
              tab === item.id
                ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {filteredUsers.length === 0 ? (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-10 text-center space-y-2">
          <p className="font-semibold text-slate-800 dark:text-slate-200">No people in this view</p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Try switching tabs or searching with another name.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filteredUsers.map((u) => {
            const f = friendshipMap[u.uid];
            const isOnline = onlineUserIds.includes(u.uid);

            return (
              <div
                key={u.uid}
                className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 flex items-center justify-between gap-4"
              >
                <button
                  type="button"
                  onClick={() => onViewProfile(u.uid)}
                  className="flex items-center gap-3.5 min-w-0 text-left"
                >
                  <Avatar src={u.avatarUrl} name={u.displayName} size="md" isOnline={isOnline} />
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-slate-900 dark:text-white truncate inline-flex items-center gap-1">
                      {u.displayName}
                      {u.isVerified && <VerifiedBadge className="w-4 h-4" />}
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                      @{u.username}
                      {u.city ? ` · ${u.city}` : ''}
                    </p>
                  </div>
                </button>

                <div className="flex items-center gap-1.5 shrink-0">
                  {!f && (
                    <button
                      type="button"
                      onClick={() => sendRequest(u)}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-xs font-semibold transition-colors"
                    >
                      <UserPlus className="w-3.5 h-3.5" />
                      Add
                    </button>
                  )}

                  {f?.status === 'pending' && f.recipientId === currentUser.uid && (
                    <>
                      <button
                        type="button"
                        onClick={() => acceptRequest(f)}
                        className="p-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white"
                        title="Accept"
                      >
                        <Check className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteDoc(doc(db, 'friendships', f.id))}
                        className="p-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300"
                        title="Decline"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </>
                  )}

                  {f?.status === 'pending' && f.requesterId === currentUser.uid && (
                    <button
                      type="button"
                      onClick={() => removeFriendship(f)}
                      className="px-3 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-medium text-slate-600 dark:text-slate-300"
                    >
                      Pending
                    </button>
                  )}

                  {f?.status === 'accepted' && (
                    <button
                      type="button"
                      onClick={() => removeFriendship(f)}
                      title="Friends (click to unfriend)"
                      className="inline-flex items-center gap-1 px-3 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-rose-50 dark:hover:bg-rose-950/50 text-slate-700 dark:text-slate-200 hover:text-rose-600 text-xs font-medium transition-colors"
                    >
                      <UserCheck className="w-3.5 h-3.5" />
                      Friends
                    </button>
                  )}

                  {f?.status === 'blocked' ? (
                    <button
                      type="button"
                      onClick={() => removeFriendship(f)}
                      className="inline-flex items-center gap-1 px-3 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-medium"
                    >
                      <UserX className="w-3.5 h-3.5" />
                      Unblock
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => onMessageUser(u)}
                        title="Message"
                        className="p-2 rounded-xl bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400 hover:bg-sky-100"
                      >
                        <MessageCircle className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => blockUser(u)}
                        title="Block user"
                        className="p-2 rounded-xl text-slate-400 hover:text-rose-600 hover:bg-slate-100 dark:hover:bg-slate-800"
                      >
                        <Ban className="w-4 h-4" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

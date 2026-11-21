import React, { useEffect, useState } from 'react';
import { signOut } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  increment,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  Camera,
  Check,
  Edit3,
  LogOut,
  MapPin,
  Briefcase,
  MessageCircle,
  ShieldCheck,
  UserCheck,
  UserPlus,
  X,
} from 'lucide-react';
import { auth, db, handleFirestoreError, OperationType } from '../lib/firebase';
import { compressImageFile, uploadMediaBlob } from '../lib/mediaUpload';
import { formatRelativeTime, sanitizeMediaUrl } from '../lib/security';
import { Avatar, VerifiedBadge } from './Avatar';
import {
  VALIDATION_CONSTRAINTS,
  type Friendship,
  type ShortReel,
  type SocialPost,
  type UserPublicProfile,
} from '../types/app';

interface ProfileViewProps {
  profileUser: UserPublicProfile;
  currentUid: string;
  allUsers: UserPublicProfile[];
  friendships: Friendship[];
  isOwnProfile: boolean;
  onMessageUser: (peer: UserPublicProfile) => void;
  onGoVerify: () => void;
  onBackToSelf?: () => void;
}

export function ProfileView({
  profileUser,
  currentUid,
  allUsers,
  friendships,
  isOwnProfile,
  onMessageUser,
  onGoVerify,
  onBackToSelf,
}: ProfileViewProps) {
  const [tab, setTab] = useState<'posts' | 'reels' | 'about'>('posts');
  const [userPosts, setUserPosts] = useState<SocialPost[]>([]);
  const [userReels, setUserReels] = useState<ShortReel[]>([]);

  const relation = friendships.find((f) => f.participantIds.includes(profileUser.uid)) || null;
  const isAcceptedFriend = relation?.status === 'accepted';

  // Edit Profile Modal
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(profileUser.displayName);
  const [bio, setBio] = useState(profileUser.bio || '');
  const [city, setCity] = useState(profileUser.city || '');
  const [work, setWork] = useState(profileUser.work || '');
  const [saving, setSaving] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);

  useEffect(() => {
    setDisplayName(profileUser.displayName);
    setBio(profileUser.bio || '');
    setCity(profileUser.city || '');
    setWork(profileUser.work || '');
  }, [profileUser]);

  useEffect(() => {
    const qPosts = isOwnProfile
      ? query(collection(db, 'posts'), where('authorId', '==', profileUser.uid), limit(40))
      : isAcceptedFriend
        ? query(
            collection(db, 'posts'),
            where('authorId', '==', profileUser.uid),
            where('privacy', 'in', ['public', 'friends']),
            limit(40)
          )
        : query(
            collection(db, 'posts'),
            where('authorId', '==', profileUser.uid),
            where('privacy', '==', 'public'),
            limit(40)
          );
    const unsubPosts = onSnapshot(
      qPosts,
      (snap) => {
        const list = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<SocialPost, 'id'>) }))
          .sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0));
        setUserPosts(list);
      },
      () => {}
    );

    const qReels = query(
      collection(db, 'reels'),
      where('authorId', '==', profileUser.uid),
      where('durationSeconds', '>=', 15),
      where('durationSeconds', '<=', 60),
      limit(30)
    );
    const unsubReels = onSnapshot(
      qReels,
      (snap) => {
        setUserReels(
          snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ShortReel, 'id'>) }))
        );
      },
      () => {}
    );

    return () => {
      unsubPosts();
      unsubReels();
    };
  }, [profileUser.uid, isOwnProfile, isAcceptedFriend]);

  const handlePhotoUpload = async (
    e: React.ChangeEvent<HTMLInputElement>,
    field: 'avatarUrl' | 'coverUrl'
  ) => {
    const file = e.target.files?.[0];
    if (!file || !isOwnProfile) return;
    setUploadingPhoto(true);
    try {
      const compressed = await compressImageFile(file, field === 'coverUrl' ? 1440 : 600);
      const url = await uploadMediaBlob(compressed, 'image/jpeg', 'general');
      await updateDoc(doc(db, 'users', profileUser.uid), {
        [field]: url,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `users/${profileUser.uid}`);
    } finally {
      setUploadingPhoto(false);
      e.target.value = '';
    }
  };

  const handleAddFriend = async () => {
    const sorted = [currentUid, profileUser.uid].sort();
    const fid = `${sorted[0]}_${sorted[1]}`;
    try {
      await setDoc(doc(db, 'friendships', fid), {
        requesterId: currentUid,
        recipientId: profileUser.uid,
        participantIds: sorted,
        status: 'pending',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `friendships/${fid}`);
    }
  };

  const handleAcceptFriend = async () => {
    if (!relation) return;
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'friendships', relation.id), {
        status: 'accepted',
        updatedAt: serverTimestamp(),
      });
      batch.update(doc(db, 'users', relation.requesterId), {
        friendsCount: increment(1),
        updatedAt: serverTimestamp(),
      });
      batch.update(doc(db, 'users', relation.recipientId), {
        friendsCount: increment(1),
        updatedAt: serverTimestamp(),
      });
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `friendships/${relation.id}`);
    }
  };

  const handleRemoveFriend = async () => {
    if (!relation) return;
    try {
      const batch = writeBatch(db);
      batch.delete(doc(db, 'friendships', relation.id));
      if (relation.status === 'accepted') {
        const reqUser = allUsers.find((u) => u.uid === relation.requesterId);
        const recUser = allUsers.find((u) => u.uid === relation.recipientId);
        if (!reqUser || reqUser.friendsCount > 0) {
          batch.update(doc(db, 'users', relation.requesterId), {
            friendsCount: increment(-1),
            updatedAt: serverTimestamp(),
          });
        }
        if (!recUser || recUser.friendsCount > 0) {
          batch.update(doc(db, 'users', relation.recipientId), {
            friendsCount: increment(-1),
            updatedAt: serverTimestamp(),
          });
        }
      }
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `friendships/${relation.id}`);
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isOwnProfile) return;
    const cleanName = displayName.trim().slice(0, VALIDATION_CONSTRAINTS.DISPLAY_NAME_MAX);
    if (!cleanName) return;
    setSaving(true);
    try {
      await updateDoc(doc(db, 'users', profileUser.uid), {
        displayName: cleanName,
        bio: bio.trim().slice(0, VALIDATION_CONSTRAINTS.BIO_MAX),
        city: city.trim().slice(0, VALIDATION_CONSTRAINTS.CITY_MAX),
        work: work.trim().slice(0, VALIDATION_CONSTRAINTS.WORK_MAX),
        updatedAt: serverTimestamp(),
      });
      setEditing(false);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `users/${profileUser.uid}`);
    } finally {
      setSaving(false);
    }
  };

  const coverSrc =
    sanitizeMediaUrl(profileUser.coverUrl) ||
    '/src/assets/images/default_cover_banner_1795238344707.jpg';

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      {!isOwnProfile && onBackToSelf && (
        <button
          type="button"
          onClick={onBackToSelf}
          className="text-xs font-semibold text-sky-600 dark:text-sky-400 hover:underline"
        >
          ← Back to My Account
        </button>
      )}

      {/* Profile Hero Card */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl overflow-hidden">
        <div className="relative h-48 sm:h-64 bg-slate-200 dark:bg-slate-800">
          <img
            src={coverSrc}
            alt="Profile cover"
            referrerPolicy="no-referrer"
            className="w-full h-full object-cover"
          />
          {isOwnProfile && (
            <label className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-black/60 hover:bg-black/75 text-white text-xs font-medium backdrop-blur-sm cursor-pointer">
              <Camera className="w-3.5 h-3.5" />
              {uploadingPhoto ? 'Uploading...' : 'Edit Cover'}
              <input
                type="file"
                accept="image/*"
                onChange={(e) => handlePhotoUpload(e, 'coverUrl')}
                className="sr-only"
              />
            </label>
          )}
        </div>

        <div className="px-6 pb-6">
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 -mt-12 relative z-10">
            <div className="flex items-end gap-4">
              <div className="relative">
                <Avatar
                  src={profileUser.avatarUrl}
                  name={profileUser.displayName}
                  size="xl"
                  className="ring-4 ring-white dark:ring-slate-900 rounded-full"
                />
                {isOwnProfile && (
                  <label className="absolute bottom-0 right-0 p-2 rounded-full bg-slate-900 dark:bg-sky-600 text-white cursor-pointer shadow-md">
                    <Camera className="w-3.5 h-3.5" />
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => handlePhotoUpload(e, 'avatarUrl')}
                      className="sr-only"
                    />
                  </label>
                )}
              </div>

              <div className="pb-1">
                <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white inline-flex items-center gap-1.5">
                  {profileUser.displayName}
                  {profileUser.isVerified && <VerifiedBadge className="w-5 h-5" />}
                </h1>
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  @{profileUser.username}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {isOwnProfile ? (
                <>
                  <button
                    type="button"
                    onClick={() => setEditing(true)}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-xs font-semibold text-slate-900 dark:text-white"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                    Edit Account
                  </button>
                  {!profileUser.isVerified && (
                    <button
                      type="button"
                      onClick={onGoVerify}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-xs font-semibold"
                    >
                      <ShieldCheck className="w-3.5 h-3.5" />
                      Verify ID
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => signOut(auth)}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-semibold text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    Sign Out
                  </button>
                </>
              ) : (
                <>
                  {!relation && (
                    <button
                      type="button"
                      onClick={handleAddFriend}
                      className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-xs font-semibold text-slate-900 dark:text-white"
                    >
                      <UserPlus className="w-4 h-4" />
                      Add Friend
                    </button>
                  )}
                  {relation?.status === 'pending' && relation.recipientId === currentUid && (
                    <>
                      <button
                        type="button"
                        onClick={handleAcceptFriend}
                        className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold"
                      >
                        <Check className="w-4 h-4" />
                        Accept Request
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteDoc(doc(db, 'friendships', relation.id))}
                        className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-semibold text-slate-700 dark:text-slate-200"
                      >
                        <X className="w-4 h-4" />
                        Decline
                      </button>
                    </>
                  )}
                  {relation?.status === 'pending' && relation.requesterId === currentUid && (
                    <button
                      type="button"
                      onClick={handleRemoveFriend}
                      className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-semibold text-slate-600 dark:text-slate-300"
                    >
                      Request Sent
                    </button>
                  )}
                  {relation?.status === 'accepted' && (
                    <button
                      type="button"
                      onClick={handleRemoveFriend}
                      title="Click to unfriend"
                      className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-rose-50 dark:hover:bg-rose-950/40 hover:text-rose-600 text-xs font-semibold text-slate-800 dark:text-slate-200"
                    >
                      <UserCheck className="w-4 h-4" />
                      Friends
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onMessageUser(profileUser)}
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-xs font-semibold"
                  >
                    <MessageCircle className="w-4 h-4" />
                    Message {profileUser.displayName.split(' ')[0]}
                  </button>
                </>
              )}
            </div>
          </div>

          {profileUser.bio && (
            <p className="text-sm text-slate-700 dark:text-slate-300 mt-4 max-w-2xl">
              {profileUser.bio}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-4 mt-4 text-xs text-slate-500 dark:text-slate-400">
            <span className="font-mono">
              <strong className="text-slate-900 dark:text-white">{profileUser.friendsCount}</strong> friends
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono">
              <strong className="text-slate-900 dark:text-white">{userPosts.length}</strong> posts
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono">
              <strong className="text-slate-900 dark:text-white">{userReels.length}</strong> reels
            </span>
            {profileUser.city && (
              <>
                <span aria-hidden="true">·</span>
                <span className="inline-flex items-center gap-1">
                  <MapPin className="w-3.5 h-3.5" />
                  {profileUser.city}
                </span>
              </>
            )}
            {profileUser.work && (
              <>
                <span aria-hidden="true">·</span>
                <span className="inline-flex items-center gap-1">
                  <Briefcase className="w-3.5 h-3.5" />
                  {profileUser.work}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Profile Content Tabs */}
      <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-100 dark:bg-slate-900 w-fit border border-slate-200 dark:border-slate-800">
        {(['posts', 'reels', 'about'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-5 py-2 rounded-lg text-xs font-semibold capitalize transition-colors ${
              tab === t
                ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                : 'text-slate-500 dark:text-slate-400'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'posts' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {userPosts.length === 0 ? (
            <div className="md:col-span-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-8 text-center text-sm text-slate-500">
              No posts shared yet.
            </div>
          ) : (
            userPosts.map((p) => (
              <div
                key={p.id}
                className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden flex flex-col justify-between"
              >
                <div className="p-4 space-y-2">
                  <p className="text-xs font-mono text-slate-400">
                    {p.createdAt ? formatRelativeTime(p.createdAt.toMillis()) : 'Just now'} · {p.privacy}
                  </p>
                  {p.content && (
                    <p className="text-sm text-slate-800 dark:text-slate-200 whitespace-pre-wrap">
                      {p.content}
                    </p>
                  )}
                </div>
                {sanitizeMediaUrl(p.mediaUrl) && (
                  <img
                    src={sanitizeMediaUrl(p.mediaUrl)}
                    alt="User post"
                    referrerPolicy="no-referrer"
                    className="w-full h-56 object-cover"
                  />
                )}
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'reels' && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
          {userReels.length === 0 ? (
            <div className="col-span-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-8 text-center text-sm text-slate-500">
              No 15–60s Reels uploaded yet.
            </div>
          ) : (
            userReels.map((r) => (
              <div
                key={r.id}
                className="aspect-[9/16] rounded-2xl overflow-hidden bg-black border border-slate-800 relative"
              >
                <video
                  src={sanitizeMediaUrl(r.videoUrl)}
                  controls
                  className="w-full h-full object-cover"
                />
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'about' && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-3 text-sm">
          <h3 className="font-display font-bold text-slate-900 dark:text-white">
            Account Details
          </h3>
          <p className="text-slate-600 dark:text-slate-400">
            Username: <span className="font-mono text-slate-900 dark:text-white">@{profileUser.username}</span>
          </p>
          <p className="text-slate-600 dark:text-slate-400">
            Verification Status:{' '}
            <span className="font-semibold text-slate-900 dark:text-white capitalize">
              {profileUser.isVerified ? 'Verified Account' : profileUser.verificationStatus}
            </span>
          </p>
          {profileUser.city && <p className="text-slate-600 dark:text-slate-400">Lives in {profileUser.city}</p>}
          {profileUser.work && <p className="text-slate-600 dark:text-slate-400">Works at {profileUser.work}</p>}
        </div>
      )}

      {/* Modal: Edit Own Account */}
      {editing && isOwnProfile && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <form
            onSubmit={handleSaveProfile}
            className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-display font-bold text-slate-900 dark:text-white">
                Edit Account Details
              </h3>
              <button type="button" onClick={() => setEditing(false)}>
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Display Name</label>
              <input
                type="text"
                required
                maxLength={VALIDATION_CONSTRAINTS.DISPLAY_NAME_MAX}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Bio</label>
              <textarea
                rows={3}
                maxLength={VALIDATION_CONSTRAINTS.BIO_MAX}
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm resize-none"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">City</label>
                <input
                  type="text"
                  maxLength={VALIDATION_CONSTRAINTS.CITY_MAX}
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Work</label>
                <input
                  type="text"
                  maxLength={VALIDATION_CONSTRAINTS.WORK_MAX}
                  value={work}
                  onChange={(e) => setWork(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm"
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={saving}
              className="w-full py-2.5 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold"
            >
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

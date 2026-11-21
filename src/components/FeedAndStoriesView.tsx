import React, { useEffect, useMemo, useState } from 'react';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  increment,
} from 'firebase/firestore';
import {
  Image as ImageIcon,
  Globe,
  Users,
  Lock,
  Heart,
  MessageSquare,
  Share2,
  Trash2,
  Plus,
  Send,
  X,
  ChevronLeft,
  ChevronRight,
  Eye,
  MapPin,
  Smile,
  ShieldCheck,
  UserPlus,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { compressImageFile, uploadMediaBlob } from '../lib/mediaUpload';
import { formatRelativeTime, sanitizeMediaUrl } from '../lib/security';
import { Avatar, VerifiedBadge } from './Avatar';
import {
  VALIDATION_CONSTRAINTS,
  type Friendship,
  type PostComment,
  type PrivacyLevel,
  type ReactionType,
  type SocialPost,
  type StoryItem,
  type UserPublicProfile,
} from '../types/app';

interface FeedAndStoriesViewProps {
  currentUser: UserPublicProfile;
  allUsers: UserPublicProfile[];
  friendships: Friendship[];
  onlineUserIds: string[];
  onViewProfile: (uid: string) => void;
  onMessageUser: (peer: UserPublicProfile, initialDraft?: string) => void;
  onGoVerify: () => void;
}

const STORY_BG_STYLES = [
  'bg-gradient-to-br from-sky-600 to-indigo-700',
  'bg-gradient-to-br from-emerald-600 to-teal-700',
  'bg-gradient-to-br from-slate-800 to-slate-950',
  'bg-gradient-to-br from-amber-600 to-rose-600',
];

const REACTION_META: { type: ReactionType; emoji: string; label: string }[] = [
  { type: 'like', emoji: '👍', label: 'Like' },
  { type: 'love', emoji: '❤️', label: 'Love' },
  { type: 'haha', emoji: '😂', label: 'Haha' },
  { type: 'wow', emoji: '😮', label: 'Wow' },
  { type: 'sad', emoji: '😢', label: 'Sad' },
];

export function FeedAndStoriesView({
  currentUser,
  allUsers,
  friendships,
  onlineUserIds,
  onViewProfile,
  onMessageUser,
  onGoVerify,
}: FeedAndStoriesViewProps) {
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [stories, setStories] = useState<StoryItem[]>([]);
  const [loadingFeed, setLoadingFeed] = useState(true);

  // Composer state
  const [postText, setPostText] = useState('');
  const [postImageUrl, setPostImageUrl] = useState('');
  const [postPrivacy, setPostPrivacy] = useState<PrivacyLevel>('public');
  const [postLocation, setPostLocation] = useState('');
  const [postFeeling, setPostFeeling] = useState('');
  const [showMetaInputs, setShowMetaInputs] = useState(false);
  const [uploadingPostImg, setUploadingPostImg] = useState(false);
  const [publishingPost, setPublishingPost] = useState(false);

  // Post Reactions & Comments
  const [myReactions, setMyReactions] = useState<Record<string, ReactionType>>({});
  const [openCommentsPostId, setOpenCommentsPostId] = useState<string | null>(null);
  const [commentsByPost, setCommentsByPost] = useState<Record<string, PostComment[]>>({});
  const [commentText, setCommentText] = useState('');

  // Story Creator & Viewer
  const [showCreateStory, setShowCreateStory] = useState(false);
  const [storyMode, setStoryMode] = useState<'image' | 'text'>('image');
  const [storyCaption, setStoryCaption] = useState('');
  const [storyBg, setStoryBg] = useState(STORY_BG_STYLES[0]);
  const [storyImageUrl, setStoryImageUrl] = useState('/src/assets/images/story_creative_studio_1795238345098.jpg');
  const [uploadingStory, setUploadingStory] = useState(false);
  const [activeStoryIndex, setActiveStoryIndex] = useState<number | null>(null);
  const [storyReplyText, setStoryReplyText] = useState('');

  const acceptedFriendIds = useMemo(() => {
    const set = new Set<string>();
    for (const f of friendships) {
      if (f.status === 'accepted') {
        const other = f.participantIds.find((id) => id !== currentUser.uid);
        if (other) set.add(other);
      }
    }
    return set;
  }, [friendships, currentUser.uid]);

  // Listen to Stories (24h active)
  useEffect(() => {
    const q = query(
      collection(db, 'stories'),
      where('expiresAtMs', '>', Date.now()),
      orderBy('expiresAtMs', 'desc')
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<StoryItem, 'id'>) }))
          .filter((s) => s.expiresAtMs > Date.now());
        setStories(list);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'stories')
    );
    return () => unsub();
  }, []);

  // Listen to Public/Feed Posts
  useEffect(() => {
    const qPublic = query(
      collection(db, 'posts'),
      where('privacy', 'in', ['public', 'friends'])
    );
    const unsub = onSnapshot(
      qPublic,
      (snap) => {
        const list = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<SocialPost, 'id'>) }))
          .filter(
            (p) =>
              p.privacy === 'public' ||
              p.authorId === currentUser.uid ||
              acceptedFriendIds.has(p.authorId)
          )
          .sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0));
        setPosts(list);
        setLoadingFeed(false);
      },
      (err) => {
        setLoadingFeed(false);
        handleFirestoreError(err, OperationType.LIST, 'posts');
      }
    );
    return () => unsub();
  }, [currentUser.uid, acceptedFriendIds]);

  // Hydrate existing user reactions on visible posts
  useEffect(() => {
    if (posts.length === 0) return;
    let cancelled = false;
    void Promise.all(
      posts.slice(0, 25).map(async (post) => {
        try {
          const snap = await getDoc(doc(db, 'posts', post.id, 'reactions', currentUser.uid));
          if (snap.exists()) {
            return [post.id, snap.data().type as ReactionType] as const;
          }
        } catch {
          // Ignore individual reaction read errors
        }
        return null;
      })
    ).then((entries) => {
      if (cancelled) return;
      setMyReactions((prev) => {
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
  }, [posts, currentUser.uid]);

  // Listen to Comments for opened post
  useEffect(() => {
    if (!openCommentsPostId) return;
    const q = query(
      collection(db, 'posts', openCommentsPostId, 'comments'),
      where('postId', '==', openCommentsPostId)
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list = snap.docs
          .map((d) => ({
            id: d.id,
            ...(d.data() as Omit<PostComment, 'id'>),
          }))
          .sort((a, b) => (a.createdAt?.toMillis() || 0) - (b.createdAt?.toMillis() || 0));
        setCommentsByPost((prev) => ({ ...prev, [openCommentsPostId]: list }));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, `posts/${openCommentsPostId}/comments`)
    );
    return () => unsub();
  }, [openCommentsPostId]);

  // Mark story view when opening viewer
  useEffect(() => {
    if (activeStoryIndex === null || !stories[activeStoryIndex]) return;
    const story = stories[activeStoryIndex];
    if (story.authorId === currentUser.uid) return;

    const recordView = async () => {
      try {
        await setDoc(doc(db, 'stories', story.id, 'views', currentUser.uid), {
          storyId: story.id,
          viewerId: currentUser.uid,
          viewerName: currentUser.displayName.slice(0, VALIDATION_CONSTRAINTS.DISPLAY_NAME_MAX),
          viewedAt: serverTimestamp(),
        });
        await updateDoc(doc(db, 'stories', story.id), {
          viewersCount: increment(1),
        });
      } catch {
        // Already viewed or concurrent view
      }
    };
    void recordView();
  }, [activeStoryIndex, stories, currentUser.uid, currentUser.displayName]);

  const handleUploadPostPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingPostImg(true);
    try {
      const compressed = await compressImageFile(file);
      const url = await uploadMediaBlob(compressed, 'image/jpeg', 'general');
      setPostImageUrl(url);
    } finally {
      setUploadingPostImg(false);
      e.target.value = '';
    }
  };

  const handleCreatePost = async (e: React.FormEvent) => {
    e.preventDefault();
    const content = postText.trim().slice(0, VALIDATION_CONSTRAINTS.POST_CONTENT_MAX);
    if (!content && !postImageUrl) return;
    setPublishingPost(true);
    try {
      await addDoc(collection(db, 'posts'), {
        authorId: currentUser.uid,
        authorName: currentUser.displayName.slice(0, VALIDATION_CONSTRAINTS.DISPLAY_NAME_MAX),
        authorUsername: currentUser.username,
        authorAvatar: currentUser.avatarUrl || '',
        authorVerified: currentUser.isVerified,
        content,
        mediaUrl: postImageUrl,
        mediaType: postImageUrl ? 'image' : 'none',
        privacy: postPrivacy,
        feeling: postFeeling.trim().slice(0, 60),
        location: postLocation.trim().slice(0, 80),
        likesCount: 0,
        commentsCount: 0,
        sharesCount: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setPostText('');
      setPostImageUrl('');
      setPostFeeling('');
      setPostLocation('');
      setShowMetaInputs(false);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'posts');
    } finally {
      setPublishingPost(false);
    }
  };

  const toggleReaction = async (post: SocialPost, type: ReactionType) => {
    const existing = myReactions[post.id];
    const reactRef = doc(db, 'posts', post.id, 'reactions', currentUser.uid);
    const postRef = doc(db, 'posts', post.id);

    try {
      const batch = writeBatch(db);
      if (existing === type) {
        batch.delete(reactRef);
        batch.update(postRef, { likesCount: increment(-1), updatedAt: serverTimestamp() });
        setMyReactions((prev) => {
          const next = { ...prev };
          delete next[post.id];
          return next;
        });
      } else if (existing) {
        batch.update(reactRef, { type });
        setMyReactions((prev) => ({ ...prev, [post.id]: type }));
      } else {
        batch.set(reactRef, {
          postId: post.id,
          userId: currentUser.uid,
          type,
          createdAt: serverTimestamp(),
        });
        batch.update(postRef, { likesCount: increment(1), updatedAt: serverTimestamp() });
        setMyReactions((prev) => ({ ...prev, [post.id]: type }));
      }
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `posts/${post.id}/reactions`);
    }
  };

  const handleAddComment = async (post: SocialPost) => {
    const clean = commentText.trim().slice(0, VALIDATION_CONSTRAINTS.COMMENT_TEXT_MAX);
    if (!clean) return;
    try {
      const batch = writeBatch(db);
      const commentRef = doc(collection(db, 'posts', post.id, 'comments'));
      batch.set(commentRef, {
        postId: post.id,
        authorId: currentUser.uid,
        authorName: currentUser.displayName.slice(0, VALIDATION_CONSTRAINTS.DISPLAY_NAME_MAX),
        authorAvatar: currentUser.avatarUrl || '',
        authorVerified: currentUser.isVerified,
        text: clean,
        parentCommentId: '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      batch.update(doc(db, 'posts', post.id), {
        commentsCount: increment(1),
        updatedAt: serverTimestamp(),
      });
      await batch.commit();
      setCommentText('');
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `posts/${post.id}/comments`);
    }
  };

  const handleDeletePost = async (postId: string) => {
    try {
      await deleteDoc(doc(db, 'posts', postId));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `posts/${postId}`);
    }
  };

  const handleUploadStoryPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingStory(true);
    try {
      const compressed = await compressImageFile(file);
      const url = await uploadMediaBlob(compressed, 'image/jpeg', 'general');
      setStoryImageUrl(url);
    } finally {
      setUploadingStory(false);
      e.target.value = '';
    }
  };

  const handlePublishStory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (storyMode === 'text' && !storyCaption.trim()) return;
    try {
      await addDoc(collection(db, 'stories'), {
        authorId: currentUser.uid,
        authorName: currentUser.displayName.slice(0, VALIDATION_CONSTRAINTS.DISPLAY_NAME_MAX),
        authorAvatar: currentUser.avatarUrl || '',
        authorVerified: currentUser.isVerified,
        mediaUrl: storyMode === 'image' ? storyImageUrl : '',
        mediaType: storyMode,
        caption: storyCaption.trim().slice(0, VALIDATION_CONSTRAINTS.STORY_CAPTION_MAX),
        bgStyle: storyBg,
        viewersCount: 0,
        expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
        createdAt: serverTimestamp(),
      });
      setShowCreateStory(false);
      setStoryCaption('');
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'stories');
    }
  };

  const sendFriendRequest = async (target: UserPublicProfile) => {
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

  const pendingIncomingRequests = friendships.filter(
    (f) => f.status === 'pending' && f.recipientId === currentUser.uid
  );

  const suggestedUsers = useMemo(() => {
    const connected = new Set<string>([currentUser.uid]);
    for (const f of friendships) {
      f.participantIds.forEach((id) => connected.add(id));
    }
    return allUsers.filter((u) => !connected.has(u.uid)).slice(0, 5);
  }, [allUsers, friendships, currentUser.uid]);

  const activeStory = activeStoryIndex !== null ? stories[activeStoryIndex] : null;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 grid grid-cols-1 xl:grid-cols-12 gap-8">
      {/* Main Feed Column */}
      <div className="xl:col-span-8 space-y-6">
        {/* Stories Strip */}
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white">
              Stories · 24h
            </h2>
            <button
              type="button"
              onClick={() => setShowCreateStory(true)}
              className="text-xs font-semibold text-sky-600 dark:text-sky-400 hover:underline"
            >
              Add Story
            </button>
          </div>
          <div className="flex items-stretch gap-3 overflow-x-auto scrollbar-thin pb-1">
            {/* Add Story Card */}
            <button
              type="button"
              onClick={() => setShowCreateStory(true)}
              className="w-28 h-44 rounded-2xl border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/60 hover:bg-slate-100 dark:hover:bg-slate-800/60 flex flex-col items-center justify-center gap-2 shrink-0 transition-colors p-3 text-center"
            >
              <div className="w-10 h-10 rounded-full bg-sky-600 text-white flex items-center justify-center">
                <Plus className="w-5 h-5" />
              </div>
              <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                Create Story
              </span>
            </button>

            {stories.map((story, idx) => {
              const imgUrl = sanitizeMediaUrl(story.mediaUrl);
              return (
                <button
                  key={story.id}
                  type="button"
                  onClick={() => setActiveStoryIndex(idx)}
                  className="relative w-28 h-44 rounded-2xl overflow-hidden shrink-0 border border-slate-200 dark:border-slate-800 text-left group"
                >
                  {story.mediaType === 'image' && imgUrl ? (
                    <img
                      src={imgUrl}
                      alt={story.authorName}
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                    />
                  ) : (
                    <div
                      className={`w-full h-full ${story.bgStyle || STORY_BG_STYLES[0]} flex items-center justify-center p-2.5 text-white text-xs font-semibold text-center`}
                    >
                      <span className="line-clamp-4">{story.caption}</span>
                    </div>
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-black/25 p-2.5 flex flex-col justify-between">
                    <Avatar
                      src={story.authorAvatar}
                      name={story.authorName}
                      size="xs"
                      className="ring-2 ring-sky-500 rounded-full"
                    />
                    <span className="text-[11px] font-semibold text-white truncate">
                      {story.authorName}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        {/* Post Composer */}
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 sm:p-5">
          <form onSubmit={handleCreatePost} className="space-y-4">
            <div className="flex items-start gap-3">
              <Avatar src={currentUser.avatarUrl} name={currentUser.displayName} size="md" />
              <textarea
                rows={2}
                maxLength={VALIDATION_CONSTRAINTS.POST_CONTENT_MAX}
                value={postText}
                onChange={(e) => setPostText(e.target.value)}
                placeholder={`What's on your mind, ${currentUser.displayName.split(' ')[0]}?`}
                className="flex-1 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl px-4 py-3 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/40 resize-none"
              />
            </div>

            {postImageUrl && (
              <div className="relative rounded-2xl overflow-hidden border border-slate-200 dark:border-slate-800 max-h-80">
                <img
                  src={postImageUrl}
                  alt="Post upload preview"
                  referrerPolicy="no-referrer"
                  className="w-full max-h-80 object-cover"
                />
                <button
                  type="button"
                  onClick={() => setPostImageUrl('')}
                  className="absolute top-3 right-3 p-1.5 rounded-full bg-black/60 text-white hover:bg-black/80"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            {showMetaInputs && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input
                  type="text"
                  maxLength={60}
                  value={postFeeling}
                  onChange={(e) => setPostFeeling(e.target.value)}
                  placeholder="Feeling (e.g. Grateful, Focused)"
                  className="px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs"
                />
                <input
                  type="text"
                  maxLength={80}
                  value={postLocation}
                  onChange={(e) => setPostLocation(e.target.value)}
                  placeholder="Location (e.g. Dhaka)"
                  className="px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs"
                />
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100 dark:border-slate-800">
              <div className="flex items-center gap-2">
                <label className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-300 cursor-pointer transition-colors">
                  <ImageIcon className="w-4 h-4 text-emerald-500" />
                  {uploadingPostImg ? 'Uploading...' : 'Photo'}
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleUploadPostPhoto}
                    disabled={uploadingPostImg}
                    className="sr-only"
                  />
                </label>

                <button
                  type="button"
                  onClick={() => setShowMetaInputs(!showMetaInputs)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-300 transition-colors"
                >
                  <Smile className="w-4 h-4 text-amber-500" />
                  Feeling / Location
                </button>

                <select
                  value={postPrivacy}
                  onChange={(e) => setPostPrivacy(e.target.value as PrivacyLevel)}
                  className="px-2.5 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200"
                >
                  <option value="public">Public</option>
                  <option value="friends">Friends</option>
                  <option value="only_me">Only Me</option>
                </select>
              </div>

              <button
                type="submit"
                disabled={publishingPost || uploadingPostImg || (!postText.trim() && !postImageUrl)}
                className="px-5 py-2 rounded-xl bg-sky-600 hover:bg-sky-700 disabled:opacity-40 text-white text-xs font-semibold transition-colors"
              >
                {publishingPost ? 'Posting...' : 'Publish Post'}
              </button>
            </div>
          </form>
        </section>

        {/* Feed Stream */}
        {loadingFeed ? (
          <div className="space-y-4">
            {[1, 2].map((n) => (
              <div
                key={n}
                className="h-52 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 animate-pulse"
              />
            ))}
          </div>
        ) : posts.length === 0 ? (
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-10 text-center space-y-3">
            <p className="font-display font-bold text-slate-900 dark:text-white">
              Your feed is ready
            </p>
            <p className="text-sm text-slate-500 dark:text-slate-400 max-w-md mx-auto">
              Share your first photo post above, add a 24-hour story, or connect with friends to see updates in real time.
            </p>
            <button
              type="button"
              onClick={() => setPostImageUrl('/src/assets/images/post_city_twilight_1795238345352.jpg')}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-xs font-semibold text-slate-800 dark:text-slate-200 transition-colors"
            >
              <ImageIcon className="w-4 h-4" />
              Attach Sample City Photo
            </button>
          </div>
        ) : (
          <div className="space-y-5">
            {posts.map((post) => {
              const postImg = sanitizeMediaUrl(post.mediaUrl);
              const myReact = myReactions[post.id];
              const comments = commentsByPost[post.id] || [];
              const commentsOpen = openCommentsPostId === post.id;

              return (
                <article
                  key={post.id}
                  className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden"
                >
                  <div className="p-4 sm:p-5 space-y-3.5">
                    {/* Post Header */}
                    <div className="flex items-start justify-between gap-3">
                      <button
                        type="button"
                        onClick={() => onViewProfile(post.authorId)}
                        className="flex items-center gap-3 text-left min-w-0"
                      >
                        <Avatar
                          src={post.authorAvatar}
                          name={post.authorName}
                          size="md"
                          isOnline={onlineUserIds.includes(post.authorId)}
                        />
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-sm font-bold text-slate-900 dark:text-white truncate">
                              {post.authorName}
                            </span>
                            {post.authorVerified && <VerifiedBadge className="w-4 h-4" />}
                            {post.feeling && (
                              <span className="text-xs text-slate-500 dark:text-slate-400">
                                feeling {post.feeling}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                            <span>
                              {post.createdAt ? formatRelativeTime(post.createdAt.toMillis()) : 'Just now'}
                            </span>
                            <span aria-hidden="true">·</span>
                            {post.privacy === 'public' ? (
                              <Globe className="w-3 h-3" />
                            ) : post.privacy === 'friends' ? (
                              <Users className="w-3 h-3" />
                            ) : (
                              <Lock className="w-3 h-3" />
                            )}
                            {post.location && (
                              <>
                                <span aria-hidden="true">·</span>
                                <MapPin className="w-3 h-3" />
                                <span className="truncate max-w-[140px]">{post.location}</span>
                              </>
                            )}
                          </div>
                        </div>
                      </button>

                      {post.authorId === currentUser.uid && (
                        <button
                          type="button"
                          onClick={() => handleDeletePost(post.id)}
                          aria-label="Delete post"
                          className="p-2 rounded-xl text-slate-400 hover:text-rose-600 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>

                    {post.content && (
                      <p className="text-sm sm:text-[15px] text-slate-800 dark:text-slate-200 whitespace-pre-wrap leading-relaxed">
                        {post.content}
                      </p>
                    )}
                  </div>

                  {postImg && (
                    <div className="bg-slate-100 dark:bg-slate-950 border-y border-slate-100 dark:border-slate-800">
                      <img
                        src={postImg}
                        alt="Post attachment"
                        referrerPolicy="no-referrer"
                        className="w-full max-h-[520px] object-cover"
                      />
                    </div>
                  )}

                  {/* Counts & Actions */}
                  <div className="px-4 sm:px-5 py-3 space-y-2.5">
                    <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 font-mono">
                      <span>{post.likesCount} reactions</span>
                      <div className="flex items-center gap-3">
                        <span>{post.commentsCount} comments</span>
                        <span>{post.sharesCount} shares</span>
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                      <div className="flex items-center gap-1">
                        {REACTION_META.map((r) => (
                          <button
                            key={r.type}
                            type="button"
                            onClick={() => toggleReaction(post, r.type)}
                            title={r.label}
                            className={`px-2.5 py-1.5 rounded-xl text-xs font-medium transition-colors ${
                              myReact === r.type
                                ? 'bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400'
                                : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                            }`}
                          >
                            {r.emoji}
                          </button>
                        ))}
                      </div>

                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() =>
                            setOpenCommentsPostId(commentsOpen ? null : post.id)
                          }
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-300 transition-colors"
                        >
                          <MessageSquare className="w-4 h-4" />
                          Comment
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            updateDoc(doc(db, 'posts', post.id), {
                              sharesCount: increment(1),
                              updatedAt: serverTimestamp(),
                            })
                          }
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-300 transition-colors"
                        >
                          <Share2 className="w-4 h-4" />
                          Share
                        </button>
                      </div>
                    </div>

                    {commentsOpen && (
                      <div className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-3">
                        <div className="flex items-center gap-2">
                          <Avatar src={currentUser.avatarUrl} name={currentUser.displayName} size="xs" />
                          <input
                            type="text"
                            maxLength={VALIDATION_CONSTRAINTS.COMMENT_TEXT_MAX}
                            value={commentText}
                            onChange={(e) => setCommentText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                void handleAddComment(post);
                              }
                            }}
                            placeholder="Write a comment..."
                            className="flex-1 px-3.5 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/40"
                          />
                          <button
                            type="button"
                            onClick={() => handleAddComment(post)}
                            className="p-2 rounded-xl bg-sky-600 text-white"
                          >
                            <Send className="w-3.5 h-3.5" />
                          </button>
                        </div>

                        <div className="space-y-2.5 max-h-60 overflow-y-auto">
                          {comments.map((c) => (
                            <div key={c.id} className="flex items-start gap-2.5">
                              <Avatar src={c.authorAvatar} name={c.authorName} size="xs" />
                              <div className="bg-slate-50 dark:bg-slate-800/70 rounded-xl px-3 py-2 text-xs flex-1">
                                <span className="font-semibold text-slate-900 dark:text-white inline-flex items-center gap-1">
                                  {c.authorName}
                                  {c.authorVerified && <VerifiedBadge className="w-3 h-3" />}
                                </span>
                                <p className="text-slate-700 dark:text-slate-300 mt-0.5">{c.text}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      {/* Right Contextual Sidebar */}
      <aside className="hidden xl:block xl:col-span-4 space-y-6">
        {/* Identity Verification Banner */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-3">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="w-5 h-5 text-sky-600 dark:text-sky-400" />
            <h3 className="font-display font-bold text-sm text-slate-900 dark:text-white">
              Account Security & ID Badge
            </h3>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
            {currentUser.isVerified
              ? 'Your identity is verified with a trusted checkmark badge across chats, posts, and reels.'
              : currentUser.verificationStatus === 'pending'
                ? 'Your ID verification submission is under review.'
                : 'Verify your National ID or Passport to receive your trusted badge and unlock full platform trust.'}
          </p>
          {!currentUser.isVerified && (
            <button
              type="button"
              onClick={onGoVerify}
              className="w-full py-2 rounded-xl bg-slate-900 dark:bg-sky-600 hover:opacity-90 text-white text-xs font-semibold transition-opacity"
            >
              {currentUser.verificationStatus === 'pending' ? 'View Verification Status' : 'Verify Identity'}
            </button>
          )}
        </div>

        {/* Friend Requests */}
        {pendingIncomingRequests.length > 0 && (
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-3">
            <h3 className="font-display font-bold text-sm text-slate-900 dark:text-white">
              Friend Requests ({pendingIncomingRequests.length})
            </h3>
            <div className="space-y-3">
              {pendingIncomingRequests.map((req) => {
                const sender = allUsers.find((u) => u.uid === req.requesterId);
                if (!sender) return null;
                return (
                  <div key={req.id} className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => onViewProfile(sender.uid)}
                      className="flex items-center gap-2.5 min-w-0 text-left"
                    >
                      <Avatar src={sender.avatarUrl} name={sender.displayName} size="sm" />
                      <span className="text-xs font-semibold text-slate-900 dark:text-white truncate">
                        {sender.displayName}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          const batch = writeBatch(db);
                          batch.update(doc(db, 'friendships', req.id), {
                            status: 'accepted',
                            updatedAt: serverTimestamp(),
                          });
                          batch.update(doc(db, 'users', req.requesterId), {
                            friendsCount: increment(1),
                            updatedAt: serverTimestamp(),
                          });
                          batch.update(doc(db, 'users', req.recipientId), {
                            friendsCount: increment(1),
                            updatedAt: serverTimestamp(),
                          });
                          await batch.commit();
                        } catch (err) {
                          handleFirestoreError(err, OperationType.UPDATE, `friendships/${req.id}`);
                        }
                      }}
                      className="px-3 py-1.5 rounded-lg bg-sky-600 text-white text-xs font-semibold shrink-0"
                    >
                      Accept
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* People to Connect With */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-3">
          <h3 className="font-display font-bold text-sm text-slate-900 dark:text-white">
            People on Alap
          </h3>
          {suggestedUsers.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              All registered members are connected with you.
            </p>
          ) : (
            <div className="space-y-3">
              {suggestedUsers.map((u) => (
                <div key={u.uid} className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => onViewProfile(u.uid)}
                    className="flex items-center gap-2.5 min-w-0 text-left"
                  >
                    <Avatar
                      src={u.avatarUrl}
                      name={u.displayName}
                      size="sm"
                      isOnline={onlineUserIds.includes(u.uid)}
                    />
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-slate-900 dark:text-white truncate inline-flex items-center gap-1">
                        {u.displayName}
                        {u.isVerified && <VerifiedBadge className="w-3.5 h-3.5" />}
                      </p>
                      <p className="text-[11px] text-slate-500 truncate">@{u.username}</p>
                    </div>
                  </button>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => sendFriendRequest(u)}
                      title="Add Friend"
                      className="p-2 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-sky-50 dark:hover:bg-sky-950/60 text-slate-700 dark:text-slate-200"
                    >
                      <UserPlus className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onMessageUser(u)}
                      title="Message"
                      className="p-2 rounded-lg bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400"
                    >
                      <Send className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>

      {/* Modal: Create 24h Story */}
      {showCreateStory && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <form
            onSubmit={handlePublishStory}
            className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-display font-bold text-slate-900 dark:text-white">
                Create 24-Hour Story
              </h3>
              <button
                type="button"
                onClick={() => setShowCreateStory(false)}
                className="p-1 text-slate-400"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-slate-100 dark:bg-slate-800">
              <button
                type="button"
                onClick={() => setStoryMode('image')}
                className={`py-2 text-xs font-semibold rounded-lg ${
                  storyMode === 'image' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs' : 'text-slate-500'
                }`}
              >
                Photo Story
              </button>
              <button
                type="button"
                onClick={() => setStoryMode('text')}
                className={`py-2 text-xs font-semibold rounded-lg ${
                  storyMode === 'text' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs' : 'text-slate-500'
                }`}
              >
                Text Story
              </button>
            </div>

            {storyMode === 'image' ? (
              <div className="space-y-3">
                <div className="h-56 rounded-2xl overflow-hidden bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                  <img
                    src={storyImageUrl}
                    alt="Story preview"
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                  />
                </div>
                <label className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-semibold cursor-pointer">
                  <ImageIcon className="w-4 h-4" />
                  {uploadingStory ? 'Uploading...' : 'Choose Story Photo'}
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleUploadStoryPhoto}
                    className="sr-only"
                  />
                </label>
              </div>
            ) : (
              <div className="space-y-3">
                <div
                  className={`h-44 rounded-2xl ${storyBg} flex items-center justify-center p-6 text-white text-center font-display text-lg font-bold`}
                >
                  {storyCaption || 'Your story text appears here'}
                </div>
                <div className="flex items-center gap-2">
                  {STORY_BG_STYLES.map((bg) => (
                    <button
                      key={bg}
                      type="button"
                      onClick={() => setStoryBg(bg)}
                      className={`w-8 h-8 rounded-full ${bg} ${
                        storyBg === bg ? 'ring-2 ring-sky-500 ring-offset-2' : ''
                      }`}
                    />
                  ))}
                </div>
              </div>
            )}

            <input
              type="text"
              maxLength={VALIDATION_CONSTRAINTS.STORY_CAPTION_MAX}
              value={storyCaption}
              onChange={(e) => setStoryCaption(e.target.value)}
              placeholder="Add a caption..."
              className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm"
            />

            <button
              type="submit"
              disabled={uploadingStory || (storyMode === 'text' && !storyCaption.trim())}
              className="w-full py-2.5 rounded-xl bg-sky-600 hover:bg-sky-700 disabled:opacity-40 text-white text-sm font-semibold"
            >
              Share Story for 24 Hours
            </button>
          </form>
        </div>
      )}

      {/* Full-Screen Story Viewer */}
      {activeStory && activeStoryIndex !== null && (
        <div className="fixed inset-0 z-50 bg-slate-950/95 flex items-center justify-center p-4">
          <div className="relative w-full max-w-sm h-[84vh] rounded-3xl overflow-hidden bg-slate-900 border border-slate-800 flex flex-col justify-between">
            {activeStory.mediaType === 'image' && sanitizeMediaUrl(activeStory.mediaUrl) ? (
              <img
                src={sanitizeMediaUrl(activeStory.mediaUrl)}
                alt={activeStory.authorName}
                referrerPolicy="no-referrer"
                className="absolute inset-0 w-full h-full object-cover"
              />
            ) : (
              <div
                className={`absolute inset-0 ${activeStory.bgStyle || STORY_BG_STYLES[0]} flex items-center justify-center p-8 text-white text-center font-display text-2xl font-bold`}
              >
                {activeStory.caption}
              </div>
            )}

            <div className="relative z-10 p-4 bg-gradient-to-b from-black/75 to-transparent space-y-3">
              <div className="flex gap-1">
                {stories.map((s, idx) => (
                  <div
                    key={s.id}
                    className={`h-1 flex-1 rounded-full ${
                      idx <= activeStoryIndex ? 'bg-white' : 'bg-white/30'
                    }`}
                  />
                ))}
              </div>
              <div className="flex items-center justify-between text-white">
                <div className="flex items-center gap-2.5">
                  <Avatar src={activeStory.authorAvatar} name={activeStory.authorName} size="xs" />
                  <div>
                    <p className="text-xs font-bold inline-flex items-center gap-1">
                      {activeStory.authorName}
                      {activeStory.authorVerified && <VerifiedBadge className="w-3 h-3" />}
                    </p>
                    <p className="text-[11px] text-white/75 inline-flex items-center gap-1 ml-2">
                      <Eye className="w-3 h-3" /> {activeStory.viewersCount}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveStoryIndex(null)}
                  className="p-1.5 rounded-full bg-black/40 text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Navigation Tap Zones */}
            <div className="relative z-10 flex-1 flex items-center justify-between px-2">
              <button
                type="button"
                disabled={activeStoryIndex === 0}
                onClick={() => setActiveStoryIndex((i) => (i !== null && i > 0 ? i - 1 : i))}
                className="p-2 rounded-full bg-black/40 text-white disabled:opacity-20"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              <button
                type="button"
                onClick={() =>
                  setActiveStoryIndex((i) =>
                    i !== null && i < stories.length - 1 ? i + 1 : null
                  )
                }
                className="p-2 rounded-full bg-black/40 text-white"
              >
                <ChevronRight className="w-5 h-5" />
              </button>
            </div>

            <div className="relative z-10 p-4 bg-gradient-to-t from-black/80 to-transparent space-y-2">
              {activeStory.mediaType === 'image' && activeStory.caption && (
                <p className="text-sm text-white text-center">{activeStory.caption}</p>
              )}
              {activeStory.authorId !== currentUser.uid && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const author = allUsers.find((u) => u.uid === activeStory.authorId);
                    const draft = storyReplyText.trim()
                      ? `Story reply: "${storyReplyText.trim()}"`
                      : 'Liked your story ❤️';
                    setActiveStoryIndex(null);
                    setStoryReplyText('');
                    if (author) onMessageUser(author, draft);
                  }}
                  className="flex items-center gap-2"
                >
                  <input
                    type="text"
                    value={storyReplyText}
                    onChange={(e) => setStoryReplyText(e.target.value)}
                    placeholder="Reply to story..."
                    className="flex-1 px-3.5 py-2 rounded-xl bg-white/15 text-white placeholder:text-white/60 text-xs backdrop-blur-md focus:outline-none"
                  />
                  <button
                    type="submit"
                    aria-label="Send story reply"
                    className="p-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white transition-colors"
                  >
                    {storyReplyText.trim() ? (
                      <Send className="w-4 h-4" />
                    ) : (
                      <Heart className="w-4 h-4" />
                    )}
                  </button>
                </form>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

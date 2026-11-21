import type { Timestamp } from 'firebase/firestore';

export const VALIDATION_CONSTRAINTS = {
  ID_PATTERN: /^[a-zA-Z0-9_-]+$/,
  USERNAME_PATTERN: /^[a-zA-Z0-9_.]+$/,
  USERNAME_MIN: 3,
  USERNAME_MAX: 30,
  DISPLAY_NAME_MAX: 60,
  BIO_MAX: 240,
  CITY_MAX: 80,
  WORK_MAX: 80,
  CHAT_NAME_MAX: 80,
  MESSAGE_TEXT_MAX: 4000,
  POST_CONTENT_MAX: 5000,
  COMMENT_TEXT_MAX: 1000,
  STORY_CAPTION_MAX: 300,
  REEL_CAPTION_MAX: 500,
  REEL_MIN_DURATION: 15,
  REEL_MAX_DURATION: 60,
  FULL_NAME_MAX: 100,
} as const;

export type VerificationStatus = 'none' | 'pending' | 'verified' | 'rejected';
export type PrivacyLevel = 'public' | 'friends' | 'only_me';
export type DocumentType = 'nid' | 'passport' | 'driving_license';
export type ReactionType = 'like' | 'love' | 'haha' | 'wow' | 'sad';
export type CallType = 'audio' | 'video' | 'group';
export type CallStatus = 'ringing' | 'active' | 'ended' | 'declined' | 'missed';
export type MessageType = 'text' | 'image' | 'audio' | 'video' | 'file' | 'call' | 'system';

export interface UserPublicProfile {
  uid: string;
  username: string;
  displayName: string;
  bio?: string;
  avatarUrl?: string;
  coverUrl?: string;
  city?: string;
  work?: string;
  isVerified: boolean;
  verificationStatus: VerificationStatus;
  isOnline: boolean;
  followersCount: number;
  friendsCount: number;
  publicKeyJwk?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface UserPrivateInfo {
  uid: string;
  email: string;
  phone?: string;
  chatLockPinHash?: string;
  twoFactorEnabled: boolean;
  privacyDefault: PrivacyLevel;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface IdentityVerification {
  id?: string;
  userId: string;
  fullName: string;
  documentType: DocumentType;
  documentLast4: string;
  documentHash: string;
  idFrontUrl: string;
  selfieUrl: string;
  status: 'pending' | 'approved' | 'rejected';
  reviewerNote?: string;
  reviewedBy?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Friendship {
  id: string;
  requesterId: string;
  recipientId: string;
  participantIds: string[];
  status: 'pending' | 'accepted' | 'blocked';
  blockedBy?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ChatRoom {
  id: string;
  type: 'direct' | 'group';
  name: string;
  avatarUrl?: string;
  createdBy: string;
  memberIds: string[];
  adminIds: string[];
  lastMessageText?: string;
  lastMessageSenderId?: string;
  lastMessageAt?: Timestamp;
  isEncrypted: boolean;
  disappearingSeconds: 0 | 10 | 60 | 86400;
  safetyCode: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ChatMember {
  userId: string;
  chatId: string;
  role: 'admin' | 'member';
  nickname?: string;
  isMuted: boolean;
  isPinned: boolean;
  isArchived: boolean;
  isLocked: boolean;
  lastReadAt?: Timestamp;
  joinedAt: Timestamp;
}

export interface ChatMessage {
  id: string;
  chatId: string;
  senderId: string;
  senderName: string;
  type: MessageType;
  text: string;
  mediaUrl?: string;
  mediaDurationSec?: number;
  replyToId?: string;
  replyToPreview?: string;
  reactions: string[];
  isEdited: boolean;
  isDeleted: boolean;
  expiresAtMs: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface SocialPost {
  id: string;
  authorId: string;
  authorName: string;
  authorUsername: string;
  authorAvatar?: string;
  authorVerified: boolean;
  content: string;
  mediaUrl?: string;
  mediaType: 'none' | 'image' | 'video';
  privacy: PrivacyLevel;
  feeling?: string;
  location?: string;
  likesCount: number;
  commentsCount: number;
  sharesCount: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface PostComment {
  id: string;
  postId: string;
  authorId: string;
  authorName: string;
  authorAvatar?: string;
  authorVerified: boolean;
  text: string;
  parentCommentId?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface StoryItem {
  id: string;
  authorId: string;
  authorName: string;
  authorAvatar?: string;
  authorVerified: boolean;
  mediaUrl?: string;
  mediaType: 'image' | 'text';
  caption?: string;
  bgStyle?: string;
  viewersCount: number;
  expiresAtMs: number;
  createdAt: Timestamp;
}

export interface ShortReel {
  id: string;
  authorId: string;
  authorName: string;
  authorUsername: string;
  authorAvatar?: string;
  authorVerified: boolean;
  videoUrl: string;
  thumbnailUrl?: string;
  caption?: string;
  audioTrack?: string;
  durationSeconds: number;
  likesCount: number;
  commentsCount: number;
  viewsCount: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ReelComment {
  id: string;
  reelId: string;
  authorId: string;
  authorName: string;
  authorAvatar?: string;
  authorVerified: boolean;
  text: string;
  createdAt: Timestamp;
}

export interface CallRecord {
  id: string;
  callerId: string;
  callerName: string;
  callerAvatar?: string;
  calleeId: string;
  calleeName: string;
  chatId: string;
  callType: CallType;
  status: CallStatus;
  durationSeconds: number;
  participantIds: string[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface NotificationItem {
  id: string;
  recipientId: string;
  actorId: string;
  actorName: string;
  actorAvatar?: string;
  type: 'friend_request' | 'friend_accept' | 'like' | 'comment' | 'call' | 'verification' | 'message';
  targetId?: string;
  text: string;
  isRead: boolean;
  createdAt: Timestamp;
}

export type NavTab = 'feed' | 'messages' | 'reels' | 'friends' | 'verify' | 'profile';

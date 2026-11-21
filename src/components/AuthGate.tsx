import React, { useEffect, useState } from 'react';
import { signInWithPopup, signOut, type User } from 'firebase/auth';
import { doc, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';
import {
  Camera,
  Lock,
  MessageCircle,
  ShieldCheck,
  Video,
  Film,
  Users,
  ArrowRight,
  LogOut,
} from 'lucide-react';
import { auth, db, googleProvider, handleFirestoreError, OperationType } from '../lib/firebase';
import { compressImageFile, uploadMediaBlob } from '../lib/mediaUpload';
import { generateIdentityKeyPair, sha256Hex } from '../lib/security';
import { VALIDATION_CONSTRAINTS } from '../types/app';

interface AuthGateProps {
  firebaseUser: User | null;
  needsOnboarding: boolean;
  onAccountCreated: () => void;
}

export function AuthGate({ firebaseUser, needsOnboarding, onAccountCreated }: AuthGateProps) {
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState('');

  // Onboarding / Create Account form state
  const [displayName, setDisplayName] = useState(firebaseUser?.displayName || '');
  const [username, setUsername] = useState(
    (firebaseUser?.email?.split('@')[0] || 'user').replace(/[^a-zA-Z0-9_.]/g, '').slice(0, 24)
  );
  const [bio, setBio] = useState('');
  const [city, setCity] = useState('');
  const [work, setWork] = useState('');
  const [pinCode, setPinCode] = useState('');
  const [avatarUrl, setAvatarUrl] = useState(firebaseUser?.photoURL || '');
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [savingAccount, setSavingAccount] = useState(false);

  useEffect(() => {
    if (!firebaseUser) return;
    setDisplayName((prev) => prev || firebaseUser.displayName || '');
    setUsername((prev) => {
      if (prev && prev !== 'user') return prev;
      const base = (firebaseUser.email?.split('@')[0] || 'user')
        .replace(/[^a-zA-Z0-9_.]/g, '')
        .slice(0, 24);
      return base.length >= 3 ? base : `alap_${base}`;
    });
    setAvatarUrl((prev) => prev || firebaseUser.photoURL || '');
  }, [firebaseUser?.uid, firebaseUser?.displayName, firebaseUser?.email, firebaseUser?.photoURL]);

  const handleGoogleSignIn = async () => {
    setAuthLoading(true);
    setAuthError('');
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sign-in could not complete.';
      setAuthError(msg);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingAvatar(true);
    setAuthError('');
    try {
      const compressed = await compressImageFile(file, 512, 0.85);
      const url = await uploadMediaBlob(compressed, 'image/jpeg', 'general');
      setAvatarUrl(url);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Avatar upload failed');
    } finally {
      setUploadingAvatar(false);
      e.target.value = '';
    }
  };

  const handleCreateAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser) return;

    const cleanName = displayName.trim().slice(0, VALIDATION_CONSTRAINTS.DISPLAY_NAME_MAX);
    const cleanUser = username.trim().toLowerCase().slice(0, VALIDATION_CONSTRAINTS.USERNAME_MAX);
    if (!cleanName) {
      setAuthError('Display name is required.');
      return;
    }
    if (
      cleanUser.length < VALIDATION_CONSTRAINTS.USERNAME_MIN ||
      !VALIDATION_CONSTRAINTS.USERNAME_PATTERN.test(cleanUser)
    ) {
      setAuthError('Username must be 3-30 characters using letters, numbers, dots, or underscores.');
      return;
    }
    if (pinCode && (pinCode.length < 4 || pinCode.length > 6 || !/^\d+$/.test(pinCode))) {
      setAuthError('Security PIN must be 4 to 6 digits.');
      return;
    }

    setSavingAccount(true);
    setAuthError('');
    try {
      const { publicKeyJwk } = await generateIdentityKeyPair();
      const pinHash = pinCode ? await sha256Hex(pinCode) : '';

      const batch = writeBatch(db);
      const publicRef = doc(db, 'users', firebaseUser.uid);
      const privateRef = doc(db, 'users', firebaseUser.uid, 'private', 'info');

      batch.set(publicRef, {
        uid: firebaseUser.uid,
        username: cleanUser,
        displayName: cleanName,
        bio: bio.trim().slice(0, VALIDATION_CONSTRAINTS.BIO_MAX),
        avatarUrl: avatarUrl || firebaseUser.photoURL || '',
        coverUrl: '/src/assets/images/default_cover_banner_1795238344707.jpg',
        city: city.trim().slice(0, VALIDATION_CONSTRAINTS.CITY_MAX),
        work: work.trim().slice(0, VALIDATION_CONSTRAINTS.WORK_MAX),
        isVerified: false,
        verificationStatus: 'none',
        isOnline: true,
        followersCount: 0,
        friendsCount: 0,
        publicKeyJwk,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      batch.set(privateRef, {
        uid: firebaseUser.uid,
        email: firebaseUser.email || '',
        phone: '',
        chatLockPinHash: pinHash,
        twoFactorEnabled: Boolean(pinHash),
        privacyDefault: 'public',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      // Bootstrap admin doc automatically for owner email
      const ownerEmails = ['tanjilahmedjoy85@gmail.com', 'tanjilahmedjoy797@gmail.com'];
      if (firebaseUser.email && ownerEmails.includes(firebaseUser.email) && firebaseUser.emailVerified) {
        const adminRef = doc(db, 'admins', firebaseUser.uid);
        await setDoc(adminRef, {
          uid: firebaseUser.uid,
          email: firebaseUser.email,
          createdAt: serverTimestamp(),
        }).catch(() => {});
      }

      await batch.commit();
      onAccountCreated();
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `users/${firebaseUser.uid}`);
    } finally {
      setSavingAccount(false);
    }
  };

  if (firebaseUser && needsOnboarding) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center p-4 sm:p-8">
        <div className="w-full max-w-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 sm:p-8 shadow-sm">
          <div className="flex items-center justify-between gap-4 mb-6 pb-5 border-b border-slate-100 dark:border-slate-800">
            <div>
              <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">
                Create Your Alap Account
              </h1>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                Set up your public profile, username, and optional chat lock PIN.
              </p>
            </div>
            <button
              type="button"
              onClick={() => signOut(auth)}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-900 dark:hover:text-slate-200 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800"
            >
              <LogOut className="w-3.5 h-3.5" />
              Switch Account
            </button>
          </div>

          <form onSubmit={handleCreateAccount} className="space-y-5">
            <div className="flex items-center gap-5">
              <div className="relative w-20 h-20 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden border border-slate-200 dark:border-slate-700 shrink-0">
                {avatarUrl ? (
                  <img
                    src={avatarUrl}
                    alt="Profile avatar"
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-slate-400 font-semibold text-xl">
                    {(displayName[0] || 'A').toUpperCase()}
                  </div>
                )}
              </div>
              <div>
                <label className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 text-sm font-medium cursor-pointer transition-colors">
                  <Camera className="w-4 h-4" />
                  {uploadingAvatar ? 'Uploading...' : 'Upload Profile Photo'}
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleAvatarUpload}
                    className="sr-only"
                    disabled={uploadingAvatar}
                  />
                </label>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5">
                  Signed in as {firebaseUser.email}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                  Full Name
                </label>
                <input
                  type="text"
                  required
                  maxLength={VALIDATION_CONSTRAINTS.DISPLAY_NAME_MAX}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="e.g. Tanjil Ahmed"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/40"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                  Username
                </label>
                <input
                  type="text"
                  required
                  minLength={VALIDATION_CONSTRAINTS.USERNAME_MIN}
                  maxLength={VALIDATION_CONSTRAINTS.USERNAME_MAX}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="tanjil.ahmed"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/40"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                Bio
              </label>
              <textarea
                rows={2}
                maxLength={VALIDATION_CONSTRAINTS.BIO_MAX}
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder="Share a quick intro for your profile..."
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/40 resize-none"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                  City
                </label>
                <input
                  type="text"
                  maxLength={VALIDATION_CONSTRAINTS.CITY_MAX}
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="Dhaka"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/40"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                  Work / Study
                </label>
                <input
                  type="text"
                  maxLength={VALIDATION_CONSTRAINTS.WORK_MAX}
                  value={work}
                  onChange={(e) => setWork(e.target.value)}
                  placeholder="Software Engineer"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/40"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                  Chat Lock PIN (Optional)
                </label>
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  value={pinCode}
                  onChange={(e) => setPinCode(e.target.value)}
                  placeholder="4-6 digits"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/40"
                />
              </div>
            </div>

            {authError && (
              <p className="text-sm text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/50 rounded-xl px-3.5 py-2.5">
                {authError}
              </p>
            )}

            <button
              type="submit"
              disabled={savingAccount}
              className="w-full inline-flex items-center justify-center gap-2 py-3 px-6 rounded-xl bg-sky-600 hover:bg-sky-700 disabled:opacity-60 text-white font-semibold text-sm transition-colors"
            >
              {savingAccount ? 'Creating Account...' : 'Complete Account Setup'}
              <ArrowRight className="w-4 h-4" />
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col lg:flex-row">
      {/* Left Narrative & Action Column */}
      <div className="flex-1 flex flex-col justify-between p-6 sm:p-10 lg:p-14 max-w-2xl mx-auto lg:mx-0 w-full">
        <div className="flex items-center justify-between">
          <span className="font-display text-2xl font-extrabold tracking-tight text-slate-900 dark:text-white">
            Alap
          </span>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Secure Messenger · Social Network
          </span>
        </div>

        <div className="my-12 lg:my-0 space-y-8">
          <div className="space-y-4">
            <h1 className="font-display text-4xl sm:text-5xl font-bold tracking-tight text-slate-900 dark:text-white text-balance leading-[1.1]">
              Private conversations, live video calls, and verified social space.
            </h1>
            <p className="text-base text-slate-600 dark:text-slate-400 max-w-lg leading-relaxed">
              Connect through encrypted direct & group messaging, HD WebRTC audio and video calling, photo posts, 24-hour stories, and 15 to 60 second video reels with verified identity protection.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
              <MessageCircle className="w-5 h-5 text-sky-600 dark:text-sky-400 mb-2" />
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Direct & Group Messenger
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                Voice notes, replies, reactions, disappearing timers, and PIN chat lock.
              </p>
            </div>
            <div className="p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
              <Video className="w-5 h-5 text-sky-600 dark:text-sky-400 mb-2" />
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                HD Video & Audio Calling
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                Real-time peer-to-peer WebRTC calling with screen sharing and live controls.
              </p>
            </div>
            <div className="p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
              <Film className="w-5 h-5 text-sky-600 dark:text-sky-400 mb-2" />
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Posts, Stories & 15–60s Reels
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                Photo feed, ephemeral stories, and vertical short video creator with trimmer.
              </p>
            </div>
            <div className="p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
              <ShieldCheck className="w-5 h-5 text-sky-600 dark:text-sky-400 mb-2" />
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                ID Verification & Security
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                Verified badge workflow, safety numbers, and strict PII isolation.
              </p>
            </div>
          </div>

          <div className="space-y-3 pt-2">
            <button
              type="button"
              onClick={handleGoogleSignIn}
              disabled={authLoading}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-3 px-7 py-3.5 rounded-xl bg-slate-900 hover:bg-slate-800 dark:bg-sky-600 dark:hover:bg-sky-500 text-white font-semibold text-sm transition-colors shadow-sm disabled:opacity-60"
            >
              <Lock className="w-4 h-4" />
              {authLoading ? 'Connecting Account...' : 'Sign In or Create Account with Google'}
              <ArrowRight className="w-4 h-4" />
            </button>
            {authError && (
              <p className="text-sm text-rose-600 dark:text-rose-400">{authError}</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-4 text-xs text-slate-500 dark:text-slate-400">
          <span className="inline-flex items-center gap-1.5">
            <Users className="w-3.5 h-3.5" />
            End-to-End Safety Codes
          </span>
          <span aria-hidden="true">·</span>
          <span>Real-Time WebSocket & Firestore</span>
        </div>
      </div>

      {/* Right Full-Height Editorial Visual Column */}
      <div className="hidden lg:block lg:flex-1 p-6">
        <div className="relative h-full w-full rounded-3xl overflow-hidden border border-slate-200 dark:border-slate-800 bg-slate-200 dark:bg-slate-900">
          <img
            src="/src/assets/images/auth_welcome_visual_1795238346266.jpg"
            alt="Sunlit architectural atrium representing calm connected spaces"
            referrerPolicy="no-referrer"
            className="w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-slate-950/75 via-slate-950/20 to-transparent flex items-end p-10">
            <div className="max-w-md text-white space-y-2">
              <p className="text-xs font-medium tracking-wide text-sky-300">
                Verified Social & Messenger Workspace
              </p>
              <p className="font-display text-2xl font-semibold leading-snug">
                Built for fast conversations, face-to-face video calls, and authentic creator stories.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

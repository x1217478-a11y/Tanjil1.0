import React, { useEffect, useRef, useState } from 'react';
import {
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  BadgeCheck,
  Bell,
  Camera,
  CheckCircle2,
  Cpu,
  Database,
  FileCheck,
  HardDrive,
  KeyRound,
  Lock,
  Mic,
  Radio,
  RefreshCw,
  Server,
  Shield,
  ShieldCheck,
  Upload,
  Wifi,
  XCircle,
} from 'lucide-react';
import { auth, db, handleFirestoreError, OperationType } from '../lib/firebase';
import { compressImageFile, uploadMediaBlob } from '../lib/mediaUpload';
import {
  checkDevicePermissions,
  fetchSystemStatus,
  requestAllPermissions,
  requestMediaPermission,
  requestNotificationPermission,
  type DevicePermissionsSummary,
  type SystemStatusReport,
} from '../lib/permissions';
import { sanitizeMediaUrl, sha256Hex } from '../lib/security';
import {
  VALIDATION_CONSTRAINTS,
  type DocumentType,
  type IdentityVerification,
  type PrivacyLevel,
  type UserPrivateInfo,
  type UserPublicProfile,
} from '../types/app';

interface VerifyAndSecurityViewProps {
  currentUser: UserPublicProfile;
  privateInfo: UserPrivateInfo | null;
}

export function VerifyAndSecurityView({
  currentUser,
  privateInfo,
}: VerifyAndSecurityViewProps) {
  const [myVerification, setMyVerification] = useState<IdentityVerification | null>(null);
  const [adminQueue, setAdminQueue] = useState<IdentityVerification[]>([]);

  // Verification submission form
  const [fullName, setFullName] = useState(currentUser.displayName);
  const [docType, setDocType] = useState<DocumentType>('nid');
  const [docNumber, setDocNumber] = useState('');
  const [idFrontUrl, setIdFrontUrl] = useState('');
  const [selfieUrl, setSelfieUrl] = useState('');
  const [uploadingDoc, setUploadingDoc] = useState(false);
  const [submittingVerify, setSubmittingVerify] = useState(false);
  const [verifyMsg, setVerifyMsg] = useState('');

  // Live Selfie Camera
  const [cameraOpen, setCameraOpen] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Security & PIN state
  const [newPin, setNewPin] = useState('');
  const [twoFactor, setTwoFactor] = useState(privateInfo?.twoFactorEnabled || false);
  const [privacyDefault, setPrivacyDefault] = useState<PrivacyLevel>(
    privateInfo?.privacyDefault || 'public'
  );
  const [secMsg, setSecMsg] = useState('');
  const [savingSec, setSavingSec] = useState(false);

  // Device Permissions & Server Guardrails
  const [permissions, setPermissions] = useState<DevicePermissionsSummary>({
    camera: 'prompt',
    microphone: 'prompt',
    notifications: 'prompt',
  });
  const [serverInfo, setServerInfo] = useState<SystemStatusReport | null>(null);
  const [loadingServerInfo, setLoadingServerInfo] = useState(false);
  const [permMsg, setPermMsg] = useState('');

  const isAdminUser =
    auth.currentUser?.email === 'tanjilahmedjoy85@gmail.com' ||
    auth.currentUser?.email === 'tanjilahmedjoy797@gmail.com';

  const refreshPermissionsAndServer = async () => {
    setLoadingServerInfo(true);
    try {
      const [perms, sys] = await Promise.all([
        checkDevicePermissions(),
        fetchSystemStatus().catch(() => null),
      ]);
      setPermissions(perms);
      if (sys) setServerInfo(sys);
    } finally {
      setLoadingServerInfo(false);
    }
  };

  useEffect(() => {
    void refreshPermissionsAndServer();
  }, []);

  useEffect(() => {
    setTwoFactor(privateInfo?.twoFactorEnabled || false);
    setPrivacyDefault(privateInfo?.privacyDefault || 'public');
  }, [privateInfo]);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Listen to current user's verification doc
  useEffect(() => {
    const unsub = onSnapshot(
      doc(db, 'verifications', currentUser.uid),
      (snap) => {
        if (snap.exists()) {
          setMyVerification({
            id: snap.id,
            ...(snap.data() as Omit<IdentityVerification, 'id'>),
          });
        } else {
          setMyVerification(null);
        }
      },
      (err) => handleFirestoreError(err, OperationType.GET, `verifications/${currentUser.uid}`)
    );
    return () => unsub();
  }, [currentUser.uid]);

  // Admin Queue Listener
  useEffect(() => {
    if (!isAdminUser) return;
    const q = query(
      collection(db, 'verifications'),
      where('status', '==', 'pending')
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<IdentityVerification, 'id'>) }))
          .sort((a, b) => (a.createdAt?.toMillis() || 0) - (b.createdAt?.toMillis() || 0));
        setAdminQueue(list);
      },
      () => {}
    );
    return () => unsub();
  }, [isAdminUser]);

  const handleUploadImage = async (
    e: React.ChangeEvent<HTMLInputElement>,
    target: 'front' | 'selfie'
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingDoc(true);
    try {
      const compressed = await compressImageFile(file, 1080, 0.85);
      const url = await uploadMediaBlob(compressed, 'image/jpeg', 'verification');
      if (target === 'front') setIdFrontUrl(url);
      else setSelfieUrl(url);
    } finally {
      setUploadingDoc(false);
    }
  };

  const openSelfieCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
      streamRef.current = stream;
      setCameraOpen(true);
      setTimeout(() => {
        if (videoRef.current) videoRef.current.srcObject = stream;
      }, 60);
    } catch {
      setVerifyMsg('Unable to access camera. You can upload a selfie image instead.');
    }
  };

  const captureSelfie = async () => {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((res) =>
        canvas.toBlob(res, 'image/jpeg', 0.85)
      );
      if (blob) {
        setUploadingDoc(true);
        try {
          const url = await uploadMediaBlob(blob, 'image/jpeg', 'verification');
          setSelfieUrl(url);
        } finally {
          setUploadingDoc(false);
        }
      }
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    setCameraOpen(false);
  };

  const handleSubmitVerification = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = fullName.trim().slice(0, VALIDATION_CONSTRAINTS.FULL_NAME_MAX);
    const cleanNum = docNumber.trim().replace(/\s+/g, '');
    if (!cleanName || cleanNum.length < 4 || !idFrontUrl || !selfieUrl) {
      setVerifyMsg('Provide your legal name, document number, ID front photo, and selfie.');
      return;
    }

    setSubmittingVerify(true);
    setVerifyMsg('');
    try {
      const documentHash = await sha256Hex(`${currentUser.uid}:${docType}:${cleanNum}`);
      const documentLast4 = cleanNum.slice(-4);

      const batch = writeBatch(db);
      const verifRef = doc(db, 'verifications', currentUser.uid);
      if (myVerification) {
        batch.update(verifRef, {
          fullName: cleanName,
          documentType: docType,
          documentLast4,
          documentHash,
          idFrontUrl,
          selfieUrl,
          status: 'pending',
          reviewerNote: '',
          reviewedBy: '',
          updatedAt: serverTimestamp(),
        });
      } else {
        batch.set(verifRef, {
          userId: currentUser.uid,
          fullName: cleanName,
          documentType: docType,
          documentLast4,
          documentHash,
          idFrontUrl,
          selfieUrl,
          status: 'pending',
          reviewerNote: '',
          reviewedBy: '',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      batch.update(doc(db, 'users', currentUser.uid), {
        verificationStatus: 'pending',
        updatedAt: serverTimestamp(),
      });
      await batch.commit();
      setDocNumber('');
      setVerifyMsg('Verification submitted successfully. Review is now pending.');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `verifications/${currentUser.uid}`);
    } finally {
      setSubmittingVerify(false);
    }
  };

  const handleAdminDecision = async (
    item: IdentityVerification,
    decision: 'approved' | 'rejected'
  ) => {
    if (!item.id) return;
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'verifications', item.id), {
        status: decision,
        reviewedBy: currentUser.uid,
        reviewerNote: decision === 'approved' ? 'Verified ID documents' : 'Document unclear',
        updatedAt: serverTimestamp(),
      });
      batch.update(doc(db, 'users', item.userId), {
        isVerified: decision === 'approved',
        verificationStatus: decision === 'approved' ? 'verified' : 'rejected',
        updatedAt: serverTimestamp(),
      });
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `verifications/${item.id}`);
    }
  };

  const handleSaveSecurity = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPin && (newPin.length < 4 || newPin.length > 6 || !/^\d+$/.test(newPin))) {
      setSecMsg('Chat Lock PIN must be 4 to 6 digits.');
      return;
    }
    setSavingSec(true);
    setSecMsg('');
    try {
      const pinHash = newPin ? await sha256Hex(newPin) : privateInfo?.chatLockPinHash || '';
      await updateDoc(doc(db, 'users', currentUser.uid, 'private', 'info'), {
        chatLockPinHash: pinHash,
        twoFactorEnabled: twoFactor,
        privacyDefault,
        updatedAt: serverTimestamp(),
      });
      setNewPin('');
      setSecMsg('Security settings updated.');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `users/${currentUser.uid}/private/info`);
    } finally {
      setSavingSec(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-8">
      <div>
        <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
          ID Verification & Security Center
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
          Verify your identity for a trusted badge and manage chat lock PIN, 2FA, and privacy defaults.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: ID Verification */}
        <section className="lg:col-span-7 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-5">
          <div className="flex items-center justify-between gap-4 pb-4 border-b border-slate-100 dark:border-slate-800">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400 flex items-center justify-center">
                <BadgeCheck className="w-5 h-5" />
              </div>
              <div>
                <h2 className="font-display font-bold text-slate-900 dark:text-white">
                  Identity Verification (KYC)
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Document numbers are hashed locally before storage
                </p>
              </div>
            </div>
            <span className="text-xs font-semibold capitalize text-sky-600 dark:text-sky-400">
              Status: {currentUser.isVerified ? 'Verified' : currentUser.verificationStatus}
            </span>
          </div>

          {currentUser.isVerified || myVerification?.status === 'approved' ? (
            <div className="p-5 rounded-2xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900/50 flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
              <div>
                <h3 className="text-sm font-bold text-emerald-900 dark:text-emerald-200">
                  Identity Verified
                </h3>
                <p className="text-xs text-emerald-700 dark:text-emerald-300 mt-1">
                  Your account carries the verified badge across Messenger, Feed posts, Stories, and Reels.
                </p>
              </div>
            </div>
          ) : myVerification?.status === 'pending' ? (
            <div className="p-5 rounded-2xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/50 space-y-2">
              <p className="text-sm font-bold text-amber-900 dark:text-amber-200">
                Verification Under Review
              </p>
              <p className="text-xs text-amber-800 dark:text-amber-300">
                Submitted {myVerification.documentType.toUpperCase()} ending in ••••{' '}
                {myVerification.documentLast4} for {myVerification.fullName}.
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmitVerification} className="space-y-4">
              {myVerification?.status === 'rejected' && (
                <div className="p-4 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/50 text-xs text-rose-700 dark:text-rose-300">
                  Previous verification was declined
                  {myVerification.reviewerNote ? `: ${myVerification.reviewerNote}` : '.'} Please
                  resubmit clearer photos below.
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                    Legal Full Name
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={VALIDATION_CONSTRAINTS.FULL_NAME_MAX}
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                    Document Type
                  </label>
                  <select
                    value={docType}
                    onChange={(e) => setDocType(e.target.value as DocumentType)}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm"
                  >
                    <option value="nid">National ID (NID)</option>
                    <option value="passport">Passport</option>
                    <option value="driving_license">Driving License</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                  Document Number (hashed for privacy)
                </label>
                <input
                  type="text"
                  required
                  value={docNumber}
                  onChange={(e) => setDocNumber(e.target.value)}
                  placeholder="Enter ID or Passport number"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm font-mono"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="border border-dashed border-slate-300 dark:border-slate-700 rounded-2xl p-4 text-center space-y-2">
                  {idFrontUrl ? (
                    <img
                      src={sanitizeMediaUrl(idFrontUrl)}
                      alt="ID front preview"
                      referrerPolicy="no-referrer"
                      className="h-28 w-full object-cover rounded-xl"
                    />
                  ) : (
                    <FileCheck className="w-7 h-7 text-slate-400 mx-auto" />
                  )}
                  <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-xs font-semibold cursor-pointer">
                    <Upload className="w-3.5 h-3.5" />
                    {uploadingDoc ? 'Uploading...' : 'Upload ID Front'}
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => handleUploadImage(e, 'front')}
                      className="sr-only"
                    />
                  </label>
                </div>

                <div className="border border-dashed border-slate-300 dark:border-slate-700 rounded-2xl p-4 text-center space-y-2">
                  {selfieUrl ? (
                    <img
                      src={sanitizeMediaUrl(selfieUrl)}
                      alt="Selfie preview"
                      referrerPolicy="no-referrer"
                      className="h-28 w-full object-cover rounded-xl"
                    />
                  ) : (
                    <Camera className="w-7 h-7 text-slate-400 mx-auto" />
                  )}
                  <div className="flex items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={openSelfieCamera}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400 text-xs font-semibold"
                    >
                      <Camera className="w-3.5 h-3.5" />
                      Take Selfie
                    </button>
                    <label className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-xs font-semibold cursor-pointer">
                      Upload
                      <input
                        type="file"
                        accept="image/*"
                        onChange={(e) => handleUploadImage(e, 'selfie')}
                        className="sr-only"
                      />
                    </label>
                  </div>
                </div>
              </div>

              {cameraOpen && (
                <div className="space-y-2 p-3 rounded-2xl bg-slate-950 text-center">
                  <video ref={videoRef} autoPlay playsInline className="w-full max-h-56 rounded-xl -scale-x-100 object-cover" />
                  <button
                    type="button"
                    onClick={captureSelfie}
                    className="px-4 py-2 rounded-xl bg-sky-600 text-white text-xs font-semibold"
                  >
                    Capture Live Selfie
                  </button>
                </div>
              )}

              {verifyMsg && (
                <p className="text-xs text-sky-600 dark:text-sky-400">{verifyMsg}</p>
              )}

              <button
                type="submit"
                disabled={submittingVerify || uploadingDoc}
                className="w-full py-3 rounded-xl bg-sky-600 hover:bg-sky-700 disabled:opacity-50 text-white text-sm font-semibold transition-colors"
              >
                {submittingVerify ? 'Submitting Verification...' : 'Submit for ID Verification'}
              </button>
            </form>
          )}
        </section>

        {/* Right: Chat Lock PIN & Account Security */}
        <section className="lg:col-span-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-5 h-fit">
          <div className="flex items-center gap-3 pb-4 border-b border-slate-100 dark:border-slate-800">
            <div className="w-10 h-10 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 flex items-center justify-center">
              <Shield className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-display font-bold text-slate-900 dark:text-white">
                Platform Security
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Chat Lock PIN & Privacy Controls
              </p>
            </div>
          </div>

          <form onSubmit={handleSaveSecurity} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                {privateInfo?.chatLockPinHash ? 'Update Chat Lock PIN' : 'Set Chat Lock PIN (4–6 digits)'}
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  value={newPin}
                  onChange={(e) => setNewPin(e.target.value)}
                  placeholder={privateInfo?.chatLockPinHash ? '•••• (PIN configured)' : 'Enter 4-6 digits'}
                  className="w-full pl-9 pr-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm font-mono"
                />
              </div>
            </div>

            <label className="flex items-center justify-between p-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 cursor-pointer">
              <div>
                <p className="text-xs font-semibold text-slate-900 dark:text-white">
                  Two-Step Chat Protection
                </p>
                <p className="text-[11px] text-slate-500">
                  Require PIN confirmation for locked threads
                </p>
              </div>
              <input
                type="checkbox"
                checked={twoFactor}
                onChange={(e) => setTwoFactor(e.target.checked)}
                className="rounded text-sky-600 focus:ring-sky-500"
              />
            </label>

            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                Default Post Privacy
              </label>
              <select
                value={privacyDefault}
                onChange={(e) => setPrivacyDefault(e.target.value as PrivacyLevel)}
                className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-sm"
              >
                <option value="public">Public</option>
                <option value="friends">Friends Only</option>
                <option value="only_me">Only Me</option>
              </select>
            </div>

            {currentUser.publicKeyJwk && (
              <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-1">
                <p className="text-[11px] font-semibold text-slate-500 inline-flex items-center gap-1">
                  <KeyRound className="w-3.5 h-3.5" />
                  ECDH P-256 Identity Key Active
                </p>
                <p className="text-[11px] font-mono text-slate-600 dark:text-slate-400 truncate">
                  {currentUser.publicKeyJwk}
                </p>
              </div>
            )}

            {secMsg && <p className="text-xs text-emerald-600 dark:text-emerald-400">{secMsg}</p>}

            <button
              type="submit"
              disabled={savingSec}
              className="w-full py-2.5 rounded-xl bg-slate-900 dark:bg-sky-600 hover:opacity-90 text-white text-sm font-semibold transition-opacity"
            >
              {savingSec ? 'Saving...' : 'Save Security Preferences'}
            </button>
          </form>
        </section>
      </div>

      {/* Device Permissions & Free-Tier Server Architecture */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400 flex items-center justify-center">
              <Server className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-display font-bold text-slate-900 dark:text-white">
                Device Permissions & Free-Tier Server Guardrails
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Grant media permissions for HD calling and inspect Cloudflare R2, WebRTC, AI, and Firestore free-tier budgets.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={async () => {
                const summary = await requestAllPermissions();
                setPermissions(summary);
                setPermMsg(
                  summary.camera === 'granted' && summary.microphone === 'granted'
                    ? 'Camera, microphone, and call alerts configured.'
                    : 'Permission check complete. Allow blocked permissions in browser settings if needed.'
                );
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-sky-600 hover:bg-sky-700 text-xs font-semibold text-white transition-colors"
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              Enable All Permissions
            </button>
            <button
              type="button"
              disabled={loadingServerInfo}
              onClick={() => void refreshPermissionsAndServer()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-xs font-semibold text-slate-700 dark:text-slate-200"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loadingServerInfo ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>

        {/* Interactive Permissions Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <Camera className="w-4 h-4 text-sky-600 dark:text-sky-400 shrink-0" />
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-900 dark:text-white">Camera</p>
                <p className="text-[11px] text-slate-500 capitalize">{permissions.camera}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={async () => {
                const state = await requestMediaPermission('camera');
                setPermissions((p) => ({ ...p, camera: state }));
                setPermMsg(
                  state === 'granted'
                    ? 'Camera permission granted for video calls & live reels.'
                    : 'Camera access was blocked in browser settings.'
                );
              }}
              className="px-2.5 py-1.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-[11px] font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 shrink-0"
            >
              {permissions.camera === 'granted' ? 'Active' : 'Enable'}
            </button>
          </div>

          <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <Mic className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-900 dark:text-white">Microphone</p>
                <p className="text-[11px] text-slate-500 capitalize">{permissions.microphone}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={async () => {
                const state = await requestMediaPermission('microphone');
                setPermissions((p) => ({ ...p, microphone: state }));
                setPermMsg(
                  state === 'granted'
                    ? 'Microphone permission granted for voice notes & audio/video calls.'
                    : 'Microphone access was blocked in browser settings.'
                );
              }}
              className="px-2.5 py-1.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-[11px] font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 shrink-0"
            >
              {permissions.microphone === 'granted' ? 'Active' : 'Enable'}
            </button>
          </div>

          <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <Bell className="w-4 h-4 text-amber-500 shrink-0" />
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-900 dark:text-white">Call Alerts</p>
                <p className="text-[11px] text-slate-500 capitalize">{permissions.notifications}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={async () => {
                const state = await requestNotificationPermission();
                setPermissions((p) => ({ ...p, notifications: state }));
                setPermMsg(
                  state === 'granted'
                    ? 'Call & message notifications enabled.'
                    : 'Notifications were not enabled.'
                );
              }}
              className="px-2.5 py-1.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-[11px] font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 shrink-0"
            >
              {permissions.notifications === 'granted' ? 'Active' : 'Enable'}
            </button>
          </div>
        </div>

        {permMsg && <p className="text-xs text-sky-600 dark:text-sky-400">{permMsg}</p>}

        {/* Free-Tier Server & Storage Budgets */}
        {serverInfo && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 pt-2">
            <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-1.5">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-900 dark:text-white">
                <HardDrive className="w-4 h-4 text-sky-600 dark:text-sky-400" />
                Cloudflare R2 Storage
              </div>
              <p className="text-[11px] font-mono text-slate-500 truncate">
                {serverInfo.r2.bucket} · {serverInfo.r2.accountId.slice(0, 10)}…
              </p>
              <p className="text-[11px] text-slate-600 dark:text-slate-300">
                Mode: {serverInfo.r2.tokensConfigured ? 'R2 + Local Cache' : 'Local Cache Fallback'}
              </p>
              <p className="text-[11px] font-mono text-slate-500">
                {(serverInfo.r2.usage.estimatedStorageBytes / (1024 * 1024)).toFixed(1)} MB /{' '}
                {(serverInfo.r2.usage.maxStorageBytes / (1024 * 1024 * 1024)).toFixed(1)} GB cap ·{' '}
                {serverInfo.r2.usage.monthlyClassAOps} Class A
              </p>
            </div>

            <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-1.5">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-900 dark:text-white">
                <Wifi className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                WebRTC Calling & TURN
              </div>
              <p className="text-[11px] text-slate-600 dark:text-slate-300">
                {serverInfo.webrtc.stunServersCount} STUN servers active
              </p>
              <p className="text-[11px] text-slate-500">
                TURN:{' '}
                {serverInfo.webrtc.turnProvider === 'cloudflare-calls'
                  ? 'Cloudflare TURN (1 TB free)'
                  : serverInfo.webrtc.turnConfigured
                    ? 'Static TURN Relay'
                    : 'STUN P2P Mode'}
              </p>
              <p className="text-[11px] font-mono text-slate-500">
                Video cap: {serverInfo.webrtc.maxVideoBitrateKbps ?? 900} kbps HD
              </p>
            </div>

            <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-1.5">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-900 dark:text-white">
                <Radio className="w-4 h-4 text-sky-600 dark:text-sky-400" />
                Real-Time Signaling
              </div>
              <p className="text-[11px] text-slate-600 dark:text-slate-300">
                {serverInfo.realtime.httpsFallbackActive
                  ? 'WebSocket + HTTPS Fallback'
                  : 'WebSocket Primary'}
              </p>
              <p className="text-[11px] text-slate-500">
                {serverInfo.realtime.activeUsers} active users · {serverInfo.realtime.activeSockets}{' '}
                sockets
              </p>
              <p className="text-[11px] font-mono text-slate-500">
                Max {serverInfo.realtime.maxSocketsPerUser} tabs/user ·{' '}
                {serverInfo.realtime.heartbeatSeconds}s ping
              </p>
            </div>

            <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-1.5">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-900 dark:text-white">
                <ShieldCheck className="w-4 h-4 text-sky-600 dark:text-sky-400" />
                Gemini Free Guardrail
              </div>
              <p className="text-[11px] font-mono text-slate-500 truncate">
                {serverInfo.ai.model}
              </p>
              <p className="text-[11px] text-slate-600 dark:text-slate-300">
                {serverInfo.ai.configured ? 'Server Key Active' : 'Secret Pending'}
              </p>
              <p className="text-[11px] font-mono text-slate-500">
                {serverInfo.ai.dailyRequestsUsed} / {serverInfo.ai.dailyRequestsCap} today ·{' '}
                {serverInfo.ai.perUserPerMinuteCap}/min
              </p>
            </div>

            <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-1.5">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-900 dark:text-white">
                <Database className="w-4 h-4 text-amber-500" />
                Firestore Spark
              </div>
              <p className="text-[11px] font-mono text-slate-500 truncate">
                {serverInfo.firestore.projectId || 'Configured'}
              </p>
              <p className="text-[11px] text-slate-600 dark:text-slate-300">
                Bounded queries active
              </p>
              <p className="text-[11px] font-mono text-slate-500">
                Reads capped per view
              </p>
            </div>

            <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-1.5">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-900 dark:text-white">
                <Cpu className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                Hosting Runtime
              </div>
              <p className="text-[11px] font-mono text-slate-500 truncate">
                {serverInfo.hosting?.platform || 'Render-Ready Node'}
              </p>
              <p className="text-[11px] text-slate-600 dark:text-slate-300">
                Node {serverInfo.hosting?.nodeVersion || '22+'} ·{' '}
                {serverInfo.hosting?.environment || 'production'}
              </p>
              <p className="text-[11px] font-mono text-slate-500">
                Port {serverInfo.hosting?.port || 3000} · Uptime {serverInfo.hosting?.uptimeSeconds || 0}s
              </p>
            </div>
          </div>
        )}
      </section>

      {/* Admin Verification Review Queue */}
      {isAdminUser && (
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-4">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="w-5 h-5 text-sky-600 dark:text-sky-400" />
            <h2 className="font-display font-bold text-slate-900 dark:text-white">
              Admin Verification Review Queue ({adminQueue.length})
            </h2>
          </div>
          {adminQueue.length === 0 ? (
            <p className="text-xs text-slate-500">No pending ID verification submissions.</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {adminQueue.map((item) => (
                <div
                  key={item.id}
                  className="p-4 rounded-2xl border border-slate-200 dark:border-slate-800 space-y-3"
                >
                  <div>
                    <p className="text-sm font-bold text-slate-900 dark:text-white">
                      {item.fullName}
                    </p>
                    <p className="text-xs font-mono text-slate-500">
                      {item.documentType.toUpperCase()} · •••• {item.documentLast4}
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <img
                      src={sanitizeMediaUrl(item.idFrontUrl)}
                      alt="Submitted ID front"
                      referrerPolicy="no-referrer"
                      className="h-24 w-full object-cover rounded-xl bg-slate-100"
                    />
                    <img
                      src={sanitizeMediaUrl(item.selfieUrl)}
                      alt="Submitted selfie"
                      referrerPolicy="no-referrer"
                      className="h-24 w-full object-cover rounded-xl bg-slate-100"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleAdminDecision(item, 'approved')}
                      className="flex-1 inline-flex items-center justify-center gap-1.5 py-2 rounded-xl bg-emerald-600 text-white text-xs font-semibold"
                    >
                      <CheckCircle2 className="w-4 h-4" />
                      Approve Badge
                    </button>
                    <button
                      type="button"
                      onClick={() => handleAdminDecision(item, 'rejected')}
                      className="flex-1 inline-flex items-center justify-center gap-1.5 py-2 rounded-xl bg-rose-600 text-white text-xs font-semibold"
                    >
                      <XCircle className="w-4 h-4" />
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

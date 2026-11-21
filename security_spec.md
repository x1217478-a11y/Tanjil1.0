# Security Specification (Payload-First TDD)

## 1. Data Invariants
1. **Identity & Privilege Separation**: Users cannot self-assign `isVerified: true` or `verificationStatus: 'verified'` on `users/{userId}` or `status: 'approved'` on `verifications/{id}`. Only verified platform admins (`isAdmin()`) can approve verifications or modify verified flags.
2. **PII Isolation**: Sensitive user info (`email`, `phone`, `chatLockPinHash`) lives strictly in `users/{userId}/private/{docId}` and `verifications/{id}`, readable only by the document owner or admin.
3. **Chat Membership Isolation**: Reading or writing `chats/{chatId}/messages/{messageId}` and `chats/{chatId}/members/{memberId}` requires `request.auth.uid` to be a verified member of the parent `chats/{chatId}` document (`memberIds`).
4. **Reel Duration Enforcement**: Every `ShortReel` in `reels/{reelId}` must satisfy `durationSeconds >= 15 && durationSeconds <= 60` on create and remain immutable on update.
5. **Temporal Integrity**: All `createdAt` and `updatedAt` timestamps must match `request.time`.
6. **Terminal State Locking**: Once an `IdentityVerification` is `'approved'` or `'rejected'`, or a `CallRecord` is `'ended'`, `'declined'`, or `'missed'`, non-admin clients cannot mutate it.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Self-Verification Escalation**: Creating `users/uid1` with `isVerified: true` -> `PERMISSION_DENIED`.
2. **Ghost Field Injection**: Creating `posts/p1` with an extra `shadowAdmin: true` field -> `PERMISSION_DENIED`.
3. **PII Snooping**: User A calling `get` on `users/userB/private/info` -> `PERMISSION_DENIED`.
4. **Unverified Email Spoof**: Request with `email_verified: false` attempting write -> `PERMISSION_DENIED`.
5. **Chat Message Hijack**: Non-member creating a message in `chats/c1/messages/m1` -> `PERMISSION_DENIED`.
6. **ID Poisoning**: Creating document with 500-char ID or invalid characters `../etc` -> `PERMISSION_DENIED`.
7. **Short Reel Violation**: Creating `reels/r1` with `durationSeconds: 8` (< 15s) -> `PERMISSION_DENIED`.
8. **Long Reel Violation**: Creating `reels/r2` with `durationSeconds: 75` (> 60s) -> `PERMISSION_DENIED`.
9. **Author Spoofing**: User A creating `posts/p2` with `authorId: 'userB'` -> `PERMISSION_DENIED`.
10. **Timestamp Backdating**: Creating `posts/p3` with client-chosen `createdAt` != `request.time` -> `PERMISSION_DENIED`.
11. **Terminal Call Mutation**: Modifying a `calls/c1` record after `status == 'ended'` -> `PERMISSION_DENIED`.
12. **Private Post Leak**: Listing `posts` owned by User B where `privacy == 'only_me'` -> `PERMISSION_DENIED`.

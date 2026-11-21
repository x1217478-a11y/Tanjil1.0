/**
 * Security Rule Invariant & Dirty-Dozen Payload Verification Spec
 * Mirrors the exact constraints enforced in firestore.rules & firebase-blueprint.json.
 */
import assert from 'node:assert/strict';

export interface DirtyDozenCase {
  name: string;
  collection: string;
  payload: Record<string, unknown>;
  expectedRejectReason: string;
}

export const dirtyDozenPayloads: DirtyDozenCase[] = [
  {
    name: '1. Self-Verification Escalation',
    collection: 'users',
    payload: { uid: 'u1', username: 'alice', displayName: 'Alice', isVerified: true, verificationStatus: 'verified' },
    expectedRejectReason: 'Non-admin cannot set isVerified=true on create',
  },
  {
    name: '2. Ghost Field Injection',
    collection: 'posts',
    payload: { authorId: 'u1', content: 'hi', shadowAdmin: true },
    expectedRejectReason: 'hasOnly() rejects undeclared fields',
  },
  {
    name: '3. PII Snooping',
    collection: 'users/u2/private',
    payload: { requester: 'u1', targetOwner: 'u2' },
    expectedRejectReason: 'Private subcollection restricted to owner or admin',
  },
  {
    name: '4. Unverified Email Spoof',
    collection: 'users',
    payload: { email: 'tanjilahmedjoy797@gmail.com', email_verified: false },
    expectedRejectReason: 'isSignedIn() requires email_verified == true',
  },
  {
    name: '5. Chat Message Hijack',
    collection: 'chats/c1/messages',
    payload: { chatId: 'c1', senderId: 'outsider', text: 'hijack' },
    expectedRejectReason: 'Master Gate checks parent chats/{chatId}.memberIds',
  },
  {
    name: '6. ID Poisoning',
    collection: 'posts',
    payload: { id: '../etc/passwd' + 'x'.repeat(200) },
    expectedRejectReason: 'isValidId() enforces <=128 alphanumeric/underscore/hyphen',
  },
  {
    name: '7. Short Reel Violation (< 15s)',
    collection: 'reels',
    payload: { authorId: 'u1', videoUrl: '/api/media/1', durationSeconds: 8 },
    expectedRejectReason: 'durationSeconds must be >= 15',
  },
  {
    name: '8. Long Reel Violation (> 60s)',
    collection: 'reels',
    payload: { authorId: 'u1', videoUrl: '/api/media/2', durationSeconds: 75 },
    expectedRejectReason: 'durationSeconds must be <= 60',
  },
  {
    name: '9. Author Spoofing',
    collection: 'posts',
    payload: { authUid: 'u1', authorId: 'u2', content: 'impersonation' },
    expectedRejectReason: 'incoming().authorId == request.auth.uid',
  },
  {
    name: '10. Timestamp Backdating',
    collection: 'posts',
    payload: { authorId: 'u1', createdAt: '2020-01-01T00:00:00Z' },
    expectedRejectReason: 'incoming().createdAt == request.time',
  },
  {
    name: '11. Terminal Call Mutation',
    collection: 'calls',
    payload: { existingStatus: 'ended', newStatus: 'active' },
    expectedRejectReason: '!(existing().status in [ended, declined, missed])',
  },
  {
    name: '12. Private Post Leak',
    collection: 'posts',
    payload: { requester: 'u1', authorId: 'u2', privacy: 'only_me' },
    expectedRejectReason: 'list/get denies only_me unless authorId == request.auth.uid',
  },
];

export function verifyDirtyDozenSpecs(): void {
  assert.equal(dirtyDozenPayloads.length, 12);
  for (const tc of dirtyDozenPayloads) {
    assert.ok(tc.name.length > 0 && tc.expectedRejectReason.length > 0);
  }
}

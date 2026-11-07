import { defineApi, endpoint } from '@panth977/icebase/api';
import { f } from '@panth977/icebase/schema';

const shareInfo = f.map({
  name: f.string(),
  capBytes: f.number(),
  usedBytes: f.number(),
  reservedBytes: f.number(),
  maxFileBytes: f.number(),
  needsPassword: f.boolean(),
  open: f.boolean(),
  /** Set when the owner lets link holders open the folder in Drive. */
  folderUrl: f.optional(f.string()),
});

export const api = defineApi({
  googleSignIn: endpoint({
    tag: 'Account',
    summary: 'Exchange a Google authorization code: signs you in and keeps your Drive connection',
    input: f.map({ code: f.string({ min: 1 }), redirectUri: f.optional(f.string()) }),
    output: f.map({ token: f.string(), role: f.enum(['admin', 'linked']), driveConnected: f.boolean(), scope: f.string() }),
    errors: {
      'invalid-argument': 'The code was rejected by Google',
      'permission-denied': 'This account may not use this DriveShare, or Drive access was not granted',
      'failed-precondition': 'needs-full-drive: a linked account must grant full Drive access (ask again with that scope)',
    },
    auth: 'none',
  }),
  linkedShares: endpoint({
    tag: 'Linked accounts',
    summary: 'The shares your account is linked to (drop files into their Drive folders)',
    input: f.map({}),
    output: f.map({ shares: f.array(f.map({ name: f.string(), folderUrl: f.string(), ownerEmail: f.string(), capBytes: f.number(), usedBytes: f.number() })) }),
  }),
  createShare: endpoint({
    tag: 'Shares',
    summary: 'Make a capped folder in your Drive and its upload link',
    input: f.map({
      name: f.string({ min: 1, max: 120 }),
      capBytes: f.number({ int: true, min: 1 }),
      maxFileBytes: f.optional(f.number({ int: true, min: 0 })),
      password: f.optional(f.string({ max: 200 })),
    }),
    output: f.map({ shareId: f.string(), folderId: f.string() }),
    errors: { 'failed-precondition': 'Drive is not connected' },
  }),
  updateShare: endpoint({
    tag: 'Shares',
    summary: 'Change a share: name, cap, link, password, Drive view, linked accounts',
    input: f.map({
      shareId: f.string(),
      name: f.optional(f.string({ min: 1, max: 120 })),
      capBytes: f.optional(f.number({ int: true, min: 1 })),
      maxFileBytes: f.optional(f.number({ int: true, min: 0 })),
      enabled: f.optional(f.boolean()),
      uploadLink: f.optional(f.boolean()),
      /** '' removes the password. */
      password: f.optional(f.string({ max: 200 })),
      rotateSecret: f.optional(f.boolean()),
      publicView: f.optional(f.boolean()),
      linkedEmails: f.optional(f.array(f.string({ max: 254 }), { max: 50 })),
    }),
    output: f.map({ ok: f.boolean(), warnings: f.array(f.string()) }),
    errors: { 'not-found': 'No such share', 'failed-precondition': 'Linked accounts need full Drive access for the owner' },
  }),
  deleteShare: endpoint({
    tag: 'Shares',
    summary: 'Forget a share; optionally move its Drive folder to the bin',
    input: f.map({ shareId: f.string(), trashFolder: f.boolean() }),
    output: f.map({ ok: f.boolean() }),
    errors: { 'not-found': 'No such share' },
  }),
  syncShare: endpoint({
    tag: 'Shares',
    summary: 'Count what is really in the folder now (and drop stale upload reservations)',
    input: f.map({ shareId: f.string() }),
    output: f.map({ usedBytes: f.number(), fileCount: f.number(), reservedBytes: f.number() }),
    errors: { 'not-found': 'No such share' },
  }),
  sweepNow: endpoint({
    tag: 'Linked accounts',
    summary: 'Move files that linked accounts dropped into a share to your Drive, now',
    input: f.map({ shareId: f.string() }),
    output: f.map({ moved: f.number(), overCap: f.number(), failed: f.number(), left: f.number(), errors: f.array(f.string()) }),
    errors: { 'not-found': 'No such share' },
  }),
  shareInfo: endpoint({
    tag: 'Upload link',
    summary: 'What an upload link points at: name, cap, room left',
    input: f.map({ shareId: f.string(), secret: f.string() }),
    output: shareInfo,
    errors: { 'not-found': 'The link is wrong or was turned off' },
    auth: 'none',
  }),
  startUpload: endpoint({
    tag: 'Upload link',
    summary: 'Hold room under the cap and open a Drive upload the browser sends the bytes to',
    input: f.map({
      shareId: f.string(),
      secret: f.string(),
      password: f.optional(f.string({ max: 200 })),
      name: f.string({ min: 1, max: 500 }),
      size: f.number({ int: true, min: 0 }),
      mime: f.optional(f.string({ max: 200 })),
      by: f.optional(f.string({ max: 80 })),
    }),
    output: f.map({ uploadId: f.string(), url: f.string() }),
    errors: {
      'not-found': 'The link is wrong or was turned off',
      unauthenticated: 'Wrong password',
      'resource-exhausted': 'Not enough room left under the cap',
      'out-of-range': 'The file is larger than this link allows',
    },
    auth: 'none',
  }),
  finishUpload: endpoint({
    tag: 'Upload link',
    summary: 'Count a finished upload against the cap',
    input: f.map({ shareId: f.string(), secret: f.string(), uploadId: f.string(), fileId: f.optional(f.string()) }),
    output: f.map({ ok: f.boolean(), usedBytes: f.number() }),
    errors: { 'not-found': 'Unknown upload', 'failed-precondition': 'The upload has not reached Drive' },
    auth: 'none',
  }),
});

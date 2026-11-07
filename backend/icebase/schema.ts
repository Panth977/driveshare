import { collection, defineSchema, f, index } from '@panth977/icebase/schema';

/** One doc per Google account that signed in: the owner (admin) or a linked account. */
export const users = collection('users', {
  fields: {
    email: f.string(),
    name: f.string(),
    photo: f.optional(f.string()),
    role: f.enum(['admin', 'linked']),
    /** Drive access we hold for this account: 'file' (drive.file) or 'full' (drive). */
    driveScope: f.optional(f.enum(['file', 'full'])),
    createdAt: f.timestamp(),
    lastLogin: f.timestamp(),
  },
  indexes: [index('email')],
});

/** The Drive connection: an encrypted refresh token. Only functions read or write it. */
export const drive = collection('users/{uid}/private', {
  fields: { refreshToken: f.string(), scope: f.string(), updatedAt: f.timestamp() },
  indexes: [],
});

/**
 * A shared folder in the owner's Drive with a size cap. Written only by functions;
 * the owner reads it (rules). `secret` is the upload link's key.
 */
export const shares = collection('shares', {
  fields: {
    ownerUid: f.string(),
    ownerEmail: f.string(),
    name: f.string({ max: 120 }),
    folderId: f.string(),
    /** The cap for everything in the folder, bytes. */
    capBytes: f.number({ int: true, min: 0 }),
    /** Largest single file, bytes (0 = no limit beyond the cap). */
    maxFileBytes: f.number({ int: true, min: 0 }),
    /** Bytes counted against the cap (finished uploads + files moved over + what sync found). */
    usedBytes: f.number({ int: true }),
    /** Bytes held by uploads in progress. */
    reservedBytes: f.number({ int: true }),
    fileCount: f.number({ int: true }),
    enabled: f.boolean(),
    /** Upload link on (anyone with the link may upload). */
    uploadLink: f.boolean(),
    secret: f.string(),
    /** scrypt hash of the optional link password: salt.hash (base64url). */
    passwordHash: f.optional(f.string()),
    /** Anyone with the link may also open the folder in Drive (read-only). */
    publicView: f.boolean(),
    /** Google accounts that drop files straight into the Drive folder; the sweep moves them to the owner. */
    linkedEmails: f.array(f.string(), { max: 50 }),
    /** Some linked email is set (so the scheduled sweep can find the shares it has work for). */
    linked: f.boolean(),
    createdAt: f.timestamp(),
    updatedAt: f.timestamp(),
    lastSync: f.optional(f.timestamp()),
    lastSweep: f.optional(f.timestamp()),
    lastError: f.optional(f.string()),
  },
  indexes: [index('ownerUid'), index('linkedEmails'), index('linked')],
});

/** One file sent through the upload link. */
export const uploads = collection('shares/{shareId}/uploads', {
  fields: {
    name: f.string(),
    size: f.number({ int: true, min: 0 }),
    mime: f.string(),
    /** Who sent it, as they typed it (optional). */
    by: f.optional(f.string({ max: 80 })),
    state: f.enum(['started', 'done', 'expired']),
    fileId: f.optional(f.string()),
    createdAt: f.timestamp(),
    /** The reservation lapses at this time if the upload never finishes. */
    expiresAt: f.timestamp(),
    finishedAt: f.optional(f.timestamp()),
  },
  indexes: [index('state', 'expiresAt'), index('createdAt')],
});

/** A file a linked account dropped into the folder, and what the sweep did with it. */
export const transfers = collection('shares/{shareId}/transfers', {
  fields: {
    name: f.string(),
    size: f.number({ int: true, min: 0 }),
    from: f.string(),
    state: f.enum(['moved', 'over-cap', 'failed']),
    error: f.optional(f.string()),
    at: f.timestamp(),
  },
  indexes: [index('at')],
});

export const schema = defineSchema({ users, drive, shares, uploads, transfers });

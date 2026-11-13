# DriveShare — notes for agents

Built on TaskManager ticket **ORCH-45** (ORCH board); decisions live there.

- Hosted deployment: Firebase `driveshare-p977` (asia-south1), https://driveshare-p977.web.app. Admin = `ADMIN_EMAILS` in `backend/functions/.env` (not committed; Panth's Google account only).
- The hosted site is private: the owner (ADMIN_EMAILS) and linked accounts (role claim `linked`) use the app on their own Drive; only the owner makes shares. The code is open source and deployable by anyone: keep every deployment-specific value in `backend/deployment.ts` or the functions `.env`/secrets.
- IceBase in Firebase mode; keep it on the latest IceBase release (`@panth977/icebase*`, all three the same version).
- Bytes never go through functions. Uploads: backend opens a Drive resumable session (owner token, `Origin` = caller's origin) and the browser PUTs chunks to it. Do not add a proxy upload path.
- Linked accounts: Google allows only the current owner to offer ownership (`pendingOwner`), the new owner accepts (`role: owner`, `transferOwnership=true`). See `backend/functions/src/sweep.ts`; tests in `test/sweep.test.ts` run against `test/fake-drive.ts`, which enforces those rules.
- Scopes: owner `drive.file` by default, `drive` only once they add linked accounts (incremental consent); linked accounts `drive`.
- Every Firestore write is a function; rules only allow reads of your own docs.
- Before pushing: `npm run check && npm test`. Deploy: `npm run deploy` (or `deploy:rules|functions|web`).

# DriveShare

Share capped folders of **your** Google Drive. People upload into your storage, not theirs.

You have a big Drive plan (say 5 TB) and someone else has the free 15 GB. With DriveShare you make a
folder in your Drive, give it a cap ("this folder may hold 200 GB"), and send a link. Whatever is sent
through the link lands in your Drive and counts against your storage only.

Two ways in:

| | Upload link | Linked accounts |
|---|---|---|
| Who | anyone with the link (optional password) | Google accounts you name |
| How | a web page: drop files, they stream from the browser straight to Google | they drop files into the shared folder from Google Drive itself (web, phone, desktop) |
| Whose storage | yours from the first byte | theirs for a few minutes, then yours: a scheduled job hands each file over to you |
| Needs | nothing | they sign in once at `/link` and allow Drive access |

The cap counts everything in the folder. Uploads that would go over it are refused; files from linked
accounts that would go over it stay with their sender.

## Why it works the way it does

Google Drive counts a file against its **owner's** storage. A file someone uploads into a folder you
shared with them is still theirs. Google lets only the current owner offer a file to someone else
(`pendingOwner`), and the new owner has to accept. So:

- **Upload link**: the backend opens a [resumable upload](https://developers.google.com/drive/api/guides/manage-uploads#resumable)
  in your Drive with your token, and gives the browser only the session URL. The browser sends the bytes
  straight to Google; they never touch our servers. You own the file from the start.
- **Linked accounts**: with the linked account's token, the sweep offers each new file in the folder to
  you; with yours, it accepts. Runs every 15 minutes (or "Move now").

## Cost

Bytes never pass through Cloud Functions. An upload is two small function calls (start, finish); the
sweep is one call per tick and reads nothing when no share has linked accounts. 100 people uploading
stays inside the Firebase free tier for functions; you pay for nothing but your Drive plan.

## Stack

- [IceBase](https://jsr.io/@panth977/icebase) in Firebase mode: schema, typed callables, rules, deploy.
- Firestore keeps shares, upload reservations and encrypted Google refresh tokens. Files live only in Drive.
- Web: Svelte 5 + Vite. Licence: Apache-2.0.

```
backend/
  deployment.ts          ← the one file that names YOUR deployment (project, OAuth client)
  shared.ts              constants + pure helpers (web and functions)
  icebase/schema.ts      collections: users, shares, uploads, transfers
  icebase/api.ts         the callable API
  icebase/rules/         Firestore rules (clients read only; every write is a function)
  functions/src/         index.ts (functions), drive.ts (Drive REST), sweep.ts (hand-over)
web/src/
  routes/Admin.svelte    owner dashboard   (/)
  routes/Upload.svelte   upload page       (/s/<share>#<key>)
  routes/Link.svelte     linked accounts   (/link)
test/                    vitest: sweep against an in-memory Drive, helpers
```

## Deploy your own

You need a Google account, Node 22, and a Firebase project on the Blaze plan (functions need it; the
usage here stays in the free tier).

1. **Firebase project.** Create one, add a Web app, and turn on Firestore (Native mode).
   Enable the **Google Drive API** in the Cloud console for the same project.
2. **OAuth client.** Cloud console › Google Auth Platform:
   - Branding: app name, support email.
   - Audience: External. Add yourself as a test user, or publish the app (see below).
   - Data access: add the scopes `openid`, `email`, `profile`, `.../auth/drive.file` and, if you will use
     linked accounts, `.../auth/drive`.
   - Clients › New client › Web application. Authorised JavaScript origins: `https://<project>.web.app`,
     `https://<project>.firebaseapp.com`, `http://localhost:5191`. Redirect URIs: the same three with
     `/auth/callback`.
3. **Fill in `backend/deployment.ts`**: project id, region, the Web app config, the client id.
4. **Who may sign in.** `cp backend/functions/.env.example backend/functions/.env` and set `ADMIN_EMAILS`
   to your Google address. Nobody else can use the admin site.
5. **Secrets.**
   ```sh
   npm install
   npx firebase login
   GOOGLE_CLIENT_SECRET='<client secret>' npm run setup
   ```
   This stores `GOOGLE_CLIENT_SECRET` and a random `TOKEN_KEY` (encrypts refresh tokens) in Secret Manager.
6. **Custom tokens.** Firebase Auth must be on (Console › Authentication › Get started) and the functions'
   service account must be able to sign tokens:
   ```sh
   SA=<project-number>-compute@developer.gserviceaccount.com
   gcloud iam service-accounts add-iam-policy-binding $SA --member=serviceAccount:$SA --role=roles/iam.serviceAccountTokenCreator
   ```
7. **Deploy.** `npm run deploy` (rules + indexes, functions, web). Open `https://<project>.web.app`.

**Testing vs production.** While the OAuth app is in *Testing*, Google expires refresh tokens after
7 days: links stop working until you sign in again. Publish the app (Audience › Publish) to avoid that.
Unverified apps show a warning screen and are limited to 100 users, which is fine for a personal
deployment. `drive` (full) is a restricted scope; you only need it for linked accounts.

## Develop

```sh
npm install
npm run dev        # web on http://localhost:5191 against your deployed functions
npm test           # vitest
npm run check      # TypeScript + svelte-check
```

# AEOD Universal Client Onboarding — Production Deployment

This package implements Phases 0–3 of the Directed Build Sequence (Section 12):
Frontend Foundation, Supabase Core, Secure Upload, and Finalization. Phase 4
(internal review UI) and Phase 5 (config-driven module growth) are scaffolded
in the schema (`discovery_modules`, `submission_modules`, `internal_reviews`)
but not built as a UI yet — see "What's next" below.

## What's in this package

```
AEOD_Universal_Client_Onboarding_v2_0.html   ← the frontend (deploy as-is to Netlify)
netlify.toml                                  ← Netlify build/functions config
package.json                                  ← function dependency (@supabase/supabase-js)
.env.example                                  ← required environment variables
supabase/schema.sql                           ← full Postgres schema + RLS + storage bucket
netlify/functions/
  _supabase.js                ← shared server-side Supabase admin client (service role)
  onboarding-init.js          ← validates payload, creates client/submission, issues signed upload URLs
  onboarding-file-complete.js ← verifies each uploaded file actually landed in Storage
  onboarding-finalize.js      ← verifies all files, marks submitted, sends internal notification
  onboarding-save-draft.js    ← optional server-side draft (Phase "later" item from Section 3)
```

## 1. Create/confirm the Supabase project

1. In Supabase, open **SQL Editor** and run the entire contents of `supabase/schema.sql`.
   This creates all 11 tables from Section 5, enables RLS with a default-deny policy
   for `anon`/`authenticated` (all writes happen server-side via the service role,
   which bypasses RLS), and creates the private `aeod-onboarding-documents` bucket.
2. Grab three values from Supabase → Project Settings → API:
   - Project URL
   - `anon` public key
   - `service_role` key (**secret** — never put this in the HTML or a repo)

## 2. Deploy to the company Netlify account (ceo@aeodai.com)

1. Get the Netlify credential from the CEO through a secure channel per the
   directive — do not use email, chat, or source control.
2. Create/select the site in that Netlify account, connect this folder (as a
   repo or via drag-and-drop deploy), and confirm `netlify.toml` is at the
   project root so Netlify picks up `netlify/functions` automatically.
3. In **Site configuration → Environment variables**, set (see `.env.example`):
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SUPABASE_ONBOARDING_BUCKET` = `aeod-onboarding-documents`
   - `AEOD_NOTIFICATION_EMAIL`
   - `AEOD_NOTIFICATION_FROM`
   - `AEOD_INTERNAL_REVIEW_BASE_URL` (optional, for the notification link)
   - `RESEND_API_KEY` (optional — omit to skip email notifications entirely;
     finalize still works, it just won't email anyone)

## 3. Point the frontend at your Supabase project

Open `AEOD_Universal_Client_Onboarding_v2_0.html`, find the `AEOD_CONFIG` block
near the top of the `<script>`, and replace the two placeholder values:

```js
supabaseUrl: 'https://YOUR-PROJECT-REF.supabase.co',
supabaseAnonKey: 'YOUR-SUPABASE-ANON-PUBLIC-KEY',
```

These are safe to expose in the browser — the anon key alone cannot read or
write anything (RLS denies it); it's only used to hand the signed upload
token to Supabase Storage's REST endpoint. Do **not** put the service role
key here.

The `initEndpoint` / `fileCompleteEndpoint` / `finalizeEndpoint` /
`saveDraftEndpoint` paths are already same-origin (`/.netlify/functions/...`)
and need no changes once deployed on Netlify.

## 4. Deploy and test on a preview first

Push to a branch/PR to get a Netlify deploy preview, then run through the
**Production Acceptance Tests** in Section 11 of the directive — in
particular:

- Submit with no files → confirmation only appears after `onboarding-finalize`
  returns `{ok:true}`.
- Submit with 2–3 mixed file types → each shows Queued → Uploading… →
  Uploaded ✓ in the file list; check Supabase Storage to confirm the objects
  exist under `submissions/{submissionId}/...` in the private bucket.
- Kill your network mid-upload → the file shows "Failed — will retry", the
  draft stays saved locally, and no false "Intake Submitted" message appears.
- Confirm in Supabase Table Editor that `onboarding_events` has a full
  `started → file-verified (×N) → submitted` trail for a successful run.
- Confirm `select * from onboarding_files` are `verified`, not just `pending`.
- Try to query any table as the `anon` key from a REST client — it should be
  denied (RLS default-deny).

Only promote to production once these pass.

## What's next (Phases 4–5, not built in this package)

- **Phase 4 — Internal review UI**: a small authenticated app (could be a
  second Netlify site, or a protected route) that lists `onboarding_submissions`
  joined to `clients`/`client_contacts`/`onboarding_files`, lets staff update
  `internal_reviews`, and issues short-lived signed *download* URLs (mirror of
  `createSignedUploadUrl`, but `createSignedUrl` for reads) for the private
  files. Needs its own Supabase Auth-gated RLS policies — deliberately not
  added in this pass so client-side default-deny stays airtight until that
  auth layer exists.
- **Phase 5 — Config-driven modules**: `discovery_modules.config_json` is
  already seeded with the 12 sector keys; the next step is generating the
  `.discovery-module` panels and fields from that table (via a small build
  step or a fetch at load time) instead of the hard-coded HTML blocks, so a
  new sector/question doesn't require redeploying the app.
- Malware scanning / quarantine workflow for `onboarding_files.scan_status`
  (Section 7) — plug in whatever AV/scanning service AEOD selects; the column
  and event trail are already in place to record the result.

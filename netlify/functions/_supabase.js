// Shared server-side Supabase client for Netlify Functions.
// Uses the SERVICE ROLE key — this file must NEVER be imported into
// client/browser code. It only runs inside Netlify Functions (server side).
const { createClient } = require('@supabase/supabase-js');

const BUCKET = process.env.SUPABASE_ONBOARDING_BUCKET || 'aeod-onboarding-documents';

function getAdminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Supabase server credentials are not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).');
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

function sanitizeFileName(name) {
  return String(name || 'file')
    .normalize('NFKD')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(0, 140);
}

const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'image/jpeg',
  'image/png',
  'image/webp'
]);

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25MB per file — adjust as needed
const MAX_FILES_PER_SUBMISSION = 20;

module.exports = {
  getAdminClient,
  jsonResponse,
  sanitizeFileName,
  ALLOWED_MIME,
  MAX_FILE_BYTES,
  MAX_FILES_PER_SUBMISSION,
  BUCKET
};

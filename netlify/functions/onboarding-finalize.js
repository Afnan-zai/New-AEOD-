// POST /.netlify/functions/onboarding-finalize
// Body: { submissionId }
// Returns: { ok:true, submissionId, status:"submitted" }  -- ONLY after real verification.
// The frontend must not show "Intake Submitted" language until this call succeeds.
const { getAdminClient, jsonResponse } = require('./_supabase');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { ok: false, message: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return jsonResponse(400, { ok: false, message: 'Invalid JSON' }); }

  const { submissionId } = body;
  if (!submissionId) return jsonResponse(400, { ok: false, message: 'submissionId is required' });

  const supabase = getAdminClient();

  try {
    // 1. Fetch the submission (no joins — avoids PostgREST relationship resolution issues)
    const { data: submission, error: subErr } = await supabase
      .from('onboarding_submissions')
      .select('*')
      .eq('id', submissionId)
      .single();
    if (subErr || !submission) {
      console.error('finalize: submission fetch failed', subErr);
      return jsonResponse(404, { ok: false, message: 'Submission not found' });
    }

    // 2. Fetch the related client and its contacts separately
    let clientRow = null;
    let contacts = [];
    if (submission.client_id) {
      const { data: c } = await supabase
        .from('clients')
        .select('*')
        .eq('id', submission.client_id)
        .maybeSingle();
      clientRow = c || null;

      const { data: cc } = await supabase
        .from('client_contacts')
        .select('*')
        .eq('client_id', submission.client_id);
      contacts = cc || [];
    }

    const submissionWithClient = {
      ...submission,
      clients: clientRow,
      client_contacts: contacts
    };

    // 3. Every file attached to this submission must be verified (not merely "uploaded").
    const { data: files, error: filesErr } = await supabase
      .from('onboarding_files')
      .select('id, upload_status, original_name')
      .eq('submission_id', submissionId);
    if (filesErr) throw filesErr;

    const blocking = (files || []).filter(f => f.upload_status !== 'verified');
    if (blocking.length) {
      return jsonResponse(422, {
        ok: false,
        message: 'Some documents have not finished verifying: ' + blocking.map(f => f.original_name).join(', ')
      });
    }

    // 4. Mark the submission as submitted
    const now = new Date().toISOString();
    const { error: updErr } = await supabase
      .from('onboarding_submissions')
      .update({ status: 'submitted', submitted_at: now })
      .eq('id', submissionId);
    if (updErr) throw updErr;

    // 5. Audit event
    await supabase.from('onboarding_events').insert({
      submission_id: submissionId,
      event_type: 'submitted',
      actor_type: 'system',
      details_json: { fileCount: (files || []).length }
    });

    // 6. Optional internal notification (fires only after verified finalization).
    await maybeSendNotification(submissionWithClient, submissionId, files || []);

    return jsonResponse(200, { ok: true, submissionId, status: 'submitted' });
  } catch (err) {
    console.error('onboarding-finalize error', err);
    return jsonResponse(500, { ok: false, message: 'Could not finalize submission.' });
  }
};

async function maybeSendNotification(submission, submissionId, files) {
  const to = process.env.AEOD_NOTIFICATION_EMAIL;
  const resendKey = process.env.RESEND_API_KEY; // optional — any provider can be swapped in here
  if (!to || !resendKey) return; // notification is optional; finalize still succeeds without it

  const org = submission.clients ? submission.clients.legal_name : 'Unknown organization';
  const contact = Array.isArray(submission.client_contacts) ? submission.client_contacts[0] : submission.client_contacts;
  const reviewLink = (process.env.AEOD_INTERNAL_REVIEW_BASE_URL || '') + '/submissions/' + submissionId;

  const text = [
    `New AEOD onboarding submission verified.`,
    `Submission ID: ${submissionId}`,
    `Organization: ${org}`,
    `Contact: ${contact ? `${contact.name} <${contact.email}>` : 'n/a'}`,
    `Submitted at: ${submission.submitted_at || new Date().toISOString()}`,
    `Files: ${files.length}`,
    reviewLink ? `Review: ${reviewLink}` : ''
  ].filter(Boolean).join('\n');

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.AEOD_NOTIFICATION_FROM || 'onboarding@aeodai.com',
        to,
        subject: `AEOD Onboarding — ${org} — Verified Submission`,
        text
      })
    });
  } catch (e) {
    // Notification failure must never fail the finalize step itself.
    console.error('notification send failed', e);
  }
}

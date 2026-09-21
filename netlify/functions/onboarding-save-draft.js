// POST /.netlify/functions/onboarding-save-draft
// Body: { submissionId (optional — omit to create a new draft), payload, currentStep }
// Returns: { ok:true, submissionId, savedAt }
// This is additive to the browser localStorage draft (kept as the primary
// same-device protection per Section 3) — it does not replace it.
const { getAdminClient, jsonResponse } = require('./_supabase');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { ok: false, message: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return jsonResponse(400, { ok: false, message: 'Invalid JSON' }); }

  const { submissionId, payload, currentStep } = body;
  if (!payload) return jsonResponse(400, { ok: false, message: 'payload is required' });

  const supabase = getAdminClient();
  const now = new Date().toISOString();

  try {
    if (submissionId) {
      const { data, error } = await supabase
        .from('onboarding_submissions')
        .update({ metadata_json: payload, current_step: currentStep || null, last_saved_at: now, status: 'draft' })
        .eq('id', submissionId)
        .select()
        .single();
      if (error) throw error;

      await supabase.from('onboarding_events').insert({
        submission_id: submissionId, event_type: 'draft', actor_type: 'client'
      });
      return jsonResponse(200, { ok: true, submissionId: data.id, savedAt: now });
    }

    const { data, error } = await supabase
      .from('onboarding_submissions')
      .insert({ status: 'draft', current_step: currentStep || 1, last_saved_at: now, metadata_json: payload, source: 'web' })
      .select()
      .single();
    if (error) throw error;

    await supabase.from('onboarding_events').insert({
      submission_id: data.id, event_type: 'draft', actor_type: 'client'
    });
    return jsonResponse(200, { ok: true, submissionId: data.id, savedAt: now });
  } catch (err) {
    console.error('onboarding-save-draft error', err);
    return jsonResponse(500, { ok: false, message: 'Could not save draft.' });
  }
};

// POST /.netlify/functions/onboarding-file-complete
// Body: { submissionId, fileId }
// Verifies the object actually landed in private Storage before trusting the
// browser's "upload finished" signal, then marks the file row verified.
const { getAdminClient, jsonResponse, BUCKET } = require('./_supabase');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { ok: false, message: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return jsonResponse(400, { ok: false, message: 'Invalid JSON' }); }

  const { submissionId, fileId } = body;
  if (!submissionId || !fileId) return jsonResponse(400, { ok: false, message: 'submissionId and fileId are required' });

  const supabase = getAdminClient();

  try {
    const { data: fileRow, error: fetchErr } = await supabase
      .from('onboarding_files')
      .select('*')
      .eq('id', fileId)
      .eq('submission_id', submissionId)
      .single();
    if (fetchErr || !fileRow) return jsonResponse(404, { ok: false, message: 'File record not found' });

    // Verify the object actually exists at storage_path
    const folder = fileRow.storage_path.substring(0, fileRow.storage_path.lastIndexOf('/'));
    const objectName = fileRow.storage_path.substring(fileRow.storage_path.lastIndexOf('/') + 1);
    const { data: listing, error: listErr } = await supabase.storage.from(BUCKET).list(folder, { search: objectName });
    if (listErr) throw listErr;
    const found = (listing || []).some(o => o.name === objectName);

    if (!found) {
      await supabase.from('onboarding_files').update({ upload_status: 'failed' }).eq('id', fileId);
      return jsonResponse(422, { ok: false, message: 'Upload could not be verified in storage. Please retry this file.' });
    }

    const { error: updErr } = await supabase.from('onboarding_files')
      .update({ upload_status: 'verified' })
      .eq('id', fileId);
    if (updErr) throw updErr;

    await supabase.from('onboarding_events').insert({
      submission_id: submissionId,
      event_type: 'file-verified',
      actor_type: 'system',
      details_json: { fileId, originalName: fileRow.original_name }
    });

    return jsonResponse(200, { ok: true, fileId, status: 'verified' });
  } catch (err) {
    console.error('onboarding-file-complete error', err);
    return jsonResponse(500, { ok: false, message: 'Could not verify file upload.' });
  }
};

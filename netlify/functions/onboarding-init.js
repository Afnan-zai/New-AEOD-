// POST /.netlify/functions/onboarding-init
// Body: { payload: <collectData() output from the frontend>, fileManifest: [{name, type, size}] }
// Returns: { ok:true, submissionId, uploads:[{fileId, path, token, signedUrl, originalName}] }
const {
  getAdminClient, jsonResponse, sanitizeFileName,
  ALLOWED_MIME, MAX_FILE_BYTES, MAX_FILES_PER_SUBMISSION, BUCKET
} = require('./_supabase');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { ok: false, message: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return jsonResponse(400, { ok: false, message: 'Invalid JSON' }); }

  const payload = body.payload || {};
  const fileManifest = Array.isArray(body.fileManifest) ? body.fileManifest : [];

  // --- Minimum server-side validation (never trust the browser alone) ---
  const contact = payload.contact || {};
  const organization = payload.organization || {};
  const missing = [];
  if (!contact.name) missing.push('Full Name');
  if (!contact.title) missing.push('Title / Role');
  if (!organization.name) missing.push('Organization Name');
  if (!contact.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) missing.push('Valid Email Address');
  if (!organization.type) missing.push('Organization Type');
  if (!(payload.challenge && payload.challenge.primary)) missing.push('Primary Challenge');
  if (missing.length) return jsonResponse(422, { ok: false, message: 'Missing required fields: ' + missing.join(', ') });

  if (fileManifest.length > MAX_FILES_PER_SUBMISSION) {
    return jsonResponse(422, { ok: false, message: `A maximum of ${MAX_FILES_PER_SUBMISSION} files is allowed per submission.` });
  }
  for (const f of fileManifest) {
    if (f.size && f.size > MAX_FILE_BYTES) {
      return jsonResponse(422, { ok: false, message: `File "${f.name}" exceeds the maximum allowed size.` });
    }
    if (f.type && !ALLOWED_MIME.has(f.type)) {
      return jsonResponse(422, { ok: false, message: `File "${f.name}" has an unsupported file type.` });
    }
  }

  const supabase = getAdminClient();

  try {
    // 1. Client record
    const { data: client, error: clientErr } = await supabase
      .from('clients')
      .insert({
        legal_name: organization.name,
        display_name: organization.name,
        organization_type: organization.type,
        legal_structure: organization.legalStructure || null,
        primary_location: organization.primaryLocation || organization.cityState || null,
        website: organization.website || null,
        status: 'active'
      })
      .select()
      .single();
    if (clientErr) throw clientErr;

    // 2. Contact
    const { error: contactErr } = await supabase.from('client_contacts').insert({
      client_id: client.id,
      name: contact.name,
      title: contact.title,
      email: contact.email,
      phone: contact.phone || null,
      preferred_contact: contact.preferredContact || null,
      role_type: 'primary'
    });
    if (contactErr) throw contactErr;

    // 3. Submission
    const { data: submission, error: subErr } = await supabase
      .from('onboarding_submissions')
      .insert({
        client_id: client.id,
        status: 'in_progress',
        schema_version: payload.schemaVersion || 'AEOD_ONBOARDING_V2',
        current_step: 4,
        last_saved_at: new Date().toISOString(),
        source: 'web',
        metadata_json: payload
      })
      .select()
      .single();
    if (subErr) throw subErr;
    const submissionId = submission.id;

    // 4. Structured responses (flatten sections -> rows, queryable without parsing JSON)
    const responseRows = [];
    const sectionsToFlatten = { challenge: payload.challenge, readiness: payload.readiness, governance: payload.governance, success: payload.success };
    for (const [sectionKey, sectionObj] of Object.entries(sectionsToFlatten)) {
      if (!sectionObj) continue;
      for (const [fieldKey, value] of Object.entries(sectionObj)) {
        if (value === undefined || value === null || value === '') continue;
        responseRows.push({ submission_id: submissionId, section_key: sectionKey, field_key: fieldKey, field_label: fieldKey, value_json: value });
      }
    }
    if (responseRows.length) {
      const { error: respErr } = await supabase.from('onboarding_responses').insert(responseRows);
      if (respErr) throw respErr;
    }

    // 5. Operating schedule (7 rows)
    const days = (payload.operations && payload.operations.days) || [];
    if (days.length) {
      const scheduleRows = days.map(d => ({
        submission_id: submissionId,
        day_of_week: d.day,
        is_open: !!d.open,
        opens_at: d.start || null,
        closes_at: d.end || null,
        timezone: payload.operations.timezone || null,
        notes: payload.operations.scheduleNotes || null
      }));
      const { error: schedErr } = await supabase.from('operating_schedules').insert(scheduleRows);
      if (schedErr) throw schedErr;
    }

    // 6. Digital profiles
    const social = (payload.digital && payload.digital.social) || {};
    const digitalRows = Object.entries(social)
      .filter(([, url]) => !!url)
      .map(([platform, url]) => ({
        submission_id: submissionId,
        platform,
        active: true,
        profile_url: url,
        manager: payload.digital.manager || null
      }));
    if (digitalRows.length) {
      const { error: digErr } = await supabase.from('digital_profiles').insert(digitalRows);
      if (digErr) throw digErr;
    }

    // 7. Conditional discovery module
    const moduleKey = payload.challenge && payload.challenge.discoveryModule;
    if (moduleKey) {
      const { error: modErr } = await supabase.from('submission_modules').insert({
        submission_id: submissionId,
        module_key: moduleKey,
        selected: true,
        responses_json: payload.challenge.discoveryResponses || []
      });
      if (modErr) throw modErr;
    }

    // 8. File rows + signed upload URLs
    const uploads = [];
    for (const f of fileManifest) {
      const safeName = sanitizeFileName(f.name);
      const storagePath = `submissions/${submissionId}/${Date.now()}-${safeName}`;

      const { data: fileRow, error: fileErr } = await supabase.from('onboarding_files').insert({
        submission_id: submissionId,
        storage_path: storagePath,
        original_name: f.name,
        mime_type: f.type || null,
        size_bytes: f.size || null,
        upload_status: 'pending'
      }).select().single();
      if (fileErr) throw fileErr;

      const { data: signed, error: signErr } = await supabase
        .storage.from(BUCKET)
        .createSignedUploadUrl(storagePath);
      if (signErr) throw signErr;

      uploads.push({
        fileId: fileRow.id,
        path: storagePath,
        token: signed.token,
        signedUrl: signed.signedUrl,
        originalName: f.name
      });
    }

    // 9. Audit event
    await supabase.from('onboarding_events').insert({
      submission_id: submissionId,
      event_type: 'started',
      actor_type: 'client',
      details_json: { fileCount: fileManifest.length }
    });

    return jsonResponse(200, { ok: true, submissionId, uploads });
  } catch (err) {
    console.error('onboarding-init error', err);
    return jsonResponse(500, { ok: false, message: 'Could not initialize submission.' });
  }
};

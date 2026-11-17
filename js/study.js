/* Study Hub: Supabase is authoritative; public submissions always await review. */
(function () {
  'use strict';
  const labels = { notes: 'Notes', past_paper: 'Past paper', practice: 'Mazoezi', request: 'Ombi la material' };
  const $ = id => document.getElementById(id);
  const admin = document.body.dataset.studyAdmin === 'true';
  const pageSize = 24;
  let client, offset = 0, revision = 0, loading = false;
  function safeUrl(raw) {
    try { const u = new URL(raw); return u.protocol === 'https:' && !u.username && !u.password ? u.href : ''; }
    catch { return ''; }
  }
  function node(tag, text, className) {
    const el = document.createElement(tag);
    if (text != null) el.textContent = text;
    if (className) el.className = className;
    return el;
  }
  function message(error) {
    if (error.code === '42P01' || error.code === 'PGRST205') return 'Study Hub bado haijawashwa kwenye database. Msimamizi aendeshe migration 019.';
    return 'Imeshindikana kukamilisha ombi. Hakiki mtandao au jaribu tena baadaye.';
  }
  function card(row) {
    const el = node('article', null, 'study-card');
    el.append(node('span', labels[row.kind] || row.kind, 'eyebrow'), node('h2', row.title));
    el.append(node('p', `${row.course} · ${row.subject} · Mwaka ${row.study_year} · Semester ${row.semester}`, 'study-meta'));
    if (row.description) el.append(node('p', row.description));
    el.append(node('p', `Chanzo: ${row.source}`, 'study-meta'));
    const actions = node('div', null, 'study-actions');
    const url = safeUrl(row.resource_url);
    if (url) {
      const link = node('a', admin ? 'Kagua kiungo ↗' : 'Fungua material ↗', 'btn btn--ghost');
      link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer nofollow';
      actions.append(link);
      el.append(node('p', `Kiungo cha nje: ${new URL(url).hostname}`, 'study-meta'));
    } else if (row.kind === 'request' && !admin) {
      const link = node('a', 'Nina material hii', 'btn btn--ghost');
      link.href = '#contribute';
      link.addEventListener('click', () => {
        $('contribute').open = true;
        const f = $('study-submit');
        for (const key of ['course','subject','study_year','semester']) f.elements[key].value = row[key];
        f.elements.title.value = row.title;
        f.elements.kind.value = 'notes'; updateKind();
      }); actions.append(link);
    }
    if (admin) {
      for (const [status, label] of [['approved','Chapisha'],['rejected','Kataa'],['pending','Rudisha ukaguzi']]) {
        if (status === row.status) continue;
        const button = node('button', label, 'btn btn--ghost');
        button.type = 'button';
        button.addEventListener('click', async () => {
          if (status === 'approved' && row.kind !== 'request' && !url) { alert('Kiungo si sahihi. Kataa mchango huu.'); return; }
          button.disabled = true;
          try {
            const res = await client.from('study_resources').update({status}).eq('id', row.id).select('id');
            if (res.error) throw res.error;
            if (!res.data.length) throw new Error('Hakuna ruhusa.');
            await load(true);
          } catch (e) { $('study-status').textContent = message(e); }
          finally { button.disabled = false; }
        }); actions.append(button);
      }
    }
    el.append(actions); return el;
  }
  // Search input is deliberately reduced to words before constructing an OR
  // expression; quotes, commas, wildcard and PostgREST operators cannot enter it.
  const words = s => s.replace(/[^\p{L}\p{N}\s-]/gu, ' ').trim().slice(0, 100);
  async function load(reset) {
    if (!client) return;
    const ticket = ++revision;
    if (reset) { offset = 0; $('study-list').replaceChildren(); }
    loading = true; $('study-more').disabled = true;
    $('study-status').textContent = 'Inapakia…';
    let q = client.from('study_resources').select('*')
      .eq('status', admin ? $('study-state').value : 'approved')
      .order('created_at', {ascending:false}).order('id').range(offset, offset + pageSize - 1);
    const term = words($('study-search').value), course = words($('study-course').value);
    if (term) q = q.or(`title.ilike.%${term}%,subject.ilike.%${term}%`);
    if (course) q = q.ilike('course', `%${course}%`);
    if ($('study-kind').value) q = q.eq('kind', $('study-kind').value);
    if ($('study-year').value) q = q.eq('study_year', Number($('study-year').value));
    if ($('study-semester').value) q = q.eq('semester', Number($('study-semester').value));
    try {
      const {data, error} = await q;
      if (ticket !== revision) return;
      if (error) throw error;
      data.forEach(row => $('study-list').append(card(row)));
      offset += data.length;
      $('study-more').hidden = data.length < pageSize;
      $('study-status').textContent = offset ? `${offset} zimeonyeshwa. Tumia utafutaji kupata somo lako.` : '';
      if (!offset) {
        const empty = node('div', null, 'study-empty study-wide');
        empty.append(node('h2', admin ? 'Hakuna michango katika hali hii.' : 'Hakuna material hapa bado.'),
          node('p', admin ? 'Michango mipya itaonekana hapa kwa ukaguzi.' : 'Jaribu utafutaji mwingine, omba unachohitaji au kuwa wa kwanza kuchangia.'));
        $('study-list').append(empty);
      }
    } catch(e) {
      if (ticket !== revision) return;
      console.error(e); $('study-status').textContent = message(e);
      $('study-more').hidden = false; $('study-more').textContent = 'Jaribu kupakia tena';
    } finally {
      if (ticket === revision) { loading = false; $('study-more').disabled = false; }
    }
  }
  function updateKind() {
    const f = $('study-submit'); if (!f) return;
    const request = f.elements.kind.value === 'request';
    $('study-url-label').hidden = request;
    f.elements.resource_url.required = !request;
    f.elements.resource_url.disabled = request;
  }
  async function init() {
    if (!window.RucusoAPI) { $('study-status').textContent = 'Huduma haijaunganishwa bado. Wasiliana na RUCUSO.'; return; }
    if (admin) {
      const session = await window.RucusoGuard.requireRole(['super_admin','admin'], {loginUrl:'/admin/login/'});
      if (!session) return;
      $('study-logout').addEventListener('click', () => window.RucusoGuard.logout('/'));
      const {data, error} = await window.RucusoAPI.client.rpc('has_permission', {p_key:'manage_documents'});
      // UI gate complements database-enforced row permissions.
      if (session.profile.role !== 'super_admin' && (error || !data)) {
        $('study-status').textContent = 'Unahitaji ruhusa ya manage_documents.'; return;
      }
      $('study-logout').addEventListener('click', () => window.RucusoGuard.logout('/'));
    }
    client = window.RucusoAPI.client;
    let debounce;
    for (const id of ['study-search','study-course']) $(id).addEventListener('input', () => {
      clearTimeout(debounce); debounce = setTimeout(() => load(true), 250);
    });
    for (const id of ['study-kind','study-year','study-semester']) $(id).addEventListener('change', () => load(true));
    if (admin) $('study-state').addEventListener('change', () => load(true));
    let searchTimer;
    for (const id of ['study-search','study-course']) $(id).addEventListener('input', () => {
      clearTimeout(searchTimer); searchTimer = setTimeout(() => load(true), 250);
    });
    for (const id of ['study-kind','study-year','study-semester']) $(id).addEventListener('change', () => load(true));
    $('study-more').addEventListener('click', () => { if (!loading) load(false); });
    const form = $('study-submit');
    if (form) {
      form.elements.kind.addEventListener('change', updateKind);
      form.addEventListener('submit', async ev => {
        ev.preventDefault();
        if (!form.reportValidity()) return;
        const request = form.elements.kind.value === 'request';
        const url = request ? null : safeUrl(form.elements.resource_url.value.trim());
        const status = $('study-form-status');
        if (!request && !url) { status.textContent = 'Tumia kiungo sahihi cha HTTPS.'; return; }
        const button = form.querySelector('[type="submit"]'); button.disabled = true;
        status.textContent = 'Inatuma…';
        try {
          const payload = {};
          for (const k of ['title','course','subject','kind','source','description']) payload['p_'+k] = form.elements[k].value.trim();
          payload.p_study_year = Number(form.elements.study_year.value);
          payload.p_semester = Number(form.elements.semester.value);
          payload.p_resource_url = url;
          const {error} = await client.rpc('submit_study_resource', payload);
          if (error) throw error;
          form.reset(); updateKind(); status.textContent = 'Imepokelewa! Itapitiwa na msimamizi kabla ya kuonekana hapa.';
        } catch(e) {
          console.error(e);
          status.textContent = e.code === 'P0001' ? e.message : message(e);
        } finally { button.disabled = false; }
      }); updateKind();
    }
    await load(true);
  }
  init().catch(e => { console.error(e); $('study-status').textContent = message(e); });
})();

/* Read requests may finish out of order, even after abort. Every render is scoped
 * to its settings/list generation and every photo to its selected request. */
(() => {
  const $ = id => document.getElementById(id);
  const root = '/api/admin/university-verifications', pageSize = 50;
  let generation = 0, selection = 0, current = null, objectUrl = null;
  let pageOffset = 0, hasNext = false, listBusy = false, mutating = false, photoReady = false;
  let listController = null, imageController = null;
  function message(text) { $('message').textContent = text; }
  function syncControls() {
    const locked = listBusy || mutating;
    for (const id of ['base', 'token', 'status', 'reviewer', 'reason']) $(id).disabled = mutating;
    $('refresh').disabled = mutating;
    $('previous').disabled = locked || pageOffset === 0;
    $('next').disabled = locked || !hasNext;
    $('approve').disabled = locked || current?.status !== 'pending' || !photoReady;
    $('reject').disabled = locked || current?.status !== 'pending';
    $('revoke').disabled = locked || current?.status !== 'approved';
    for (const b of $('queue').querySelectorAll('button')) b.disabled = locked;
  }
  function clearPhoto() {
    const photo = $('photo');
    photo.onload = photo.onerror = null;
    photo.hidden = true; photo.removeAttribute('src');
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null; photoReady = false;
  }
  function clearSelection() {
    ++selection; imageController?.abort(); imageController = null;
    current = null; clearPhoto();
    $('heading').textContent = '신청을 선택하세요'; $('details').textContent = '';
    $('reason').value = '';
  }
  function invalidate() {
    ++generation; listController?.abort(); listController = null;
    listBusy = false; pageOffset = 0; hasNext = false;
    clearSelection(); $('queue').replaceChildren(); $('page-info').textContent = '';
    message(''); syncControls();
  }
  function config() {
    const token = $('token').value.trim();
    if (!token) throw new Error('관리자 토큰을 입력하세요.');
    return { base: $('base').value.trim().replace(/\/$/, ''), token, status: $('status').value };
  }
  async function call(context, path, body, signal) {
    const headers = { Authorization: 'Bearer ' + context.token };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(context.base + path, { method: body === undefined ? 'GET' : 'POST',
      headers, credentials: 'omit', signal, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(`${r.status}: ${e.error || '요청 실패'}`); }
    return r;
  }
  async function select(item, context, listGeneration) {
    if (mutating || listBusy || generation !== listGeneration) return;
    clearSelection(); current = item;
    const selected = selection;
    const active = () => generation === listGeneration && selection === selected && current === item;
    $('heading').textContent = `${item.nickname} · ${item.university_name}`;
    $('details').textContent = `신청 #${item.id} / ${item.document_type} / ${item.status} / ${new Date(item.submitted_at * 1000).toLocaleString()} / ${item.reason || ''}`;
    syncControls();
    if (!item.image_available) return;
    imageController = new AbortController();
    try {
      const r = await call(context, `${root}/${item.id}/image`, undefined, imageController.signal);
      const blob = await r.blob();
      if (!active()) return;
      // A separate element prevents an earlier image's load event from enabling
      // approval for the newly selected request.
      const preview = document.createElement('img');
      preview.id = 'photo'; preview.alt = '신청자가 제출한 대학 인증 사진';
      preview.hidden = true;
      preview.onload = () => {
        if (!active() || $('photo') !== preview) return;
        preview.hidden = false; photoReady = true; syncControls();
      };
      preview.onerror = () => {
        if (!active() || $('photo') !== preview) return;
        clearPhoto(); syncControls();
        message('사진을 표시할 수 없습니다. 원본을 확인할 수 없으면 반려 후 재제출을 요청하세요.');
      };
      objectUrl = URL.createObjectURL(blob);
      $('photo').replaceWith(preview); preview.src = objectUrl;
    } catch (e) { if (active()) message(e.message); }
  }
  async function refresh(offset = 0) {
    if (mutating) return;
    const listGeneration = ++generation;
    listController?.abort(); clearSelection();
    $('queue').replaceChildren(); $('page-info').textContent = '';
    hasNext = false; listBusy = true; syncControls(); message('목록을 불러오는 중입니다.');
    listController = new AbortController();
    try {
      const context = config();
      const query = new URLSearchParams({ status: context.status, limit: pageSize + 1, offset });
      const r = await call(context, `${root}?${query}`, undefined, listController.signal);
      const rows = await r.json();
      if (generation !== listGeneration) return;
      if (!rows.length && offset > 0) return await refresh(0);
      pageOffset = offset; hasNext = rows.length > pageSize;
      for (const item of rows.slice(0, pageSize)) {
        const li = document.createElement('li'), b = document.createElement('button');
        b.textContent = `${item.nickname} · ${item.university_name} (#${item.id})`;
        b.onclick = () => select(item, context, listGeneration);
        li.append(b); $('queue').append(li);
      }
      const count = Math.min(rows.length, pageSize);
      $('page-info').textContent = count ? `${offset + 1}–${offset + count}번째 신청` : '0건';
      message(count ? `${count}건을 불러왔습니다.` : '해당 상태의 신청이 없습니다.');
    } catch (e) { if (generation === listGeneration) message(e.message); }
    finally { if (generation === listGeneration) { listBusy = false; syncControls(); } }
  }
  async function decide(decision) {
    if (mutating || listBusy || !current) return;
    if (decision === 'approved' && (!photoReady || current.status !== 'pending')) return;
    if (decision === 'rejected' && current.status !== 'pending') return;
    if (decision === 'revoked' && current.status !== 'approved') return;
    const reviewer = $('reviewer').value.trim(), reason = $('reason').value.trim();
    if (!reviewer || !reason) { message('검토 담당자와 사유를 입력하세요.'); return; }
    const id = current.id, scope = generation, offset = pageOffset, context = config();
    mutating = true; syncControls();
    let result;
    try {
      await call(context, `${root}/${id}/${decision === 'revoked' ? 'revoke' : 'decision'}`,
        decision === 'revoked' ? { reviewer, reason } : { decision, reviewer, reason });
      result = `신청 #${id} 처리 완료`;
    } catch (e) { result = `${e.message} (목록에서 최종 상태를 확인하세요.)`; }
    finally { mutating = false; syncControls(); }
    if (scope === generation) {
      const refreshing = refresh(offset), refreshGeneration = generation;
      await refreshing;
      if (generation === refreshGeneration) message(`${result}\n${$('message').textContent}`);
    }
  }
  $('refresh').onclick = () => refresh();
  $('previous').onclick = () => { if (!listBusy && !mutating) return refresh(Math.max(0, pageOffset - pageSize)); };
  $('next').onclick = () => { if (hasNext && !listBusy && !mutating) return refresh(pageOffset + pageSize); };
  for (const decision of ['approved', 'rejected', 'revoked']) {
    const id = { approved: 'approve', rejected: 'reject', revoked: 'revoke' }[decision];
    $(id).onclick = () => decide(decision);
  }
  $('base').oninput = $('token').oninput = $('status').onchange = invalidate;
  window.addEventListener('pagehide', invalidate);
  syncControls();
})();

/* Read requests may finish out of order, even after abort. Every render is scoped
 * to its settings/list generation and every photo to its selected request. */
(() => {
  const $ = id => document.getElementById(id);
  const root = '/api/admin/university-verifications', pageSize = 50;
  const statuses = { pending: '검토 대기', approved: '승인 완료', rejected: '반려', cancelled: '제출 취소', expired: '기한 만료', revoked: '승인 철회' };
  const documents = { student_card: '학생증', admission_letter: '합격증', enrollment_certificate: '재학증명서', other: '기타 서류' };
  let generation = 0, selection = 0, current = null, objectUrl = null;
  let pageOffset = 0, hasNext = false, listBusy = false, mutating = false, photoReady = false;
  let listController = null, imageController = null;
  let queueScroll = 0;
  function message(text, tone = 'info') {
    $('message').textContent = text; $('message').hidden = !text;
    $('message').dataset.tone = tone;
    $('connection-feedback').textContent = $('connection').open && tone === 'error' ? text : '';
    $('connection-feedback').hidden = !$('connection-feedback').textContent;
  }
  function connected(value) {
    $('connection-dot').dataset.connected = String(value);
    $('connection-label').textContent = value ? '관리자 연결됨' : '관리자 연결 설정';
  }
  function emptyState(state) {
    $('queue-empty').hidden = state === 'populated';
    $('connect-button').hidden = !['initial', 'error'].includes(state);
    $('empty-title').textContent = { initial: '신청 목록을 불러와 주세요', loading: '신청을 불러오고 있어요', empty: '조회된 신청이 없어요', error: '목록을 불러오지 못했어요' }[state] || '';
    $('empty-description').textContent = { initial: '관리자 연결 후 학생들이 제출한\n인증 서류를 확인할 수 있어요.', loading: '잠시만 기다려 주세요.', empty: '다른 상태를 선택하거나\n잠시 후 다시 확인해 주세요.', error: '연결 설정을 확인하고\n다시 불러와 주세요.' }[state] || '';
  }
  function shortDate(timestamp) {
    return new Date(timestamp * 1000).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  }
  function node(tag, className, text) {
    const element = document.createElement(tag); element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function requestCard(item) {
    const button = node('button', 'request-card');
    button.dataset.requestId = String(item.id);
    button.setAttribute('aria-label', `${item.nickname} · ${item.university_name} (#${item.id})`);
    const avatar = node('span', 'avatar', Array.from(item.nickname)[0] || 'C');
    avatar.setAttribute('aria-hidden', 'true');
    const copy = node('span', 'request-copy'), name = node('span', 'request-name-row');
    const badge = node('span', 'status-badge', statuses[item.status] || item.status);
    badge.dataset.status = item.status;
    name.append(node('span', 'request-name', item.nickname), badge);
    copy.append(name, node('span', 'request-university', item.university_name),
      node('span', 'request-caption', `${documents[item.document_type] || '서류'} · ${shortDate(item.submitted_at)}`));
    const arrow = node('span', 'request-arrow', '›'); arrow.setAttribute('aria-hidden', 'true');
    button.append(avatar, copy, arrow);
    return button;
  }
  function syncControls() {
    const locked = listBusy || mutating;
    for (const id of ['base', 'token', 'status', 'reviewer', 'reason']) $(id).disabled = mutating;
    $('refresh').disabled = mutating;
    $('connect-load').disabled = locked;
    $('back').disabled = mutating;
    $('reason-approved').disabled = $('reason-unclear').disabled = locked || current?.status !== 'pending';
    $('quick-reasons').hidden = current?.status !== 'pending';
    $('previous').disabled = locked || pageOffset === 0;
    $('next').disabled = locked || !hasNext;
    $('approve').disabled = locked || current?.status !== 'pending' || !photoReady;
    $('reject').disabled = locked || current?.status !== 'pending';
    $('revoke').disabled = locked || current?.status !== 'approved';
    $('approve').hidden = $('reject').hidden = current?.status !== 'pending';
    $('revoke').hidden = current?.status !== 'approved';
    $('review-actions').hidden = !current || !['pending', 'approved'].includes(current.status);
    $('reason').readOnly = !!current && !['pending', 'approved'].includes(current.status);
    for (const b of $('queue').querySelectorAll('button')) {
      b.disabled = locked; b.setAttribute('aria-current', String(Number(b.dataset.requestId) === current?.id));
    }
  }
  function clearPhoto() {
    const photo = $('photo');
    photo.onload = photo.onerror = null;
    photo.hidden = true; photo.removeAttribute('src');
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null; photoReady = false;
    $('photo-placeholder').hidden = false;
  }
  function clearSelection() {
    ++selection; imageController?.abort(); imageController = null;
    current = null; clearPhoto();
    $('heading').textContent = '신청을 선택하세요'; $('details').textContent = '';
    for (const id of ['university-name', 'request-status', 'document-type']) $(id).textContent = '';
    $('request-id').textContent = '신청 정보';
    $('reason').value = '';
    $('reason-error').hidden = true; $('reason').removeAttribute('aria-invalid');
    $('review-content').hidden = true; $('review-empty').hidden = false;
    $('app').dataset.view = 'queue';
  }
  function invalidate() {
    ++generation; listController?.abort(); listController = null;
    listBusy = false; pageOffset = 0; hasNext = false;
    clearSelection(); $('queue').replaceChildren(); $('page-info').textContent = '';
    $('pagination').hidden = true; $('queue-count').textContent = '—';
    emptyState('initial'); connected(false);
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
    const selectedScroll = window.scrollY;
    clearSelection(); current = item;
    const selected = selection;
    const active = () => generation === listGeneration && selection === selected && current === item;
    $('heading').textContent = item.nickname;
    $('university-name').textContent = item.university_name;
    $('request-id').textContent = `신청 #${item.id}`;
    $('request-status').textContent = statuses[item.status] || item.status;
    $('request-status').dataset.status = item.status;
    $('details').textContent = `${shortDate(item.submitted_at)} 제출${item.reason && item.status === 'approved' ? '\n처리 사유 · ' + item.reason : ''}`;
    $('document-type').textContent = documents[item.document_type] || '기타 서류';
    $('photo-note').textContent = item.image_available ? '서류를 불러오는 중이에요.' : '보관 기간이 끝나거나 처리된\n서류 사진은 삭제됩니다.';
    $('photo-help').hidden = !item.image_available;
    if (!['pending', 'approved'].includes(item.status)) $('reason').value = item.reason || '';
    $('review-content').hidden = false; $('review-empty').hidden = true;
    $('app').dataset.view = 'review'; message('');
    if (window.matchMedia('(max-width:767px)').matches) { queueScroll = selectedScroll; window.scrollTo({ top: 0 }); }
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
        preview.hidden = false; $('photo-placeholder').hidden = true; photoReady = true; syncControls();
      };
      preview.onerror = () => {
        if (!active() || $('photo') !== preview) return;
        clearPhoto(); syncControls();
        $('photo-note').textContent = '사진을 표시할 수 없어요.\n반려 후 재제출을 요청해 주세요.';
        message('사진을 표시할 수 없습니다. 원본을 확인할 수 없으면 반려 후 재제출을 요청하세요.', 'error');
      };
      objectUrl = URL.createObjectURL(blob);
      $('photo').replaceWith(preview); preview.src = objectUrl;
    } catch (e) { if (active()) { $('photo-note').textContent = '서류를 불러오지 못했어요.\n목록에서 다시 선택해 주세요.'; message(e.message, 'error'); } }
  }
  async function refresh(offset = 0) {
    if (mutating) return;
    const fromReview = $('app').dataset.view === 'review';
    const listGeneration = ++generation;
    listController?.abort(); clearSelection();
    if (fromReview && window.matchMedia('(max-width:767px)').matches) window.scrollTo({ top: 0 });
    $('queue').replaceChildren(); $('page-info').textContent = '';
    $('pagination').hidden = true; $('queue-count').textContent = '—'; emptyState('loading');
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
        const li = document.createElement('li'), b = requestCard(item);
        b.onclick = () => select(item, context, listGeneration);
        li.append(b); $('queue').append(li);
      }
      const count = Math.min(rows.length, pageSize);
      $('queue-count').textContent = `${count}${hasNext ? '+' : ''}`;
      $('page-info').textContent = count ? `${offset + 1}–${offset + count}번째 신청` : '0건';
      $('pagination').hidden = !count;
      emptyState(count ? 'populated' : 'empty'); connected(true);
      $('connection').open = false; message('');
    } catch (e) { if (generation === listGeneration) { connected(false); emptyState('error'); message(e.message, 'error'); } }
    finally { if (generation === listGeneration) { listBusy = false; syncControls(); } }
  }
  async function decide(decision) {
    if (mutating || listBusy || !current) return;
    if (decision === 'approved' && (!photoReady || current.status !== 'pending')) return;
    if (decision === 'rejected' && current.status !== 'pending') return;
    if (decision === 'revoked' && current.status !== 'approved') return;
    const reviewer = $('reviewer').value.trim(), reason = $('reason').value.trim();
    if (!reviewer) { openConnection(); $('reviewer').focus(); message('검토 담당자 이름을 먼저 입력해 주세요.', 'error'); return; }
    if (!reason) { $('reason-error').hidden = false; $('reason').setAttribute('aria-invalid', 'true'); message('검토 사유를 입력해 주세요.', 'error'); $('reason').focus(); return; }
    const id = current.id, scope = generation, offset = pageOffset, context = config();
    mutating = true; syncControls();
    let result, failed = false;
    try {
      await call(context, `${root}/${id}/${decision === 'revoked' ? 'revoke' : 'decision'}`,
        decision === 'revoked' ? { reviewer, reason } : { decision, reviewer, reason });
      result = `신청 #${id} 처리 완료`;
    } catch (e) { failed = true; result = `${e.message} (목록에서 최종 상태를 확인하세요.)`; }
    finally { mutating = false; syncControls(); }
    if (scope === generation) {
      const refreshing = refresh(offset), refreshGeneration = generation;
      await refreshing;
      if (generation === refreshGeneration) message(`${result}${$('message').textContent ? '\n' + $('message').textContent : ''}`, failed ? 'error' : 'info');
    }
  }
  $('refresh').onclick = () => refresh();
  $('connect-load').onclick = () => refresh();
  function openConnection() {
    if (mutating) return;
    clearSelection(); syncControls(); $('connection').open = true;
    if (window.matchMedia('(max-width:767px)').matches) window.scrollTo({ top: 0 });
  }
  $('connect-button').onclick = openConnection;
  $('back').onclick = () => {
    if (mutating) return;
    clearSelection(); syncControls(); message('');
    if (window.matchMedia('(max-width:767px)').matches) window.scrollTo({ top: queueScroll });
  };
  $('reason').oninput = () => {
    $('reason-error').hidden = true; $('reason').removeAttribute('aria-invalid');
    if ($('message').textContent === '검토 사유를 입력해 주세요.') message('');
  };
  $('reason-approved').onclick = () => { if (!mutating && current?.status === 'pending') { $('reason').value = '학교명과 제출 서류를 확인했습니다.'; $('reason').oninput(); } };
  $('reason-unclear').onclick = () => { if (!mutating && current?.status === 'pending') { $('reason').value = '학교명과 소속 근거를 확인하기 어렵습니다. 선명한 서류 사진으로 다시 제출해 주세요.'; $('reason').oninput(); } };
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

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useApp } from "../state/AppContext.jsx";
import { Badge, Notice, Spinner, SubHeader } from "../components/ui.jsx";
import { apiMessage, VERIFICATION_LABEL } from "../lib/messages.js";
import { dateTime } from "../lib/format.js";
import { UniversityVerification } from "../services/university-verification.js";
import { DOCUMENT_TYPES, inspectProof, verificationError } from "../services/verification-files.js";

const EXPLANATIONS = {
  not_submitted: ["우리 학교 러너로 인증하기", "학생증이나 합격증을 제출하면 운영진이 직접 확인해요. 승인 후 내 정상 러닝 기록이 학교 점수에 반영돼요."],
  pending: ["운영진이 서류를 확인하고 있어요", "검토가 끝나면 이 화면에서 결과를 확인할 수 있어요. 그동안 개인 러닝은 계속 기록할 수 있어요."],
  approved: ["학교 인증이 완료됐어요", "이제 내 정상 러닝 기록이 학교 점수에 함께 반영돼요. 인증 전의 정상 기록도 기간 규칙에 따라 반영돼요."],
  rejected: ["서류를 다시 확인해 주세요", "아래 반려 사유를 확인한 뒤, 내용을 보완한 사진으로 다시 제출해 주세요."],
  cancelled: ["이전 신청이 취소됐어요", "소속 대학 인증이 필요하면 새 서류를 제출해 주세요."],
  expired: ["이전 신청의 검토 기간이 지났어요", "미검토 7일이 지나 사진이 삭제됐어요. 새 서류로 다시 신청할 수 있어요."],
  revoked: ["학교 인증이 철회됐어요", "아래 사유를 확인해 주세요. 필요한 내용을 보완해 다시 신청할 수 있어요."],
};

function usePreview(photo) {
  const [preview, setPreview] = useState(null);
  useEffect(() => {
    if (!photo) { setPreview(null); return undefined; }
    const url = URL.createObjectURL(photo.file);
    setPreview({ file: photo.file, url });
    return () => URL.revokeObjectURL(url);
  }, [photo]);
  return preview?.file === photo?.file ? preview?.url : null;
}

export default function Verification() {
  const { api, user, syncProfile, handleAuthError, config } = useApp();
  const store = useMemo(() => new UniversityVerification({ api, user,
    onProfile: syncProfile, onAuthError: handleAuthError }), [api, user.id, user.token, syncProfile, handleAuthError]);
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const [documentType, setDocumentType] = useState("student_card");
  const [photo, setPhoto] = useState(null);
  const [consent, setConsent] = useState(false);
  const [previewReady, setPreviewReady] = useState(false);
  const [fileError, setFileError] = useState(null);
  const [checkingFile, setCheckingFile] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const fileVersion = useRef(0), alive = useRef(false), input = useRef(null);
  const preview = usePreview(photo);
  const verified = state.profile.university_verified;
  const status = verified ? "approved" : state.profile.verification_status || "not_submitted";
  const label = VERIFICATION_LABEL[status] || VERIFICATION_LABEL.not_submitted;
  const explanation = EXPLANATIONS[status] || EXPLANATIONS.not_submitted;
  const pending = state.rows.find(row => row.status === "pending");
  const latest = state.rows.find(row => row.university_id === user.university_id && row.status === status);
  const disabled = Boolean(state.busy) || state.loading || !state.fresh || state.uncertain;

  useEffect(() => {
    alive.current = true; store.connect(); store.refresh();
    return () => { alive.current = false; ++fileVersion.current; store.disconnect(); };
  }, [store]);

  useEffect(() => {
    const refresh = () => {
      const current = store.getState();
      if (document.visibilityState === "visible" && !current.busy && !current.loading) store.refresh();
    };
    document.addEventListener("visibilitychange", refresh);
    const timer = pending ? setInterval(refresh, 15000) : null;
    return () => { document.removeEventListener("visibilitychange", refresh); if (timer) clearInterval(timer); };
  }, [store, pending?.id]);

  const clearPhoto = (resetInput = true) => {
    ++fileVersion.current; setPhoto(null); setConsent(false); setPreviewReady(false); setCheckingFile(false); setFileError(null);
    if (resetInput && input.current) input.current.value = "";
  };
  useEffect(() => { if (verified || pending) { clearPhoto(); setConfirmCancel(false); } }, [verified, pending?.id]);

  const selectPhoto = async event => {
    const file = event.target.files?.[0];
    clearPhoto(false);
    if (!file) return;
    const version = fileVersion.current;
    setCheckingFile(true);
    try {
      const dimensions = await inspectProof(file);
      if (alive.current && version === fileVersion.current) setPhoto({ file, dimensions, version });
    } catch (raw) {
      if (alive.current && version === fileVersion.current) {
        setFileError(raw.status ? raw : verificationError("proof_read_failed"));
        if (input.current) input.current.value = "";
      }
    } finally { if (alive.current && version === fileVersion.current) setCheckingFile(false); }
  };

  const submit = async event => {
    event.preventDefault();
    if (!photo || !previewReady || !consent || disabled) return;
    const received = await store.submit(photo.file, documentType, consent);
    if (alive.current && received) clearPhoto();
  };
  const cancel = async () => {
    if (!pending || state.busy) return;
    const result = await store.cancel(pending.id);
    if (alive.current && result) setConfirmCancel(false);
  };

  return <div className="screen verification-screen">
    <SubHeader title="학교 인증" back="/home" backLabel="홈" right={
      <button type="button" className="text-button" onClick={() => store.refresh()} disabled={Boolean(state.busy) || state.loading}>새로고침</button>
    } />
    <section className={`card verification-status verification-status--${label.tone}`}>
      <div className="verification-status__head"><span className="card__label">소속 대학 인증</span><Badge tone={label.tone}>{label.text}</Badge></div>
      <h2>{user.university_name}</h2>
      <strong>{explanation[0]}</strong><p>{explanation[1]}</p>
      {latest?.submitted_at && <p className="hint">제출 {dateTime(latest.submitted_at)}{status === "pending" ? ` · 검토 기한 ${dateTime(latest.expires_at)}` : ""}</p>}
      {(status === "rejected" || status === "revoked") && latest?.reason && <div className="verification-reason"><b>{status === "rejected" ? "반려 사유" : "철회 사유"}</b><p>{latest.reason}</p></div>}
      {status === "pending" && <p className="hint">미검토 7일 후에는 자동 만료돼요. 검토 중에는 15초마다 상태를 확인해요.</p>}
    </section>

    {config.mock && <Notice tone="info">목업 모드예요. 실제 운영진에게 사진을 보내지 않으며 사진 파일은 저장하지 않아요.</Notice>}
    {state.loading && !state.loaded && <Spinner label="인증 신청 확인 중" />}
    {state.notice && <Notice tone="info">{state.notice}</Notice>}
    {state.error && <Notice tone="bad" title={state.uncertain ? "접수 여부를 먼저 확인해 주세요" : "요청을 완료하지 못했어요"} action={
      <button type="button" className="btn btn--ghost btn--small" disabled={Boolean(state.busy) || state.loading} onClick={() => store.refresh()}>상태 확인</button>
    }>{apiMessage(state.error)}{state.uncertain ? " 서버에 접수됐을 수 있어요. 상태 확인이 끝날 때까지 다시 제출하지 않아요." : ""}</Notice>}
    {state.busy && <Spinner label={state.busy === "upload" ? "서류를 제출하고 있어요. 잠시만 기다려 주세요." : "신청을 취소하고 있어요"} />}

    {!verified && pending && <section className="card verification-cancel">
      {!confirmCancel ? <>
        <h2>사진을 잘못 제출했나요?</h2><p className="muted">검토 중인 신청을 취소한 뒤 새 사진을 제출할 수 있어요.</p>
        <button type="button" className="btn btn--outline btn--block" disabled={disabled} onClick={() => setConfirmCancel(true)}>신청 취소</button>
      </> : <div role="group" aria-labelledby="cancel-proof-title">
        <h2 id="cancel-proof-title">이 신청을 취소할까요?</h2><p className="muted">제출한 사진은 서버에서 삭제돼요. 다시 인증하려면 새로 제출해야 해요.</p>
        <div className="btn-row"><button type="button" className="btn btn--ghost" disabled={Boolean(state.busy)} onClick={() => setConfirmCancel(false)}>검토 기다리기</button>
          <button type="button" className="btn btn--dark" disabled={disabled} onClick={cancel}>취소 확정</button></div>
      </div>}
    </section>}

    {!verified && !pending && state.loaded && <form className="card verification-form" onSubmit={submit}>
      <div><span className="kicker">CAMPUS VERIFICATION</span><h2>{status === "not_submitted" ? "소속 확인 서류 제출" : "서류 다시 제출"}</h2><p className="muted">학교명과 소속을 확인할 수 있는 사진 한 장을 준비해 주세요.</p></div>
      <div className="verification-mask"><strong>올리기 전에 개인정보를 가려 주세요</strong><p>주민등록번호, 주소, 전화번호, 학번, 바코드·QR 등 확인에 필요 없는 정보는 사진에서 가려 주세요.</p><p>학교명과 소속 확인에 필요한 부분은 읽을 수 있게 남겨 주세요.</p></div>
      <label className="verification-field" htmlFor="document-type"><span>서류 종류</span><select id="document-type" value={documentType} onChange={e => setDocumentType(e.target.value)} disabled={disabled}>
        {DOCUMENT_TYPES.map(type => <option key={type.value} value={type.value}>{type.label}</option>)}
      </select></label>
      <div className="verification-file">
        <label className="verification-field" htmlFor="proof-file"><span>서류 사진</span><span className="hint">JPG·PNG 한 장, 최대 5MiB · HEIC·PDF는 변환 후 선택해 주세요.</span></label>
        <input ref={input} id="proof-file" type="file" accept="image/jpeg,image/png,.jpg,.jpeg,.png" onChange={selectPhoto} disabled={disabled || checkingFile} aria-describedby="proof-retention" />
      </div>
      {checkingFile && <Spinner label="사진 확인 중" />}
      {preview && <figure className="verification-preview">
        <img src={preview} alt="선택한 인증 서류 미리보기" onLoad={() => { if (alive.current && photo.version === fileVersion.current) setPreviewReady(true); }}
          onError={() => { if (alive.current && photo.version === fileVersion.current) { setPreviewReady(false); setFileError(verificationError("invalid_image")); } }} />
        <figcaption><span>{photo.file.name}</span><small>{(photo.file.size / 1024 / 1024).toFixed(2)} MiB · {photo.dimensions.width} × {photo.dimensions.height}</small></figcaption>
        <button type="button" className="text-button" onClick={clearPhoto} disabled={Boolean(state.busy)}>사진 지우기</button>
      </figure>}
      {fileError && <p className="form-error" role="alert">{apiMessage(fileError)}</p>}
      <div className="verification-consent-copy" id="proof-retention"><strong>사진은 인증 확인에만 사용해요</strong><p>운영진이 직접 확인하며 검토 완료·신청 취소 즉시 또는 미검토 7일 후 사진을 삭제해요. 신청 상태와 처리 사유는 이력에 남아요.</p></div>
      <label className="verification-consent"><input type="checkbox" checked={consent} disabled={disabled || !previewReady || Boolean(fileError)} onChange={e => setConsent(e.target.checked)} />
        <span>소속 대학 확인을 위한 사진 제출과 운영진 열람에 동의합니다.<b>필수</b></span></label>
      <button type="submit" className="btn btn--primary btn--block btn--xl" disabled={disabled || !photo || !previewReady || !consent || checkingFile || Boolean(fileError)}>
        {state.busy === "upload" ? "제출 중…" : status === "not_submitted" ? "인증 서류 제출" : "보완한 서류 다시 제출"}
      </button>
      <p className="hint center">검토 대기 신청은 1건만 가능하며, 최근 24시간 동안 최대 5번 제출할 수 있어요.</p>
    </form>}

    {state.rows.length > 0 && <section className="verification-history">
      <h2 className="section-title">신청 이력</h2><ol>{state.rows.map(row => <li className="card" key={row.id}>
        <div className="verification-history__head"><strong>{DOCUMENT_TYPES.find(type => type.value === row.document_type)?.label || "인증 서류"}</strong>
          <Badge tone={VERIFICATION_LABEL[row.status]?.tone}>{VERIFICATION_LABEL[row.status]?.text || row.status}</Badge></div>
        <p className="muted">{row.university_name}</p><p className="hint">제출 {dateTime(row.submitted_at)}</p>
        {row.reviewed_at && <p className="hint">처리 {dateTime(row.reviewed_at)}</p>}
        {row.reason && <p className="verification-history__reason">{displayReason(row.reason)}</p>}
      </li>)}</ol>
      {state.hasMore && <button type="button" className="btn btn--outline btn--block" disabled={disabled} onClick={() => store.refresh(true)}>이전 신청 더 보기</button>}
    </section>}
  </div>;
}

function displayReason(reason) {
  return ({ withdrawn_by_member: "본인이 신청을 취소했어요.", review_window_expired: "7일의 검토 기간이 지나 만료됐어요.",
    university_changed: "소속 대학 변경으로 취소됐어요.", backup_restore_resubmission_required: "데이터 복원으로 새 서류 제출이 필요해요." })[reason] || reason;
}

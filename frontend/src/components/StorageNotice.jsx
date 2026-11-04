import { apiMessage } from "../lib/messages.js";
import { Notice } from "./ui.jsx";

export default function StorageNotice({ state }) {
  return <>
    {state.storageWarning && <Notice tone="bad" title="기기 저장소 확인 필요">{apiMessage(state.storageWarning)}</Notice>}
    {state.legacyUnowned && <Notice tone="warn" title="이전 버전의 임시 기록 있음">
      계정 확인 불가로 자동 전송 안 함 · 필요 시 운영자 문의
    </Notice>}
  </>;
}

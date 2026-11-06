import { apiMessage } from "../lib/messages.js";
import { Notice } from "./ui.jsx";

export default function StorageNotice({ state }) {
  return <>
    {state.storageWarning && <Notice tone="bad" title="기기 저장소 확인이 필요해요">{apiMessage(state.storageWarning)}</Notice>}
    {state.legacyUnowned && <Notice tone="warn" title="이전 버전의 임시 기록이 있어요">
      계정을 확인할 수 없는 이전 기록은 자동 전송하지 않아요. 이 기록이 필요하다면 기기 저장소를 지우기 전에 운영자에게 문의해 주세요.
    </Notice>}
  </>;
}

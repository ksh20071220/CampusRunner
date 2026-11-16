export const DOCUMENT_TYPES = [
  { value: "student_card", label: "학생증" },
  { value: "admission_letter", label: "합격증" },
  { value: "enrollment_certificate", label: "재학증명서" },
  { value: "other", label: "기타 소속 확인 서류" },
];
export const MAX_PROOF_BYTES = 5 * 1024 * 1024;

export function verificationError(code) {
  return Object.assign(new Error(code), { code, status: 400 });
}

// Reject huge dimensions before handing compressed data to the image decoder.
// The preview's load/error event additionally confirms browser decodability.
export async function inspectProof(file) {
  if (!file || !file.size) throw verificationError("proof_file_required");
  if (file.size > MAX_PROOF_BYTES) throw verificationError("image_too_large");
  if (!["image/jpeg", "image/png"].includes(file.type)) throw verificationError("jpeg_or_png_required");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width, height;
  if (file.type === "image/png" && bytes.length >= 24 &&
      [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n) &&
      view.getUint32(8) === 13 && [73, 72, 68, 82].every((n, i) => bytes[12 + i] === n)) {
    width = view.getUint32(16); height = view.getUint32(20);
  } else if (file.type === "image/jpeg" && bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216) {
    let at = 2;
    while (at + 3 < bytes.length) {
      if (bytes[at++] !== 255) break;
      while (bytes[at] === 255) ++at;
      const marker = bytes[at++];
      if (marker === 0xda || marker === 0xd9) break;
      if ((marker >= 0xd0 && marker <= 0xd7) || marker === 1) continue;
      if (at + 2 > bytes.length) break;
      const length = view.getUint16(at);
      if (length < 2 || at + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length >= 8) { height = view.getUint16(at + 3); width = view.getUint16(at + 5); }
        break;
      }
      at += length;
    }
  }
  if (!width || !height) throw verificationError("invalid_image");
  if (width > 12000 || height > 12000 || width * height > 40000000)
    throw verificationError("proof_dimensions_exceeded");
  return { width, height };
}

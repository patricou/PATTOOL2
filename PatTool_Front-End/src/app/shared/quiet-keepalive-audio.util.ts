/** Inaudible looping WAV so mobile Chrome/Safari keep the tab alive when hidden. */

const SAMPLE_RATE = 8000;
const DURATION_SEC = 1;
const HERTZ = 20;
/** ~0.03 % of full scale — not digital silence (iOS drops truly silent loops). */
const AMPLITUDE = 8;

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

export function createQuietKeepAliveWavBlob(): Blob {
  const n = SAMPLE_RATE * DURATION_SEC;
  const dataSize = n * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < n; i++) {
    const sample = Math.sin((2 * Math.PI * HERTZ * i) / SAMPLE_RATE) * AMPLITUDE;
    view.setInt16(44 + i * 2, sample, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

export function createQuietKeepAliveAudioUrl(): string {
  return URL.createObjectURL(createQuietKeepAliveWavBlob());
}

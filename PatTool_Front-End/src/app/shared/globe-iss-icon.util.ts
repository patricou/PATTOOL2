/** ISS top-down: central truss + yellow solar panels (same sprite as the 3D globe). */
export function drawIssTopViewIcon(ctx: CanvasRenderingContext2D, size: number): void {
  const cx = size / 2;
  const cy = size / 2;
  const s = size;
  const yellow = '#ffea00';
  const panel = '#ffd000';
  const stroke = '#fff8b0';
  ctx.clearRect(0, 0, s, s);
  ctx.lineJoin = 'round';
  ctx.strokeStyle = stroke;
  ctx.lineWidth = Math.max(1.5, s * 0.028);

  ctx.fillStyle = panel;
  ctx.strokeRect(cx - s * 0.44, cy - s * 0.13, s * 0.16, s * 0.26);
  ctx.fillRect(cx - s * 0.44, cy - s * 0.13, s * 0.16, s * 0.26);
  ctx.strokeRect(cx + s * 0.28, cy - s * 0.13, s * 0.16, s * 0.26);
  ctx.fillRect(cx + s * 0.28, cy - s * 0.13, s * 0.16, s * 0.26);

  ctx.strokeStyle = 'rgba(255, 240, 160, 0.55)';
  ctx.lineWidth = 1;
  for (let i = 1; i <= 3; i++) {
    const xL = cx - s * 0.44 + (s * 0.16 * i) / 4;
    const xR = cx + s * 0.28 + (s * 0.16 * i) / 4;
    ctx.beginPath();
    ctx.moveTo(xL, cy - s * 0.13);
    ctx.lineTo(xL, cy + s * 0.13);
    ctx.moveTo(xR, cy - s * 0.13);
    ctx.lineTo(xR, cy + s * 0.13);
    ctx.stroke();
  }

  ctx.fillStyle = yellow;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = Math.max(2, s * 0.03);
  ctx.fillRect(cx - s * 0.3, cy - s * 0.028, s * 0.6, s * 0.056);
  ctx.strokeRect(cx - s * 0.3, cy - s * 0.028, s * 0.6, s * 0.056);

  ctx.beginPath();
  ctx.arc(cx - s * 0.14, cy, s * 0.045, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx + s * 0.14, cy, s * 0.045, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillRect(cx - s * 0.055, cy - s * 0.055, s * 0.11, s * 0.11);
  ctx.strokeRect(cx - s * 0.055, cy - s * 0.055, s * 0.11, s * 0.11);
}

export function buildIssTopViewIconDataUrl(size = 32): string | undefined {
  if (typeof document === 'undefined') {
    return undefined;
  }
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return undefined;
  }
  drawIssTopViewIcon(ctx, size);
  return canvas.toDataURL('image/png');
}

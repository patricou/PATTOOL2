/** Document Picture-in-Picture for Radio — World Receiver face in an always-on-top window. */

export interface RadioDocPipLabels {
  fullscreen: string;
  fullscreenExit: string;
  close: string;
}

export interface RadioDocPipHandle {
  window: Window;
  close: () => void;
}

interface DocumentPictureInPictureApi {
  window: Window | null;
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}

let activeDocPip: RadioDocPipHandle | null = null;
let mediaHome: { parent: Node; next: ChildNode | null; media: HTMLVideoElement } | null = null;
let faceHome: {
  parent: Node;
  next: ChildNode | null;
  face: HTMLElement;
  placeholder: HTMLElement;
} | null = null;

export function supportsRadioPictureInPicture(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  if ('documentPictureInPicture' in window) {
    return true;
  }
  return !!(document as Document & { pictureInPictureEnabled?: boolean }).pictureInPictureEnabled;
}

export function supportsRadioDocumentPip(): boolean {
  return typeof window !== 'undefined' && 'documentPictureInPicture' in window;
}

export function isRadioDocPipOpen(): boolean {
  return !!(activeDocPip?.window && !activeDocPip.window.closed);
}

export function getRadioDocPipWindow(): Window | null {
  return isRadioDocPipOpen() ? activeDocPip!.window : null;
}

export function closeRadioDocPip(): void {
  const handle = activeDocPip;
  if (!handle) {
    // Still restore homes if a partial open left them set.
    restoreFaceHome();
    restoreMediaHome();
    return;
  }
  handle.close();
}

export function applyRadioMediaSession(meta: {
  title: string;
  artworkUrl?: string | null;
}): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) {
    return;
  }
  try {
    const artwork = meta.artworkUrl
      ? [{ src: meta.artworkUrl, sizes: '512x512', type: 'image/png' }]
      : [];
    navigator.mediaSession.metadata = new MediaMetadata({
      title: meta.title || 'Radio',
      artist: 'PatTool Radio',
      artwork
    });
  } catch {
    /* ignore */
  }
}

function getDocumentPipApi(): DocumentPictureInPictureApi | null {
  return (
    (window as Window & { documentPictureInPicture?: DocumentPictureInPictureApi })
      .documentPictureInPicture || null
  );
}

function restoreMediaHome(): void {
  if (!mediaHome) {
    return;
  }
  const { parent, next, media } = mediaHome;
  try {
    if (next && next.parentNode === parent) {
      parent.insertBefore(media, next);
    } else {
      parent.appendChild(media);
    }
  } catch {
    /* ignore */
  }
  media.classList.remove('radio-doc-pip-media');
  mediaHome = null;
}

function restoreFaceHome(): void {
  if (!faceHome) {
    return;
  }
  const { parent, next, face, placeholder } = faceHome;
  try {
    face.classList.remove('radio-player-panel--in-pip');
    if (placeholder.parentNode) {
      placeholder.parentNode.replaceChild(face, placeholder);
    } else if (next && next.parentNode === parent) {
      parent.insertBefore(face, next);
    } else {
      parent.appendChild(face);
    }
  } catch {
    try {
      parent.appendChild(face);
    } catch {
      /* ignore */
    }
  }
  faceHome = null;
}

function copyStylesToPip(doc: Document): void {
  Array.from(document.querySelectorAll('style, link[rel="stylesheet"]')).forEach((node) => {
    try {
      doc.head.appendChild(node.cloneNode(true));
    } catch {
      /* ignore */
    }
  });
}

/**
 * Opens a Document PiP window with the World Receiver cabinet inside
 * (same idea as TV PiP showing the video).
 */
export async function enterRadioPictureInPicture(
  video: HTMLVideoElement,
  meta: {
    title: string;
    artworkUrl?: string | null;
    countryLabel?: string | null;
    /** Full radio cabinet panel (`.radio-player-panel`) — moved into the PiP window. */
    faceEl?: HTMLElement | null;
    labels: RadioDocPipLabels;
    onClose?: () => void;
  }
): Promise<void> {
  applyRadioMediaSession(meta);
  await video.play().catch(() => undefined);

  const dpi = getDocumentPipApi();
  if (dpi) {
    if (dpi.window && !dpi.window.closed) {
      // Toggle off via shared teardown (restores face/media + one onClose).
      closeRadioDocPip();
      return;
    }
    await openDocumentPip(video, meta, dpi);
    return;
  }

  // Fallback: classic video PiP (no custom radio face).
  if (!(document as Document & { pictureInPictureEnabled?: boolean }).pictureInPictureEnabled) {
    throw new Error('unsupported');
  }
  if (document.pictureInPictureElement) {
    await document.exitPictureInPicture();
    stopRadioPipCarrier();
    return;
  }
  await video.requestPictureInPicture();
}

async function openDocumentPip(
  video: HTMLVideoElement,
  meta: {
    title: string;
    artworkUrl?: string | null;
    countryLabel?: string | null;
    faceEl?: HTMLElement | null;
    labels: RadioDocPipLabels;
    onClose?: () => void;
  },
  dpi: DocumentPictureInPictureApi
): Promise<void> {
  const face = meta.faceEl || null;
  const width = face
    ? Math.max(480, Math.min(720, Math.round(face.getBoundingClientRect().width || 560)))
    : 520;
  const height = face
    ? Math.max(360, Math.min(640, Math.round(face.getBoundingClientRect().height || 420)))
    : 400;

  const pipWindow = await dpi.requestWindow({ width, height });
  const doc = pipWindow.document;
  doc.title = `${meta.title || 'Radio'} — PatTool`;

  const style = doc.createElement('style');
  style.textContent = `
    html, body {
      margin: 0; padding: 0; width: 100%; height: 100%;
      overflow: hidden; background: #0b1a18; color: #f3e6c8;
    }
    .radio-doc-pip-shell {
      position: relative; width: 100%; height: 100%;
      display: flex; align-items: stretch; justify-content: center;
      background:
        radial-gradient(ellipse at 50% 0%, rgba(47, 111, 106, 0.55), transparent 55%),
        #0b1a18;
      overflow: hidden;
    }
    .radio-doc-pip-bar {
      position: absolute; top: 0.4rem; right: 0.4rem; left: 0.4rem;
      display: flex; justify-content: flex-end; gap: 0.35rem; z-index: 40;
      pointer-events: none;
    }
    .radio-doc-pip-bar > * { pointer-events: auto; }
    .radio-doc-pip-btn {
      width: 2.35rem; height: 2.35rem; border: 0; border-radius: 0.45rem;
      background: rgba(0,0,0,0.62); color: #fff; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 1rem; box-shadow: 0 2px 8px rgba(0,0,0,0.35);
      border: 1px solid rgba(255,255,255,0.22);
    }
    .radio-doc-pip-btn:hover { background: rgba(0,0,0,0.82); }
    .radio-doc-pip-btn--fs {
      background: rgba(13,110,253,0.88);
      border-color: rgba(110,168,254,0.55);
    }
    .radio-player-panel--in-pip {
      width: 100% !important;
      max-width: none !important;
      height: 100% !important;
      margin: 0 !important;
      border-radius: 0 !important;
      box-sizing: border-box;
      overflow: auto !important;
    }
    .radio-player-panel--in-pip .radio-chrome {
      display: none !important;
    }
    .radio-player-panel--in-pip .radio-whip-antenna,
    .radio-player-panel--in-pip .radio-cabinet-handle {
      display: none !important;
    }
    .radio-doc-pip-media {
      position: absolute !important;
      width: 1px !important; height: 1px !important;
      opacity: 0 !important; pointer-events: none !important;
    }
    /* Fallback miniature World Receiver when the live panel cannot be moved */
    .radio-doc-pip-face {
      position: relative; width: 100%; height: 100%;
      display: flex; flex-direction: column; align-items: stretch;
      padding: 0.85rem 0.9rem 0.75rem; box-sizing: border-box;
      background:
        radial-gradient(ellipse at 20% 0%, rgba(255, 220, 160, 0.16), transparent 45%),
        linear-gradient(145deg, rgba(255,255,255,0.12) 0%, transparent 38%),
        repeating-linear-gradient(125deg, rgba(255,255,255,0.03) 0 2px, transparent 2px 7px),
        linear-gradient(160deg, #2f6f6a 0%, #1d4a47 48%, #123330 100%);
      color: #f3e6c8;
      font-family: Georgia, 'Times New Roman', serif;
    }
    .radio-doc-pip-brand {
      text-align: center; letter-spacing: 0.18em; text-transform: uppercase;
      margin-bottom: 0.55rem;
    }
    .radio-doc-pip-brand strong {
      display: block; font-size: 0.95rem; color: #e8c878;
      text-shadow: 0 1px 0 rgba(0,0,0,0.45);
    }
    .radio-doc-pip-brand span {
      display: block; font-size: 0.62rem; letter-spacing: 0.28em;
      color: rgba(243,230,200,0.78); margin-top: 0.15rem;
      font-family: system-ui, sans-serif;
    }
    .radio-doc-pip-screen {
      flex: 1 1 auto; min-height: 0;
      border-radius: 0.85rem;
      border: 2px solid rgba(10, 31, 29, 0.85);
      background: linear-gradient(180deg, #243039 0%, #141c22 30%, #0c1116 100%);
      box-shadow: inset 0 0 0 1px rgba(243,230,200,0.12), 0 8px 20px rgba(0,0,0,0.35);
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 0.55rem; padding: 0.75rem; position: relative; overflow: hidden;
    }
    .radio-doc-pip-dial {
      width: 88%; height: 2.1rem; border-radius: 0.35rem;
      background: linear-gradient(180deg, #1a2228, #0e1318);
      border: 1px solid rgba(212,168,75,0.35);
      position: relative; overflow: hidden;
    }
    .radio-doc-pip-dial::after {
      content: ''; position: absolute; top: 0; bottom: 0; left: 68%; width: 2px;
      background: #ffb347; box-shadow: 0 0 8px #ffb347;
    }
    .radio-doc-pip-onair {
      display: inline-flex; align-items: center; gap: 0.35rem;
      padding: 0.2rem 0.65rem; border-radius: 999px;
      background: #b42318; color: #fff; font-size: 0.68rem; font-weight: 700;
      letter-spacing: 0.08em; font-family: system-ui, sans-serif;
    }
    .radio-doc-pip-onair i {
      width: 0.45rem; height: 0.45rem; border-radius: 50%; background: #fff;
      display: inline-block; box-shadow: 0 0 6px #fff;
    }
    .radio-doc-pip-logo {
      width: min(38%, 108px); height: auto; border-radius: 0.65rem;
      background: rgba(255,255,255,0.05); box-shadow: 0 6px 18px rgba(0,0,0,0.35);
    }
    .radio-doc-pip-title {
      max-width: 92%; text-align: center; font-size: 1.05rem; font-weight: 650;
      text-shadow: 0 2px 8px rgba(0,0,0,0.55);
    }
    .radio-doc-pip-meta {
      font-size: 0.72rem; color: rgba(232,200,120,0.9);
      letter-spacing: 0.04em; font-family: system-ui, sans-serif;
    }
    body:fullscreen .radio-doc-pip-bar,
    body:-webkit-full-screen .radio-doc-pip-bar { opacity: 0.35; }
    body:fullscreen:hover .radio-doc-pip-bar,
    body:-webkit-full-screen:hover .radio-doc-pip-bar { opacity: 1; }
  `;
  doc.head.appendChild(style);
  copyStylesToPip(doc);

  const shell = doc.createElement('div');
  shell.className = 'radio-doc-pip-shell';

  const bar = doc.createElement('div');
  bar.className = 'radio-doc-pip-bar';

  const fsBtn = doc.createElement('button');
  fsBtn.type = 'button';
  fsBtn.className = 'radio-doc-pip-btn radio-doc-pip-btn--fs';
  fsBtn.title = meta.labels.fullscreen;
  fsBtn.setAttribute('aria-label', meta.labels.fullscreen);
  fsBtn.innerHTML = '<i class="fa fa-arrows-alt" aria-hidden="true"></i>';
  fsBtn.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    try {
      if (doc.fullscreenElement) {
        await doc.exitFullscreen();
      } else {
        await doc.documentElement.requestFullscreen();
      }
    } catch {
      /* blocked */
    }
  });
  doc.addEventListener('fullscreenchange', () => {
    const on = !!doc.fullscreenElement;
    fsBtn.innerHTML = on
      ? '<i class="fa fa-compress" aria-hidden="true"></i>'
      : '<i class="fa fa-arrows-alt" aria-hidden="true"></i>';
    fsBtn.title = on ? meta.labels.fullscreenExit : meta.labels.fullscreen;
    fsBtn.setAttribute('aria-label', fsBtn.title);
  });

  const closeBtn = doc.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'radio-doc-pip-btn';
  closeBtn.title = meta.labels.close;
  closeBtn.setAttribute('aria-label', meta.labels.close);
  closeBtn.innerHTML = '<i class="fa fa-times" aria-hidden="true"></i>';
  closeBtn.addEventListener('click', () => pipWindow.close());

  bar.appendChild(fsBtn);
  bar.appendChild(closeBtn);
  shell.appendChild(bar);

  if (face && face.parentNode) {
    const placeholder = document.createElement('div');
    placeholder.className = 'radio-pip-page-slot';
    placeholder.setAttribute('aria-hidden', 'true');
    placeholder.style.cssText =
      'min-height: 12rem; border-radius: 1.25rem; background: rgba(18,51,48,0.35); border: 1px dashed rgba(212,168,75,0.35); display:flex; align-items:center; justify-content:center; color: rgba(243,230,200,0.7); font-size: 0.85rem;';
    placeholder.textContent = 'PiP';
    faceHome = {
      parent: face.parentNode,
      next: face.nextSibling,
      face,
      placeholder
    };
    face.parentNode.replaceChild(placeholder, face);
    face.classList.add('radio-player-panel--in-pip');
    shell.appendChild(face);
    // Media stays inside the moved face — keep a home bookmark only if it was detached.
    if (!face.contains(video)) {
      mediaHome = {
        parent: video.parentNode as Node,
        next: video.nextSibling,
        media: video
      };
      video.classList.add('radio-doc-pip-media');
      shell.appendChild(video);
    }
  } else {
    const faceFallback = buildFallbackFace(doc, meta);
    shell.appendChild(faceFallback);
    mediaHome = {
      parent: video.parentNode as Node,
      next: video.nextSibling,
      media: video
    };
    video.classList.add('radio-doc-pip-media');
    shell.appendChild(video);
  }

  doc.body.appendChild(shell);
  video.play().catch(() => undefined);

  let tornDown = false;
  const teardown = () => {
    if (tornDown) {
      return;
    }
    tornDown = true;
    try {
      pipWindow.removeEventListener('pagehide', teardown);
    } catch {
      /* ignore */
    }
    restoreFaceHome();
    restoreMediaHome();
    activeDocPip = null;
    const onClose = meta.onClose;
    meta.onClose = undefined;
    try {
      onClose?.();
    } catch {
      /* ignore */
    }
  };

  pipWindow.addEventListener('pagehide', teardown);

  activeDocPip = {
    window: pipWindow,
    close: () => {
      try {
        if (!pipWindow.closed) {
          pipWindow.close();
        }
      } catch {
        /* ignore */
      }
      // pagehide usually already ran; guard makes a second call a no-op.
      teardown();
    }
  };
}

function buildFallbackFace(
  doc: Document,
  meta: {
    title: string;
    artworkUrl?: string | null;
    countryLabel?: string | null;
  }
): HTMLElement {
  const root = doc.createElement('div');
  root.className = 'radio-doc-pip-face';

  const brand = doc.createElement('div');
  brand.className = 'radio-doc-pip-brand';
  brand.innerHTML = '<strong>PatTool</strong><span>World Receiver</span>';
  root.appendChild(brand);

  const screen = doc.createElement('div');
  screen.className = 'radio-doc-pip-screen';

  const dial = doc.createElement('div');
  dial.className = 'radio-doc-pip-dial';
  screen.appendChild(dial);

  const onAir = doc.createElement('div');
  onAir.className = 'radio-doc-pip-onair';
  onAir.innerHTML = '<i aria-hidden="true"></i> ON AIR';
  screen.appendChild(onAir);

  if (meta.artworkUrl) {
    const img = doc.createElement('img');
    img.className = 'radio-doc-pip-logo';
    img.alt = meta.title || 'Radio';
    img.src = meta.artworkUrl;
    img.addEventListener('error', () => img.remove());
    screen.appendChild(img);
  }

  const title = doc.createElement('div');
  title.className = 'radio-doc-pip-title';
  title.textContent = meta.title || 'Radio';
  screen.appendChild(title);

  if (meta.countryLabel) {
    const metaLine = doc.createElement('div');
    metaLine.className = 'radio-doc-pip-meta';
    metaLine.textContent = meta.countryLabel;
    screen.appendChild(metaLine);
  }

  root.appendChild(screen);
  return root;
}

export function stopRadioPipCarrier(): void {
  closeRadioDocPip();
  const el = document.getElementById('pattool-radio-pip-carrier') as HTMLVideoElement | null;
  if (!el) {
    return;
  }
  try {
    el.pause();
    el.srcObject = null;
  } catch {
    /* ignore */
  }
}

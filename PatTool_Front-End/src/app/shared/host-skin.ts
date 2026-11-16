/** CSS variables a skinned page publishes on its host (`radio-skin--*` / `tv-skin--*`). */
const MENU_VARS = [
	'--menu-bg', '--menu-fg', '--menu-muted', '--menu-border', '--menu-border-width',
	'--menu-accent', '--menu-accent-fg', '--menu-toolbar', '--menu-input-bg',
	'--menu-input-fg', '--menu-input-border', '--menu-hover', '--menu-active',
	'--menu-radius', '--menu-shadow'
];

const SKIN_CLASS = /(?:^|\s)(?:radio-skin|tv-skin)--[a-z0-9-]+/;

/** The routed page, when its host carries a cabinet skin. Later siblings (floating players) are ignored. */
export function findSkinnedPageHost(): HTMLElement | null {
	const page = document.querySelector('router-outlet')?.nextElementSibling as HTMLElement | null;
	if (!page || !SKIN_CLASS.test(page.className || '')) {
		return null;
	}
	if (!getComputedStyle(page).getPropertyValue('--menu-bg').trim()) {
		return null;
	}
	return page;
}

/**
 * Copy the page skin onto a modal that ng-bootstrap attaches to `body`
 * (it would otherwise lose the host variables).
 */
export function paintModalFromHost(modal: HTMLElement, source: HTMLElement, marker: string): void {
	const style = getComputedStyle(source);
	for (const name of MENU_VARS) {
		const value = style.getPropertyValue(name).trim();
		if (value) {
			modal.style.setProperty(name, value);
		}
	}
	const toolbar = style.getPropertyValue('--menu-toolbar').trim();
	const bg = style.getPropertyValue('--menu-bg').trim();
	const fg = style.getPropertyValue('--menu-fg').trim();
	const border = style.getPropertyValue('--menu-border').trim();
	const inputBg = style.getPropertyValue('--menu-input-bg').trim();
	const hover = style.getPropertyValue('--menu-hover').trim();
	const header = opaqueHeaderPaint(toolbar, bg);
	modal.style.setProperty('--slideshow-header-solid', header.solid);
	modal.style.setProperty('--slideshow-header-image', header.image);
	modal.style.setProperty('--slideshow-header-bg', toolbar || header.solid);
	if (fg) {
		modal.style.setProperty('--slideshow-header-text', fg);
		modal.style.setProperty('--slideshow-button-text', fg);
		modal.style.setProperty('--slideshow-footer-button-text', fg);
		modal.style.setProperty('--videoshow-ink', fg);
	}
	if (bg) {
		modal.style.setProperty('--slideshow-footer-bg', bg);
		modal.style.setProperty('--tv-modal-body-bg', bg);
	}
	if (border) {
		modal.style.setProperty('--slideshow-border', border);
		modal.style.setProperty('--slideshow-footer-border', border);
		modal.style.setProperty('--slideshow-button-border', border);
		modal.style.setProperty('--slideshow-footer-button-border', border);
	}
	if (inputBg) {
		modal.style.setProperty('--slideshow-footer-button-bg', inputBg);
	}
	if (hover) {
		modal.style.setProperty('--slideshow-button-hover-bg', hover);
		modal.style.setProperty('--slideshow-footer-button-hover-bg', hover);
	}
	modal.classList.add(marker);
}

/** Paint a viewer that is already opening, retrying until ng-bootstrap has inserted it. */
export function paintOpenViewerFromPage(contentSelector: string, marker: string): void {
	const source = findSkinnedPageHost();
	if (!source) {
		return;
	}
	const paint = (attempt = 0): void => {
		const modal = document.querySelector(contentSelector) as HTMLElement | null;
		if (!modal) {
			if (attempt < 8) {
				setTimeout(() => paint(attempt + 1), 60);
			}
			return;
		}
		paintModalFromHost(modal, source, marker);
	};
	paint();
}

function opaqueHeaderPaint(toolbar: string, bg: string): { solid: string; image: string } {
	const solid = firstOpaqueColor(toolbar) || firstOpaqueColor(bg) || '#1c1612';
	if (!toolbar || (isPlainCssColor(toolbar) && !colorHasAlpha(toolbar))) {
		return { solid: isPlainCssColor(toolbar) ? toolbar : solid, image: 'none' };
	}
	const image = isPlainCssColor(toolbar) ? `linear-gradient(${toolbar}, ${toolbar})` : toolbar;
	return { solid, image };
}

function isPlainCssColor(value: string): boolean {
	return !!value && !/gradient\(|url\(|image\(/i.test(value);
}

function colorHasAlpha(value: string): boolean {
	const v = value.trim();
	if (/^transparent$/i.test(v)) {
		return true;
	}
	const hex = v.match(/^#([0-9a-f]{4}|[0-9a-f]{8})$/i);
	if (hex) {
		const alpha = hex[1].length === 4 ? hex[1].charAt(3) : hex[1].slice(6);
		return !/^f+$/i.test(alpha);
	}
	const slash = v.match(/\/\s*([0-9.]+%?)/);
	if (slash) {
		return !alphaIsOpaque(slash[1]);
	}
	if (/rgba|hsla/i.test(v)) {
		const parts = v.match(/[\d.]+%?/g) || [];
		return parts.length < 4 || !alphaIsOpaque(parts[3]);
	}
	return false;
}

function alphaIsOpaque(token: string): boolean {
	if (token.endsWith('%')) {
		return parseFloat(token) >= 100;
	}
	return parseFloat(token) >= 1;
}

function firstOpaqueColor(value: string): string {
	if (!value) {
		return '';
	}
	if (isPlainCssColor(value)) {
		return colorHasAlpha(value) ? '' : value.trim();
	}
	const tokens = value.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi) || [];
	for (let i = tokens.length - 1; i >= 0; i--) {
		if (!colorHasAlpha(tokens[i])) {
			return tokens[i];
		}
	}
	return '';
}

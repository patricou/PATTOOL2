/**
 * Turns note text into HTML where web links are real anchors.
 * Every other character is escaped, so pasted markup cannot run.
 */

const ANCHOR_RE = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function decodeBasicEntities(value: string): string {
    return value
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>');
}

/** Accept only http(s) targets. Anything else stays plain text. */
function safeHttpHref(raw: string): string | null {
    let href = decodeBasicEntities(raw).trim();
    if (!href) {
        return null;
    }
    if (/^www\./i.test(href)) {
        href = `https://${href}`;
    }
    try {
        const parsed = new URL(href);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return null;
        }
        return parsed.href;
    } catch {
        return null;
    }
}

function anchorHtml(href: string, label: string): string {
    const text = label.trim() || href;
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`;
}

function splitTrailingPunctuation(url: string): [string, string] {
    let core = url;
    let trail = '';
    while (core.length > 0 && /[.,;:!?]$/.test(core)) {
        trail = core.slice(-1) + trail;
        core = core.slice(0, -1);
    }
    while (core.endsWith(')') && (core.match(/\(/g) || []).length < (core.match(/\)/g) || []).length) {
        trail = ')' + trail;
        core = core.slice(0, -1);
    }
    return [core, trail];
}

function linkifyPlain(text: string): string {
    let html = '';
    let last = 0;
    const re = new RegExp(URL_RE.source, 'gi');
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
        html += escapeHtml(text.slice(last, match.index));
        const [core, trail] = splitTrailingPunctuation(match[0]);
        const href = safeHttpHref(core);
        if (href) {
            html += anchorHtml(href, core) + escapeHtml(trail);
        } else {
            html += escapeHtml(match[0]);
        }
        last = match.index + match[0].length;
    }
    html += escapeHtml(text.slice(last));
    return html;
}

export function linkifyNoteContent(content: string | null | undefined): string {
    return sanitizeNoteContent(content);
}

/** Stored note body: safe formatting only, or null when there is no text. */
export function storedNoteContent(content: string | null | undefined): string | null {
    const clean = sanitizeNoteContent(content);
    return noteContentIsBlank(clean) ? null : clean;
}

export function noteContentIsBlank(content: string | null | undefined): boolean {
    const rendered = sanitizeNoteContent(content);
    const text = rendered
        .replace(/<br\s*\/?>/gi, '')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .trim();
    return text.length === 0;
}

/**
 * Keeps a small formatting set (bold, italic, underline, lists, line breaks, http links)
 * and escapes everything else. Plain notes stay plain text with line breaks.
 */
export function sanitizeNoteContent(content: string | null | undefined): string {
    const source = content ?? '';
    if (!source.trim()) {
        return '';
    }
    if (typeof DOMParser === 'undefined') {
        return linkifyLegacy(source).replace(/\n/g, '<br>');
    }
    const looksFormatted = /<\s*\/?\s*(?:b|strong|i|em|u|ul|ol|li|br|p|div|a)\b/i.test(source);
    const html = looksFormatted ? source : escapeHtml(source).replace(/\n/g, '<br>');
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
    const root = doc.body.firstElementChild;
    if (!root) {
        return '';
    }
    const out = Array.from(root.childNodes).map(node => serializeNode(node)).join('');
    return out.replace(/(?:<br>)+$/i, '');
}

function serializeNode(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
        return linkifyPlain(node.textContent ?? '').replace(/\n/g, '<br>');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
        return '';
    }
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (tag === 'br') {
        return '<br>';
    }
    if (tag === 'a') {
        const href = safeHttpHref(el.getAttribute('href') || '');
        const label = el.textContent || '';
        return href ? anchorHtml(href, label) : linkifyPlain(label);
    }
    if (tag === 'ul' || tag === 'ol') {
        const items = Array.from(el.children)
            .filter(child => child.tagName.toLowerCase() === 'li')
            .map(li => {
                const inner = Array.from(li.childNodes).map(child => serializeNode(child)).join('').replace(/(?:<br>)+$/i, '');
                return `<li>${inner}</li>`;
            })
            .join('');
        return items ? `<${tag}>${items}</${tag}>` : '';
    }
    const inner = Array.from(el.childNodes).map(child => serializeNode(child)).join('');
    if (tag === 'b' || tag === 'strong') {
        return inner ? `<b>${inner}</b>` : '';
    }
    if (tag === 'i' || tag === 'em') {
        return inner ? `<i>${inner}</i>` : '';
    }
    if (tag === 'u') {
        return inner ? `<u>${inner}</u>` : '';
    }
    if (tag === 'p' || tag === 'div' || tag === 'li') {
        if (!inner || inner === '<br>') {
            return '<br>';
        }
        return inner.endsWith('<br>') ? inner : `${inner}<br>`;
    }
    return inner;
}

function linkifyLegacy(source: string): string {
    let html = '';
    let last = 0;
    const re = new RegExp(ANCHOR_RE.source, 'gi');
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
        html += linkifyPlain(source.slice(last, match.index));
        const href = safeHttpHref(match[1] ?? match[2] ?? '');
        const label = (match[3] ?? '').replace(/<[^>]+>/g, '');
        if (href) {
            html += anchorHtml(href, decodeBasicEntities(label));
        } else {
            html += escapeHtml(match[0]);
        }
        last = match.index + match[0].length;
    }
    html += linkifyPlain(source.slice(last));
    return html;
}

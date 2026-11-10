import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { readMediaSkin } from './media-skin';

const SKIN_VARS = [
	'--menu-bg',
	'--menu-fg',
	'--menu-muted',
	'--menu-border',
	'--menu-border-width',
	'--menu-accent',
	'--menu-accent-fg',
	'--menu-toolbar',
	'--menu-input-bg',
	'--menu-input-fg',
	'--menu-input-border',
	'--menu-hover',
	'--menu-active',
	'--menu-meta-bg',
	'--menu-shadow',
	'--menu-radius',
	'--menu-logo-bg',
	'--pat-title-bg',
	'--pat-title-pattern',
	'--pat-title-accent',
	'--pat-title-shadow',
	'--title-btn-bg',
	'--title-btn-fg',
	'--title-btn-border',
	'--title-btn-hover-bg',
	'--title-btn-active-bg',
	'--title-btn-active-fg'
] as const;

/** Opens « Vos informations » from the home title, with the active cabinet skin. */
@Injectable({ providedIn: 'root' })
export class UserInfoModalService {
	private readonly openRequests = new Subject<boolean>();
	readonly open$ = this.openRequests.asObservable();

	/** Home-title entry: same dialog, skinned. The navbar title stays unskinned. */
	open(): void {
		this.openRequests.next(true);
	}

	/** Copy the active cabinet skin onto the open user-info dialog (it is outside the page host). */
	paint(): void {
		const target = document.querySelector('.user-info-modal-window .user-modal-container--skin');
		if (!(target instanceof HTMLElement)) {
			return;
		}
		const fromHost = this.tokensFromHost();
		const tokens = Object.keys(fromHost).length ? fromHost : this.tokensFromStylesheet(readMediaSkin() ?? 'classic');
		for (const name of SKIN_VARS) {
			const value = tokens[name];
			if (value) {
				target.style.setProperty(name, value);
			}
		}
		if (tokens['color-scheme']) {
			target.style.colorScheme = tokens['color-scheme'];
		}
	}

	private tokensFromHost(): Record<string, string> {
		const nodes = document.querySelectorAll('app-home-page, app-radio-watcher, app-deezer-watcher');
		for (const node of Array.from(nodes)) {
			if (!(node instanceof HTMLElement)) {
				continue;
			}
			const style = getComputedStyle(node);
			if (!style.getPropertyValue('--menu-fg').trim()) {
				continue;
			}
			const tokens: Record<string, string> = {};
			for (const name of SKIN_VARS) {
				const value = style.getPropertyValue(name).trim();
				if (value) {
					tokens[name] = value;
				}
			}
			const scheme = style.colorScheme?.trim();
			if (scheme && scheme !== 'normal') {
				tokens['color-scheme'] = scheme;
			}
			return tokens;
		}
		return {};
	}

	private tokensFromStylesheet(skin: string): Record<string, string> {
		const needle = `radio-skin--${skin}`;
		const tokens: Record<string, string> = {};
		for (const sheet of Array.from(document.styleSheets)) {
			let rules: CSSRuleList;
			try {
				rules = sheet.cssRules;
			} catch {
				continue;
			}
			this.collectTokens(rules, needle, tokens);
		}
		return tokens;
	}

	private collectTokens(rules: CSSRuleList, needle: string, tokens: Record<string, string>): void {
		for (let i = 0; i < rules.length; i++) {
			const rule = rules[i];
			if (rule instanceof CSSStyleRule) {
				if (!rule.selectorText.includes(needle)) {
					continue;
				}
				for (const name of SKIN_VARS) {
					const value = rule.style.getPropertyValue(name).trim();
					if (value) {
						tokens[name] = value;
					}
				}
				const scheme = rule.style.getPropertyValue('color-scheme').trim();
				if (scheme) {
					tokens['color-scheme'] = scheme;
				}
			} else if (rule instanceof CSSMediaRule) {
				continue;
			} else if (typeof CSSGroupingRule !== 'undefined' && rule instanceof CSSGroupingRule && rule.cssRules) {
				this.collectTokens(rule.cssRules, needle, tokens);
			}
		}
	}
}

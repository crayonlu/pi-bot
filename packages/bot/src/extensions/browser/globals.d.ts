/**
 * Minimal DOM declarations for Playwright evaluate() callbacks.
 *
 * These callbacks execute in the browser context where document/HTMLElement exist.
 * This file provides just enough types to satisfy the compiler without adding
 * the full "dom" lib (which would also affect Node.js code).
 */

export {};

declare global {
	var document: {
		body: HTMLElement | null;
		querySelectorAll(selector: string): NodeListOf<HTMLElement>;
	};

	class HTMLElement {
		cloneNode(deep?: boolean): HTMLElement;
		innerText: string;
		querySelectorAll(selector: string): NodeListOf<HTMLElement>;
		remove(): void;
	}

	interface NodeListOf<T> {
		forEach(callback: (value: T) => void): void;
		[Symbol.iterator](): IterableIterator<T>;
	}
}

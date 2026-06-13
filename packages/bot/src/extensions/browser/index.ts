/**
 * Browser tool extension: headless Chromium via Playwright.
 *
 * Provides a single `browser` tool with actions:
 *   goto        — navigate to URL, return page text
 *   screenshot  — capture page or element, return base64 PNG
 *   text        — extract text content from selector
 *   click       — click an element
 *   fill        — fill an input field
 *   evaluate    — execute JavaScript in the page
 *
 * A single browser context is shared across the session.
 * Pages are reused — navigating to a new URL reuses the same tab.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Browser, chromium, type Page } from "playwright";
import { Type } from "typebox";

let browser: Browser | undefined;
let page: Page | undefined;

async function getPage(): Promise<Page> {
	if (!browser) {
		browser = await chromium.launch({ headless: true, timeout: 30_000 });
	}
	if (!page || page.isClosed()) {
		const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
		const context = await browser.newContext({
			viewport: { width: 1280, height: 720 },
			userAgent:
				"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
			...(proxy ? { proxy: { server: proxy } } : {}),
		});
		page = await context.newPage();
	}
	return page;
}

async function cleanup(): Promise<void> {
	if (!browser) return;
	try {
		await browser.close();
	} catch {
		// Browser already dead — fine
	}
	browser = undefined;
	page = undefined;
}

export default function browserExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "browser",
		label: "Browser",
		description:
			"Control a headless Chromium browser. Actions: goto (navigate + return text), screenshot (capture page), text (extract text), click (click element), fill (fill input), evaluate (run JS).",
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("goto"),
					Type.Literal("screenshot"),
					Type.Literal("text"),
					Type.Literal("click"),
					Type.Literal("fill"),
					Type.Literal("evaluate"),
				],
				{ description: "Browser action to perform" },
			),
			url: Type.Optional(Type.String({ description: "URL to navigate to (for goto)" })),
			selector: Type.Optional(Type.String({ description: "CSS selector for the target element" })),
			value: Type.Optional(Type.String({ description: "Value to fill into an input (for fill)" })),
			script: Type.Optional(Type.String({ description: "JavaScript to evaluate (for evaluate)" })),
		}),
		execute: async (_toolCallId, params) => {
			console.log(`[browser] action=${params.action}`);
			try {
				const result = await executeAction(params);
				return {
					content: [{ type: "text" as const, text: result }],
					details: { action: params.action, success: true },
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `Browser error: ${msg}` }],
					details: { action: params.action, success: false },
				};
			}
		},
	});

	pi.on("session_shutdown", () => {
		void cleanup();
	});
}

interface BrowserParams {
	action: string;
	url?: string;
	selector?: string;
	value?: string;
	script?: string;
}

async function executeAction(params: BrowserParams): Promise<string> {
	const p = await getPage();

	switch (params.action) {
		case "goto": {
			if (!params.url) return "Error: url is required for goto";
			const resp = await p.goto(params.url, { waitUntil: "domcontentloaded", timeout: 15_000 });
			const status = resp?.status() ?? 0;
			const title = await p.title();
			const text = await extractPageText(p);
			return `[${status}] ${title}\n\n${truncate(text, 4000)}`;
		}

		case "screenshot": {
			if (params.selector) {
				const el = p.locator(params.selector);
				await el.waitFor({ timeout: 5000 });
				const buf = await el.screenshot({ type: "png" });
				return `[screenshot:${params.selector}] data:image/png;base64,${buf.toString("base64")}`;
			}
			const buf = await p.screenshot({ type: "png" });
			return `[screenshot] data:image/png;base64,${buf.toString("base64")}`;
		}

		case "text": {
			if (!params.selector) return "Error: selector is required for text";
			const el = p.locator(params.selector);
			await el.first().waitFor({ timeout: 5000 });
			const text = await el.first().innerText();
			return truncate(text, 4000);
		}

		case "click": {
			if (!params.selector) return "Error: selector is required for click";
			const el = p.locator(params.selector);
			await el.first().click({ timeout: 5000 });
			return `Clicked: ${params.selector}`;
		}

		case "fill": {
			if (!params.selector) return "Error: selector is required for fill";
			if (params.value === undefined) return "Error: value is required for fill";
			const el = p.locator(params.selector);
			await el.first().fill(params.value, { timeout: 5000 });
			return `Filled ${params.selector} with: ${params.value}`;
		}

		case "evaluate": {
			if (!params.script) return "Error: script is required for evaluate";
			const result = await p.evaluate(params.script);
			return truncate(JSON.stringify(result, null, 2), 4000);
		}

		default:
			return `Error: unknown action "${params.action}"`;
	}
}

/** Extract visible text from the page, stripping script/style/nav elements */
async function extractPageText(p: Page): Promise<string> {
	return p.evaluate(() => {
		if (!document.body) return "";
		const clone = document.body.cloneNode(true) as HTMLElement;
		for (const sel of ["script", "style", "nav", "footer", "header", "noscript"]) {
			for (const el of clone.querySelectorAll(sel)) el.remove();
		}
		return (clone.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim();
	});
}

function truncate(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max)}\n\n[truncated ${s.length - max} chars]`;
}

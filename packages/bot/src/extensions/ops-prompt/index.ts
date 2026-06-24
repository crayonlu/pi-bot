/**
 * System prompt builder: persona + auto-injected platform context.
 *
 * The user's persona defines identity, tone, and thinking style.
 * We inject operational context that every bot needs:
 *   - Environment (hostname, OS, workspace)
 *   - Available tools
 *   - Memory system
 *   - Safety rules
 *   - Telegram constraints
 *
 * pi's default coding-agent prompt is discarded — the persona + platform
 * context fully replaces it.
 */

import { hostname, type } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BotConfig } from "../../config.ts";

export default function personaPromptExtension(pi: ExtensionAPI, config: BotConfig): void {
	let isImageModel = false;

	pi.on("before_agent_start", async (event) => {
		console.log("[ops-prompt] before_agent_start start");
		if (!config.setupComplete || !config.persona) {
			console.log(
				"[ops-prompt] skip: setupComplete=",
				config.setupComplete,
				"persona length=",
				config.persona?.length,
			);
			return;
		}

		try {
			// Auto-switch model: MiMo for images, DeepSeek V4 Flash for text
			const hasImages = event.images && event.images.length > 0;
			console.log("[ops-prompt] hasImages=", hasImages, "isImageModel=", isImageModel);
			if (hasImages && !isImageModel) {
				await pi.setModel({ provider: "ppio", id: "xiaomimimo/mimo-v2.5" } as Parameters<typeof pi.setModel>[0]);
				isImageModel = true;
			} else if (!hasImages && isImageModel) {
				await pi.setModel({ provider: "ppio", id: "deepseek/deepseek-v4-flash" } as Parameters<
					typeof pi.setModel
				>[0]);
				isImageModel = false;
			}
		} catch (e) {
			console.error("[ops-prompt] setModel failed:", (e as Error).message);
		}

		// Keep pi's built-in system prompt (tool schemas, formats) and prepend persona + platform context.
		const platform = buildPlatformContext();
		const combined = `${config.persona}\n\n${platform}\n\n${event.systemPrompt}`;
		console.log("[ops-prompt] system prompt length:", combined.length);
		return { systemPrompt: combined };
	});
}

function buildPlatformContext(): string {
	const sections: string[] = [];

	sections.push("---");
	sections.push("");
	sections.push("## Environment");
	sections.push(`Host: ${hostname()}`);
	sections.push(`OS: ${type()} (Linux)`);
	sections.push(`Workspace: /workspace/ (persistent, survives restarts)`);
	sections.push("");

	sections.push("## Communication");
	sections.push("You are a Telegram bot.");
	sections.push("- Casual speech: plain text, no markdown. Talk to 先生 naturally.");
	sections.push(
		"- Structured/formatted output (tables, code, reports): send via `reply` tool, which supports Telegram MarkdownV2.",
	);
	sections.push(
		"- MarkdownV2 (only inside `reply` text): *bold*, _italic_, ~strikethrough~, ||spoiler||, `code`, ```code block```, [link text](URL).",
	);
	sections.push("- NOT supported: headings, tables, blockquotes, underlines.");
	sections.push("- Escape MarkdownV2 special chars: \\* \\_ \\~ \\` \\[ \\] \\( \\).");
	sections.push("");
	sections.push("## Message Segmentation");
	sections.push("- Your final reply is sent as one message when you finish. Telegram auto-splits at 4000 chars.");
	sections.push("- For long or multi-part responses, use `reply` tool to send segments at natural break points.");
	sections.push(
		"- Use `reply` when: the response is very long, you want to show progress mid-work, or you have multiple distinct points to make.",
	);
	sections.push("");
	sections.push("## Images");
	sections.push("- Capture webpages with `agent_browser` (screenshot action saves to a file path).");
	sections.push('- Send images: `reply({ image: "..." })` — accepts a local file path, URL, or base64 data URL.');
	sections.push(
		"- For images 先生 sends you, investigate programmatically with `bash`/`ctx_execute` (download, PIL, tesseract OCR).",
	);
	sections.push("");
	sections.push("");

	sections.push("## Tools");
	sections.push("- bash: execute shell commands on the server (full access).");
	sections.push("- read / write / edit / grep / find / ls: read, create, edit, and search files.");
	sections.push(
		"- agent_browser: open web pages, take snapshots, read content, click, fill forms, take screenshots. Use this for web search, reading docs, and any web task.",
	);
	sections.push(
		"- ctx_execute / ctx_execute_file: run Python/JS/shell code in a sandbox to analyze logs, parse JSON/API responses, transform data. Prefer these over pasting large output into your reply.",
	);
	sections.push(
		"- ctx_search / ctx_index / ctx_batch_execute / ctx_fetch_and_index / ctx_stats: searchable knowledge base — index docs/logs and query them later without re-reading raw bytes.",
	);
	sections.push(
		"- preview_export: render Markdown/LaTeX/a file to PNG/PDF/HTML, then send the artifact via `reply({ image })`.",
	);
	sections.push(
		"- process: start, monitor, and kill long-running commands (dev servers, log tails, watchers) in the background instead of raw bash &.",
	);
	sections.push("- todo: track multi-step work as a task list.");
	sections.push(
		"- reply: send text or images to the user via Telegram. Use for results, confirmation prompts, progress, and screenshots.",
	);
	sections.push("");

	sections.push("## Memory");
	sections.push("Persistent memory is stored at /workspace/memory.md.");
	sections.push("- Read it at session start to recall past conversations.");
	sections.push("- Update it after meaningful conversations.");
	sections.push("- Keep entries concise: date, topic, key decisions.");
	sections.push("");

	sections.push("## Safety");
	sections.push("- Never expose API keys, passwords, tokens, or secrets.");
	sections.push("- Before destructive operations (rm -rf, service restart, etc.),");
	sections.push("  use the reply tool to explain what you will do and ask for confirmation.");
	sections.push("- If the user sends a command to run, assess risk before executing.");
	sections.push("");

	return sections.join("\n");
}

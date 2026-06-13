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
		if (!config.setupComplete || !config.persona) return;

		// Auto-switch model: MiMo for images, DeepSeek V4 Flash for text
		const hasImages = event.images && event.images.length > 0;
		if (hasImages && !isImageModel) {
			await pi.setModel({ provider: "ppio", id: "xiaomimimo/mimo-v2.5" } as Parameters<typeof pi.setModel>[0]);
			isImageModel = true;
		} else if (!hasImages && isImageModel) {
			await pi.setModel({ provider: "ppio", id: "deepseek/deepseek-v4-flash" } as Parameters<typeof pi.setModel>[0]);
			isImageModel = false;
		}

		const platform = buildPlatformContext();
		return { systemPrompt: `${config.persona}\n\n${platform}` };
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
	sections.push("You are a Telegram bot. The user sends you messages; you reply via the agent loop.");
	sections.push("- Telegram message limit: ~4000 characters. Split long messages automatically.");
	sections.push("- Markdown is supported (bold, italic, code fences, links).");
	sections.push("- To send an image: first use `browser` tool with action `screenshot` to capture, then call `reply({ image: \"data:image/png;base64,...\" })` to send the image to the user.");
	sections.push("- Use `reply` tool to send standalone text messages to the user.");
	sections.push("");

	sections.push("## Tools");
	sections.push("- bash: execute shell commands on the server (full root access)");
	sections.push("- read: read files");
	sections.push("- write: create or overwrite files");
	sections.push("- edit: surgical text edits");
	sections.push("- grep: regex search across files");
	sections.push("- find: file globbing");
	sections.push("- ls: list directory contents");
	sections.push("- browser: navigate web pages, take screenshots, extract text, click, fill forms");
	sections.push(
		"- reply: send messages or images (base64 data URLs from browser screenshots) to the user via Telegram",
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

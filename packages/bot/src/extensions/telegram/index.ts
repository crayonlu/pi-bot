/**
 * Telegram channel extension for pi-bot.
 *
 * Bridges a Telegram bot to a pi agent session with:
 * - Setup wizard for first-time configuration
 * - Real-time progress card (terminal-style)
 * - Reply tool for agent → user messaging
 * - /config, /status, /abort, /help commands
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BotConfig } from "../../config.ts";
import { isAllowedUser } from "../../config.ts";
import { TelegramBot } from "./bot.ts";
import { createEventBridge } from "./event-bridge.ts";
import { ProgressCard } from "./progress-card.ts";
import { registerReplyTool } from "./reply-tool.ts";
import { SetupWizard } from "./setup-wizard.ts";

export interface TelegramExtensionOptions {
	config: BotConfig;
	onAbort?: () => void;
	onNew?: () => void;
	onCompact?: () => void;
}

export default function telegramExtension(pi: ExtensionAPI, options: TelegramExtensionOptions): void {
	const { config, onAbort, onNew, onCompact } = options;
	const token = process.env.TELEGRAM_BOT_TOKEN;
	if (!token) {
		console.error("[telegram] TELEGRAM_BOT_TOKEN not set, extension disabled");
		return;
	}

	const bot = new TelegramBot(token);
	const card = new ProgressCard(2000, (chatId, messageId, text) => bot.editMessage(chatId, messageId, text));
	const eventBridge = createEventBridge(card, { showToolDetails: true, showTokenUsage: true });

	let currentChatId: number | undefined;
	let isAgentBusy = false;

	const wizard = new SetupWizard(bot, config, (updatedConfig) => {
		Object.assign(config, updatedConfig);
	});

	// ─── Reply tool ──────────────────────────────────────────────────────

	registerReplyTool(pi, { bot, getChatId: () => currentChatId });

	// ─── Commands ────────────────────────────────────────────────────────

	const COMMANDS: Record<string, (chatId: number, args: string) => Promise<void>> = {
		"/start": async (chatId) => {
			if (!config.setupComplete) await wizard.start(chatId);
			else await bot.sendMessage(chatId, "Ready. Send a message to start.\n/config to reconfigure.");
		},
		"/config": async (chatId) => {
			await wizard.start(chatId);
		},
		"/abort": async (chatId) => {
			if (isAgentBusy) {
				onAbort?.();
				await bot.sendMessage(chatId, "Aborted.");
			} else {
				await bot.sendMessage(chatId, "Nothing running.");
			}
		},
		"/new": async (chatId) => {
			onNew?.();
			await bot.sendMessage(chatId, "Starting fresh session.");
		},
		"/compact": async (chatId) => {
			if (isAgentBusy) {
				await bot.sendMessage(chatId, "Agent is busy. Try again when idle.");
			} else {
				onCompact?.();
				await bot.sendMessage(chatId, "Compacting context...");
			}
		},
		"/status": async (chatId) => {
			await bot.sendMessage(chatId, `Status: ${isAgentBusy ? "busy" : "idle"}`);
		},
		"/help": async (chatId) => {
			await bot.sendMessage(
				chatId,
				[
					"Commands:",
					"/start    - Configure persona",
					"/config   - Change persona",
					"/abort    - Abort current task",
					"/new      - Start fresh session",
					"/compact  - Compress conversation context",
					"/status   - Show session status",
					"/help     - Show this message",
					"",
					"Or just send a message to start.",
				].join("\n"),
			);
		},
	};

	// ─── Message handler ─────────────────────────────────────────────────

	bot.onMessage(async (msg) => {
		if (!msg.userId || !isAllowedUser(config, msg.userId)) return;
		currentChatId = msg.chatId;

		if (wizard.active) {
			if (msg.text) await wizard.handleMessage(msg.chatId, msg.text);
			return;
		}

		if (!config.setupComplete) {
			await wizard.start(msg.chatId);
			return;
		}

		if (!msg.text) {
			if (msg.photo && msg.photo.length > 0) {
				const largest = msg.photo[msg.photo.length - 1];
				try {
					const dataUrl = await bot.downloadFile(largest.file_id);
					const parsed = parseDataUrl(dataUrl);
					if (!parsed) {
						await bot.sendMessage(msg.chatId, "Failed to process image.");
						return;
					}
					const caption = msg.caption || "Analyze this image";
					pi.sendUserMessage(
						[
							{ type: "text" as const, text: caption },
							{ type: "image" as const, data: parsed.data, mimeType: parsed.mimeType },
						],
						isAgentBusy ? { deliverAs: "followUp" } : undefined,
					);
					await startProgressCard(msg.chatId);
				} catch {
					await bot.sendMessage(msg.chatId, "Failed to download image.");
				}
			}
			return;
		}

		const text = msg.text.trim();
		if (!text) return;

		const command = text.split(/\s/)[0]?.toLowerCase();
		if (command && command in COMMANDS) {
			await COMMANDS[command](msg.chatId, text.slice(command.length).trim());
			return;
		}

		if (isAgentBusy) {
			pi.sendUserMessage(text, { deliverAs: "followUp" });
			await bot.sendMessage(msg.chatId, "Queued (agent is busy).");
		} else {
			pi.sendUserMessage(text);
			await startProgressCard(msg.chatId);
		}
	});

	// ─── Progress card lifecycle ─────────────────────────────────────────

	async function startProgressCard(chatId: number): Promise<void> {
		try {
			isAgentBusy = true;
			const messageId = await bot.sendMessage(chatId, "\u25B8 Working...");
			card.init(chatId, messageId);
		} catch (err) {
			isAgentBusy = false;
			console.error("[telegram] failed to create progress card:", err instanceof Error ? err.message : err);
		}
	}

	// ─── Session event handlers ──────────────────────────────────────────

	pi.on("agent_start", () => {
		isAgentBusy = true;
	});

	pi.on("message_update", (event) => {
		eventBridge(event as unknown as Record<string, unknown>);
	});

	pi.on("message_end", (event) => {
		eventBridge(event as unknown as Record<string, unknown>);
	});

	pi.on("tool_execution_start", (event) => {
		eventBridge(event as unknown as Record<string, unknown>);
	});

	pi.on("tool_execution_end", (event) => {
		eventBridge(event as unknown as Record<string, unknown>);
	});

	pi.on("turn_end", (event) => {
		eventBridge(event as unknown as Record<string, unknown>);
	});

	pi.on("agent_end", (event) => {
		const e = event as unknown as { messages?: Array<{ role?: string; stopReason?: string }> };
		const lastMsg = e.messages?.at(-1);
		if (lastMsg?.role === "assistant" && lastMsg.stopReason === "error") {
			void card.markError("Agent stopped with an error.");
		} else {
			void card.markDone();
		}
		isAgentBusy = false;
	});

	pi.on("session_shutdown", () => {
		bot.stop();
		// Don't reset card immediately — let in-flight markDone complete
		setTimeout(() => card.reset(), 5000);
	});

	// ─── Start ───────────────────────────────────────────────────────────

	bot.start().catch((err) => {
		console.error("[telegram] failed to start:", err instanceof Error ? err.message : err);
	});
}

// ─── Helpers ──────────────────────────────────────────────────────────────

interface ParsedDataUrl {
	mimeType: string;
	data: string;
}

function parseDataUrl(dataUrl: string): ParsedDataUrl | undefined {
	const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
	if (!match || !match[2]) return undefined;
	return { mimeType: match[1], data: match[2] };
}

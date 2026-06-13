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
		console.error("[telegram] TELEGRAM_BOT_TOKEN not set");
		return;
	}

	console.log("[telegram] init");
	const bot = new TelegramBot(token);
	const card = new ProgressCard(2000, (chatId, messageId, text) => bot.editMessage(chatId, messageId, text));
	const eventBridge = createEventBridge(card, { showToolDetails: true, showTokenUsage: true });

	let currentChatId: number | undefined;
	let isAgentBusy = false;

	const wizard = new SetupWizard(bot, config, (updatedConfig) => {
		Object.assign(config, updatedConfig);
	});

	registerReplyTool(pi, { bot, getChatId: () => currentChatId });

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
			} else await bot.sendMessage(chatId, "Nothing running.");
		},
		"/new": async (chatId) => {
			onNew?.();
			await bot.sendMessage(chatId, "Fresh session.");
		},
		"/compact": async (chatId) => {
			if (isAgentBusy) await bot.sendMessage(chatId, "Busy.");
			else {
				onCompact?.();
				await bot.sendMessage(chatId, "Compacting...");
			}
		},
		"/status": async (chatId) => {
			await bot.sendMessage(chatId, `Status: ${isAgentBusy ? "busy" : "idle"}`);
		},
		"/help": async (chatId) => {
			await bot.sendMessage(chatId, "/start /config /abort /new /compact /status /help");
		},
	};

	bot.onMessage(async (msg) => {
		console.log("[telegram] message from=", msg.userId, "text=", msg.text?.slice(0, 40));
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
			if (msg.photo?.length) {
				const largest = msg.photo[msg.photo.length - 1];
				try {
					const dataUrl = await bot.downloadFile(largest.file_id);
					const parsed = parseDataUrl(dataUrl);
					if (!parsed) {
						await bot.sendMessage(msg.chatId, "Image fail.");
						return;
					}
					pi.sendUserMessage(
						[
							{ type: "text" as const, text: msg.caption || "Analyze" },
							{ type: "image" as const, data: parsed.data, mimeType: parsed.mimeType },
						],
						isAgentBusy ? { deliverAs: "followUp" } : undefined,
					);
					await startProgressCard(msg.chatId);
				} catch {
					await bot.sendMessage(msg.chatId, "Download fail.");
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
			await bot.sendMessage(msg.chatId, "Queued.");
		} else {
			pi.sendUserMessage(text);
			await startProgressCard(msg.chatId);
		}
	});

	async function startProgressCard(chatId: number): Promise<void> {
		try {
			isAgentBusy = true;
			const mid = await bot.sendMessage(chatId, "\u25B8 Working...");
			card.init(chatId, mid);
		} catch {
			isAgentBusy = false;
		}
	}

	pi.on("agent_start", () => {
		isAgentBusy = true;
	});
	pi.on("message_update", (e) => {
		eventBridge(e as unknown as Record<string, unknown>);
	});
	pi.on("message_end", (e) => {
		eventBridge(e as unknown as Record<string, unknown>);
	});
	pi.on("tool_execution_start", (e) => {
		eventBridge(e as unknown as Record<string, unknown>);
	});
	pi.on("tool_execution_end", (e) => {
		eventBridge(e as unknown as Record<string, unknown>);
	});
	pi.on("turn_end", (e) => {
		eventBridge(e as unknown as Record<string, unknown>);
	});
	pi.on("agent_end", (event) => {
		const e = event as unknown as { messages?: Array<{ role?: string; stopReason?: string }> };
		if (e.messages?.at(-1)?.stopReason === "error") card.markError("Error.");
		else card.markDone();
		isAgentBusy = false;
	});
	pi.on("session_shutdown", () => {
		bot.stop();
		setTimeout(() => card.reset(), 5000);
	});

	console.log("[telegram] starting long-polling...");
	bot.start()
		.then(() => {
			console.log("[telegram] polling active!");
		})
		.catch((err) => {
			console.error("[telegram] start fail:", err instanceof Error ? err.message : err);
		});
	console.log("[telegram] extension ready");
}

interface ParsedDataUrl {
	mimeType: string;
	data: string;
}
function parseDataUrl(dataUrl: string): ParsedDataUrl | undefined {
	const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
	if (!m?.[2]) return undefined;
	return { mimeType: m[1], data: m[2] };
}

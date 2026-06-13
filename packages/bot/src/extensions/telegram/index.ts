import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BotConfig } from "../../config.ts";
import { isAllowedUser } from "../../config.ts";
import { TelegramBot } from "./bot.ts";
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

	let currentChatId: number | undefined;
	let isAgentBusy = false;
	let workingMsgId: number | undefined;
	let workingChatId: number | undefined;
	interface CompletedTool {
		name: string;
		summary: string;
		ok: boolean;
	}

	let buffer = "";
	let completedTools: CompletedTool[] = [];
	let tokenInfo = "";
	let lastFlush = 0;
	const FLUSH_INTERVAL = 1000;

	const wizard = new SetupWizard(bot, config, (updatedConfig) => {
		Object.assign(config, updatedConfig);
	});
	registerReplyTool(pi, { bot, getChatId: () => currentChatId });

	const COMMANDS: Record<string, (chatId: number, args: string) => Promise<void>> = {
		"/start": async (chatId) => {
			if (!config.setupComplete) await wizard.start(chatId);
			else await bot.sendMessage(chatId, "Ready. /config to reconfigure.");
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
					await startWorking(msg.chatId);
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
			await startWorking(msg.chatId);
		}
	});

	async function startWorking(chatId: number): Promise<void> {
		isAgentBusy = true;
		buffer = "";
		completedTools = [];
		tokenInfo = "";
		lastFlush = 0;
		try {
			const msgId = await bot.sendMessage(chatId, "\u2026");
			workingMsgId = msgId;
			workingChatId = chatId;
		} catch {
			/* ok */
		}
	}

	async function flushBuffer(): Promise<void> {
		if (buffer.length === 0 && completedTools.length === 0 && tokenInfo.length === 0) return;
		const toolLines = completedTools.map((t) => `${t.ok ? "\u2713" : "\u2717"} ${t.name} ${t.summary}`);
		let msg = buffer;
		if (toolLines.length) msg += `\n${toolLines.join("\n")}`;
		if (tokenInfo) msg += `\n${tokenInfo}`;
		if (!msg.trim()) return;
		if (msg !== buffer) {
			// Tools/tokens: append to buffer message, reset buffer
			bot.sendMessage(workingChatId ?? currentChatId ?? 0, msg).catch(() => {});
		}
		buffer = "";
		completedTools = [];
		tokenInfo = "";
	}

	pi.on("agent_start", () => {
		isAgentBusy = true;
	});
	pi.on("message_end", (e) => {
		const event = e as unknown as { message?: { role?: string; content?: Array<{ type: string; text?: string }> } };
		if (event.message?.role !== "assistant" || !event.message.content) return;
		const text = event.message.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		if (!text) return;
		buffer += text;
		const now = Date.now();
		if (now - lastFlush > FLUSH_INTERVAL && buffer.length > 200) {
			lastFlush = now;
			bot.sendMessage(workingChatId ?? currentChatId ?? 0, buffer).catch(() => {});
			buffer = "";
		}
	});
	pi.on("tool_execution_start", (e) => {
		const event = e as unknown as { toolName?: string; args?: unknown };
		completedTools.push({
			name: event.toolName ?? "?",
			summary: toolSummary(event.toolName ?? "?", event.args),
			ok: true,
		});
	});
	pi.on("tool_execution_end", (e) => {
		const event = e as unknown as { toolCallId?: string; isError?: boolean; result?: unknown };
		const last = completedTools[completedTools.length - 1];
		if (last) {
			last.ok = !event.isError;
			if (event.result && typeof event.result === "string") last.summary += ` (${truncate(event.result, 40)})`;
		}
	});
	pi.on("turn_end", (e) => {
		const event = e as unknown as { message?: { usage?: { input: number; output: number; cacheRead?: number } } };
		const usage = event.message?.usage;
		if (usage) {
			const total = (usage.input ?? 0) + (usage.output ?? 0);
			tokenInfo = `${total.toLocaleString()} tokens`;
		}
	});
	pi.on("agent_end", async () => {
		await flushBuffer();
		isAgentBusy = false;
		// Edit working indicator to done
		if (workingChatId && workingMsgId) {
			bot.editMessage(workingChatId, workingMsgId, "\u2713").catch(() => {});
		}
		workingMsgId = undefined;
		workingChatId = undefined;
	});
	pi.on("session_shutdown", () => {
		bot.stop();
	});

	console.log("[telegram] starting long-polling...");
	bot.start()
		.then(() => console.log("[telegram] polling active!"))
		.catch((err) => console.error("[telegram] start fail:", err instanceof Error ? err.message : err));
	console.log("[telegram] extension ready");
}

function toolSummary(name: string, args: unknown): string {
	if (!args || typeof args !== "object") return name;
	const a = args as Record<string, unknown>;
	switch (name) {
		case "bash":
			return typeof a.command === "string" ? truncate(a.command, 60) : name;
		case "read":
		case "edit":
		case "write":
			return typeof a.path === "string" ? a.path : name;
		case "grep":
			return typeof a.pattern === "string" ? `"${truncate(a.pattern, 30)}"` : name;
		case "find":
			return Array.isArray(a.paths) && typeof a.paths[0] === "string" ? a.paths[0] : name;
		default:
			return name;
	}
}

function truncate(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max - 3)}...`;
}

interface ParsedDataUrl {
	mimeType: string;
	data: string;
}
function parseDataUrl(dataUrl: string): ParsedDataUrl | undefined {
	const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
	return m?.[2] ? { mimeType: m[1], data: m[2] } : undefined;
}

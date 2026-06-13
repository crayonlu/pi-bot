import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BotConfig } from "../../config.ts";
import { isAllowedUser } from "../../config.ts";
import { TelegramBot } from "./bot.ts";
import { registerReplyTool } from "./reply-tool.ts";
import { SetupWizard } from "./setup-wizard.ts";

function log(...args: unknown[]): void {
	console.log(`[telegram]`, ...args);
}

export interface TelegramExtensionOptions {
	config: BotConfig;
	onAbort?: () => void;
	onNew?: () => void;
	onCompact?: () => void;
}

export default function telegramExtension(pi: ExtensionAPI, options: TelegramExtensionOptions): void {
	const { config, onAbort, onNew, onCompact } = options;
	const token = process.env.TELEGRAM_BOT_TOKEN;
	if (!token) { console.error("[telegram] TELEGRAM_BOT_TOKEN not set"); return; }

	log(`init, token=${token.slice(0, 8)}...`);
	const bot = new TelegramBot(token);

	let currentChatId: number | undefined;
	let isAgentBusy = false;
	let workingChatId: number | undefined;
	let fullResponse = "";

	const wizard = new SetupWizard(bot, config, (updatedConfig) => { Object.assign(config, updatedConfig); });
	registerReplyTool(pi, { bot, getChatId: () => currentChatId });

	const COMMANDS: Record<string, (chatId: number, args: string) => Promise<void>> = {
		"/start": async (chatId) => {
			log("command: /start setupComplete=", config.setupComplete);
			if (!config.setupComplete) await wizard.start(chatId);
			else await bot.sendMessage(chatId, "Ready. /config to reconfigure.");
		},
		"/config": async (chatId) => { log("command: /config"); await wizard.start(chatId); },
		"/abort": async (chatId) => {
			log("command: /abort busy=", isAgentBusy);
			if (isAgentBusy) { onAbort?.(); await bot.sendMessage(chatId, "Aborted."); }
			else await bot.sendMessage(chatId, "Nothing running.");
		},
		"/new": async (chatId) => { log("command: /new"); onNew?.(); await bot.sendMessage(chatId, "Fresh session."); },
		"/compact": async (chatId) => {
			log("command: /compact busy=", isAgentBusy);
			if (isAgentBusy) await bot.sendMessage(chatId, "Busy.");
			else { onCompact?.(); await bot.sendMessage(chatId, "Compacting..."); }
		},
		"/status": async (chatId) => { log("command: /status"); await bot.sendMessage(chatId, `Status: ${isAgentBusy ? "busy" : "idle"}`); },
		"/help": async (chatId) => { log("command: /help"); await bot.sendMessage(chatId, "/start /config /abort /new /compact /status /help"); },
	};

	bot.onMessage(async (msg) => {
		log(`message: uid=${msg.userId} chat=${msg.chatId} text="${msg.text?.slice(0, 60)}" photo=${!!msg.photo?.length}`);

		if (!msg.userId) { log("  -> no userId, skip"); return; }
		if (!isAllowedUser(config, msg.userId)) { log("  -> user not allowed"); return; }
		currentChatId = msg.chatId;

		if (wizard.active) {
			log("  -> wizard active, handling...");
			if (msg.text) await wizard.handleMessage(msg.chatId, msg.text);
			return;
		}
		if (!config.setupComplete) {
			log("  -> setup not complete, starting wizard...");
			await wizard.start(msg.chatId);
			return;
		}

		if (!msg.text) {
			if (msg.photo?.length) {
				log("  -> photo, downloading...");
				const largest = msg.photo[msg.photo.length - 1];
				try {
					const dataUrl = await bot.downloadFile(largest.file_id);
					const parsed = parseDataUrl(dataUrl);
					if (!parsed) { await bot.sendMessage(msg.chatId, "Image fail."); return; }
					log("  -> photo downloaded, forwarding to agent...");
					pi.sendUserMessage(
						[{ type: "text" as const, text: msg.caption || "Analyze" }, { type: "image" as const, data: parsed.data, mimeType: parsed.mimeType }],
						isAgentBusy ? { deliverAs: "followUp" } : undefined,
					);
				} catch (e) { log("  -> download error:", e); await bot.sendMessage(msg.chatId, "Download fail."); }
			}
			return;
		}

		const text = msg.text.trim();
		if (!text) { log("  -> empty text"); return; }
		const command = text.split(/\s/)[0]?.toLowerCase();
		if (command && command in COMMANDS) {
			log("  -> command:", command);
			await COMMANDS[command](msg.chatId, text.slice(command.length).trim());
			return;
		}

		log("  -> forwarding to agent, busy=", isAgentBusy);
		if (isAgentBusy) {
			pi.sendUserMessage(text, { deliverAs: "followUp" });
			await bot.sendMessage(msg.chatId, "Queued.");
		} else {
			pi.sendUserMessage(text);
			workingChatId = msg.chatId;
		}
	});

	async function chat(): number {
		return workingChatId ?? currentChatId ?? 0;
	}

	pi.on("agent_start", () => { isAgentBusy = true; log("event: agent_start"); });
	pi.on("message_end", (e) => {
		const event = e as unknown as { message?: { role?: string; content?: Array<{ type: string; text?: string }> } };
		if (event.message?.role !== "assistant" || !event.message.content) return;
		const text = event.message.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map(c => c.text).join("\n");
		if (!text) return;
		log(`event: message_end text="${text.slice(0, 80)}"`);
		fullResponse += text;
	});
	pi.on("tool_execution_start", (e) => {
		const event = e as unknown as { toolName?: string; args?: unknown };
		log(`event: tool_start ${event.toolName}`);
		const name = event.toolName ?? "?";
		const summary = toolSummary(name, event.args);
		bot.sendMessage(chat(), `\\- ${escapeHtml(name)} ${escapeHtml(summary)}`).catch(() => {});
	});
	pi.on("tool_execution_end", (e) => {
		const event = e as unknown as { toolCallId?: string; isError?: boolean; result?: unknown };
		log(`event: tool_end error=${!!event.isError}`);
	});
	pi.on("turn_end", (e) => {
		const event = e as unknown as { message?: { usage?: { input: number; output: number; cacheRead?: number } } };
		const usage = event.message?.usage;
		log(`event: turn_end tokens=`, usage);
		if (usage) {
			const total = (usage.input ?? 0) + (usage.output ?? 0);
			bot.sendMessage(chat(), `_${total.toLocaleString()} tokens_`).catch(() => {});
		}
	});
	pi.on("agent_end", () => {
		log(`event: agent_end response="${fullResponse.slice(0, 80)}"`);
		if (fullResponse.trim()) {
			bot.sendMarkdown(chat(), fullResponse).catch(() => {});
		}
		fullResponse = "";
		isAgentBusy = false;
		workingChatId = undefined;
	});
	pi.on("session_shutdown", () => { log("event: session_shutdown"); bot.stop(); });

	log("starting long-polling...");
	bot.start().then(() => log("polling active!")).catch((err) => log("start fail:", err.message));
	log("extension ready");
}

function toolSummary(name: string, args: unknown): string {
	if (!args || typeof args !== "object") return name;
	const a = args as Record<string, unknown>;
	switch (name) {
		case "bash": return typeof a.command === "string" ? truncate(a.command, 60) : name;
		case "read": case "edit": case "write": return typeof a.path === "string" ? a.path : name;
		case "grep": return typeof a.pattern === "string" ? `"${truncate(a.pattern, 30)}"` : name;
		case "find": return Array.isArray(a.paths) && typeof a.paths[0] === "string" ? a.paths[0] : name;
		default: return name;
	}
}

function escapeHtml(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function truncate(s: string, max: number): string { return s.length <= max ? s : `${s.slice(0, max - 3)}...`; }

interface ParsedDataUrl { mimeType: string; data: string }
function parseDataUrl(dataUrl: string): ParsedDataUrl | undefined {
	const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
	return m?.[2] ? { mimeType: m[1], data: m[2] } : undefined;
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BotConfig } from "../../config.ts";
import { isAllowedUser } from "../../config.ts";
import { TelegramBot } from "./bot.ts";
import { registerReplyTool } from "./reply-tool.ts";
import { SetupWizard } from "./setup-wizard.ts";

function log(...a: unknown[]): void {
	console.log("[telegram]", ...a);
}

export interface TelegramExtensionOptions {
	config: BotConfig;
	onAbort?: () => void;
	onNew?: () => void;
	onCompact?: () => void;
}

export default function telegramExtension(pi: ExtensionAPI, opts: TelegramExtensionOptions): void {
	const { config, onAbort, onNew, onCompact } = opts;
	const token = process.env.TELEGRAM_BOT_TOKEN;
	if (!token) {
		console.error("[telegram] no token");
		return;
	}
	log(`init, token=${token.slice(0, 8)}...`);
	const bot = new TelegramBot(token);

	let chatId: number | undefined;
	let busy = false;
	let wMsgId: number | undefined;
	let wChatId: number | undefined;
	let wLines: string[] = [];
	let text = "";

	const wizard = new SetupWizard(bot, config, (c) => Object.assign(config, c));
	registerReplyTool(pi, { bot, getChatId: () => chatId });

	const CMDS: Record<string, (c: number, a: string) => Promise<void>> = {
		"/start": async (c) => {
			if (!config.setupComplete) await wizard.start(c);
			else await bot.sendMessage(c, "Ready.");
		},
		"/config": async (c) => {
			await wizard.start(c);
		},
		"/abort": async (c) => {
			if (busy) {
				onAbort?.();
				await bot.sendMessage(c, "Aborted.");
			} else await bot.sendMessage(c, "Idle.");
		},
		"/new": async (c) => {
			onNew?.();
			await bot.sendMessage(c, "Fresh.");
		},
		"/compact": async (c) => {
			if (!busy) {
				onCompact?.();
				await bot.sendMessage(c, "Compacting...");
			} else await bot.sendMessage(c, "Busy.");
		},
		"/status": async (c) => {
			await bot.sendMessage(c, `Status: ${busy ? "busy" : "idle"}`);
		},
		"/help": async (c) => {
			await bot.sendMessage(c, "/start /config /abort /new /compact /status /help");
		},
	};

	bot.onMessage(async (msg) => {
		if (!msg.userId || !isAllowedUser(config, msg.userId)) return;
		chatId = msg.chatId;
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
				try {
					const du = await bot.downloadFile(msg.photo[msg.photo.length - 1].file_id);
					const p = parseDataUrl(du);
					if (!p) {
						await bot.sendMessage(msg.chatId, "Img fail");
						return;
					}
					pi.sendUserMessage(
						[
							{ type: "text" as const, text: msg.caption || "Analyze" },
							{ type: "image" as const, data: p.data, mimeType: p.mimeType },
						],
						busy ? { deliverAs: "followUp" } : undefined,
					);
				} catch {
					await bot.sendMessage(msg.chatId, "DL fail");
				}
			}
			return;
		}
		const t = msg.text.trim();
		if (!t) return;
		const cmd = t.split(/\s/)[0]?.toLowerCase();
		if (cmd && cmd in CMDS) {
			await CMDS[cmd](msg.chatId, t.slice(cmd.length).trim());
			return;
		}
		if (busy) {
			pi.sendUserMessage(t, { deliverAs: "followUp" });
			await bot.sendMessage(msg.chatId, "Queued.");
		} else {
			pi.sendUserMessage(t);
			wChatId = msg.chatId;
			startWorking();
		}
	});
	function ch(): number {
		return wChatId ?? chatId ?? 0;
	}

	async function startWorking(): Promise<void> {
		wLines = [];
		try {
			wMsgId = await bot.sendMessage(ch(), "---");
		} catch {
			/* ok */
		}
	}
	async function appendWorking(line: string): Promise<void> {
		wLines.push(line);
		if (wLines.length > 10) wLines.shift();
		if (wChatId && wMsgId)
			bot.editMessage(wChatId, wMsgId, wLines.join("\n")).catch((e) => log("edit FAIL:", e.message));
	}
	pi.on("tool_execution_start", (e) => {
		const ev = e as unknown as { toolName?: string; args?: unknown };
		const line = `${ev.toolName ?? "?"} ${toolSummary(ev.toolName ?? "?", ev.args)}`;
		log("tool:", line);
		appendWorking(line);
	});
	pi.on("message_end", (e) => {
		const ev = e as unknown as { message?: { role?: string; content?: Array<{ type: string; text?: string }> } };
		if (ev.message?.role !== "assistant" || !ev.message?.content) return;
		for (const c of ev.message.content) {
			if (c?.type === "text") text += c.text ?? "";
		}
	});
	pi.on("turn_end", async (e) => {
		const ev = e as unknown as { message?: { usage?: { input: number; output: number } } };
		if (ev.message?.usage) {
			const t = (ev.message.usage.input ?? 0) + (ev.message.usage.output ?? 0);
			log("turn tok:", t);
			await appendWorking(`${t.toLocaleString()} tok`);
		}
	});
	pi.on("agent_end", () => {
		log(`agent_end: textLen=${text.length} chatId=${ch()}`);
		if (text.trim()) {
			bot.sendMarkdown(ch(), text)
				.then(() => log("sendMarkdown OK"))
				.catch((err) => log("sendMarkdown FAIL:", err.message));
		}
		text = "";
		busy = false;
		if (wMsgId) {
			bot.editMessage(wChatId ?? 0, wMsgId, [...wLines, "- done"].join("\n")).catch(() => {});
		}
		wMsgId = undefined;
		wChatId = undefined;
		wLines = [];
	});
	pi.on("session_shutdown", () => {
		bot.stop();
	});

	log("starting poll...");
	bot.start()
		.then(() => log("poll OK"))
		.catch((e) => log("poll FAIL:", e.message));
	log("ready");
}

function toolSummary(n: string, a: unknown): string {
	if (!a || typeof a !== "object") return n;
	const o = a as Record<string, unknown>;
	switch (n) {
		case "bash":
			return typeof o.command === "string" ? trunc(o.command, 60) : n;
		case "read":
		case "edit":
		case "write":
			return typeof o.path === "string" ? o.path : n;
		default:
			return n;
	}
}
function trunc(s: string, m: number): string {
	return s.length <= m ? s : `${s.slice(0, m - 3)}...`;
}
interface PD {
	mimeType: string;
	data: string;
}
function parseDataUrl(u: string): PD | undefined {
	const m = u.match(/^data:([^;]+);base64,(.+)$/);
	return m?.[2] ? { mimeType: m[1], data: m[2] } : undefined;
}

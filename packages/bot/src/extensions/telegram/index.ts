import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BotConfig } from "../../config.ts";
import { isAllowedUser } from "../../config.ts";
import { TelegramBot } from "./bot.ts";
import { registerReplyTool } from "./reply-tool.ts";
import { SetupWizard } from "./setup-wizard.ts";

function log(...args: unknown[]): void { console.log("[telegram]", ...args); }

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

	const wizard = new SetupWizard(bot, config, (c) => Object.assign(config, c));
	registerReplyTool(pi, { bot, getChatId: () => currentChatId });

	const CMDS: Record<string, (chatId: number, args: string) => Promise<void>> = {
		"/start": async (c) => { if (!config.setupComplete) await wizard.start(c); else await bot.sendMessage(c, "Ready."); },
		"/config": async (c) => { await wizard.start(c); },
		"/abort": async (c) => { if (isAgentBusy) { onAbort?.(); await bot.sendMessage(c, "Aborted."); } else await bot.sendMessage(c, "Idle."); },
		"/new": async (c) => { onNew?.(); await bot.sendMessage(c, "Fresh."); },
		"/compact": async (c) => { if (!isAgentBusy) { onCompact?.(); await bot.sendMessage(c, "Compacting..."); } else await bot.sendMessage(c, "Busy."); },
		"/status": async (c) => { await bot.sendMessage(c, `Status: ${isAgentBusy ? "busy" : "idle"}`); },
		"/help": async (c) => { await bot.sendMessage(c, "/start /config /abort /new /compact /status /help"); },
	};

	bot.onMessage(async (msg) => {
		log(`msg: uid=${msg.userId} txt="${msg.text?.slice(0, 40)}" photo=${!!msg.photo?.length}`);
		if (!msg.userId || !isAllowedUser(config, msg.userId)) return;
		currentChatId = msg.chatId;
		if (wizard.active) { if (msg.text) await wizard.handleMessage(msg.chatId, msg.text); return; }
		if (!config.setupComplete) { await wizard.start(msg.chatId); return; }
		if (!msg.text) {
			if (msg.photo?.length) {
				const largest = msg.photo[msg.photo.length - 1];
				try {
					const dataUrl = await bot.downloadFile(largest.file_id);
					const parsed = parseDataUrl(dataUrl);
					if (!parsed) { await bot.sendMessage(msg.chatId, "Image fail."); return; }
					pi.sendUserMessage([{ type: "text" as const, text: msg.caption || "Analyze" }, { type: "image" as const, data: parsed.data, mimeType: parsed.mimeType }], isAgentBusy ? { deliverAs: "followUp" } : undefined);
				} catch { await bot.sendMessage(msg.chatId, "Download fail."); }
			}
			return;
		}
		const text = msg.text.trim();
		if (!text) return;
		const cmd = text.split(/\s/)[0]?.toLowerCase();
		if (cmd && cmd in CMDS) { await CMDS[cmd](msg.chatId, text.slice(cmd.length).trim()); return; }
		if (isAgentBusy) { pi.sendUserMessage(text, { deliverAs: "followUp" }); await bot.sendMessage(msg.chatId, "Queued."); }
		else { pi.sendUserMessage(text); workingChatId = msg.chatId; }
	});

	async function ch(): number { return workingChatId ?? currentChatId ?? 0; }

	pi.on("agent_start", () => { isAgentBusy = true; log("agent_start"); });
	pi.on("message_update", (e) => {
		const ev = e as unknown as { message?: { role?: string; content?: unknown[] } };
		log(`message_update role=${ev.message?.role} contentLen=${ev.message?.content?.length}`);
	});
	pi.on("message_end", (e) => {
		const ev = e as unknown as { message?: { role?: string; content?: unknown[] } };
		log(`message_end keys=${Object.keys(ev).join(",")} role=${ev.message?.role} content=${JSON.stringify(ev.message?.content?.slice(0, 2)).slice(0, 200)}`);
		if (ev.message?.role !== "assistant") return;
		if (!ev.message?.content) return;
		let txt = "";
		for (const c of ev.message.content) {
			if (c && typeof c === "object" && "type" in c && c.type === "text" && "text" in c) {
				txt += String(c.text);
			}
		}
		log(`message_end text="${txt.slice(0, 100)}"`);
		fullResponse += txt;
	});
	pi.on("tool_execution_start", (e) => {
		const ev = e as unknown as { toolName?: string; args?: unknown };
		log(`tool_start ${ev.toolName}`);
		const name = ev.toolName ?? "?";
		bot.sendMessage(ch(), `\\- ${escapeHtml(name)} ${escapeHtml(toolSummary(name, ev.args))}`).catch(() => {});
	});
	pi.on("tool_execution_end", (e) => {
		const ev = e as unknown as { isError?: boolean };
		log(`tool_end err=${!!ev.isError}`);
	});
	pi.on("turn_end", (e) => {
		const ev = e as unknown as { message?: { role?: string; stopReason?: string; usage?: { input: number; output: number } } };
		log(`turn_end role=${ev.message?.role} stop=${ev.message?.stopReason} tokens=`, ev.message?.usage);
		if (ev.message?.usage) {
			const t = (ev.message.usage.input ?? 0) + (ev.message.usage.output ?? 0);
			bot.sendMessage(ch(), `_${t.toLocaleString()} tokens_`).catch(() => {});
		}
	});
	pi.on("agent_end", () => {
		log(`agent_end responseLen=${fullResponse.length} text="${fullResponse.slice(0, 80)}"`);
		if (fullResponse.trim()) bot.sendMarkdown(ch(), fullResponse).catch(() => {});
		fullResponse = "";
		isAgentBusy = false;
		workingChatId = undefined;
	});
	pi.on("session_shutdown", () => { bot.stop(); });

	log("starting long-polling...");
	bot.start().then(() => log("polling active!")).catch((e) => log("start fail:", e.message));
	log("extension ready");
}

function toolSummary(n: string, a: unknown): string {
	if (!a || typeof a !== "object") return n;
	const o = a as Record<string, unknown>;
	switch (n) {
		case "bash": return typeof o.command === "string" ? truncate(o.command, 60) : n;
		case "read": case "edit": case "write": return typeof o.path === "string" ? o.path : n;
		case "grep": return typeof o.pattern === "string" ? `"${truncate(o.pattern, 30)}"` : n;
		case "find": return Array.isArray(o.paths) && typeof o.paths[0] === "string" ? o.paths[0] : n;
		default: return n;
	}
}
function escapeHtml(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function truncate(s: string, m: number): string { return s.length <= m ? s : `${s.slice(0, m - 3)}...`; }
interface PD { mimeType: string; data: string }
function parseDataUrl(u: string): PD | undefined { const m = u.match(/^data:([^;]+);base64,(.+)$/); return m?.[2] ? { mimeType: m[1], data: m[2] } : undefined; }

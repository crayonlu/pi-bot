import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BotConfig } from "../../config.ts";
import { isAllowedUser } from "../../config.ts";
import { TelegramBot } from "./bot.ts";
import { registerReplyTool } from "./reply-tool.ts";
import { SetupWizard } from "./setup-wizard.ts";

function log(...args: unknown[]): void { console.log("[telegram]", ...args); }

export interface TelegramExtensionOptions {
	config: BotConfig; onAbort?: () => void; onNew?: () => void; onCompact?: () => void;
}

export default function telegramExtension(pi: ExtensionAPI, options: TelegramExtensionOptions): void {
	const { config, onAbort, onNew, onCompact } = options;
	const token = process.env.TELEGRAM_BOT_TOKEN;
	if (!token) { console.error("[telegram] TELEGRAM_BOT_TOKEN not set"); return; }
	log(`init, token=${token.slice(0, 8)}...`);
	const bot = new TelegramBot(token);

	let currentChatId: number | undefined;
	let isAgentBusy = false;
	let workingMsgId: number | undefined;
	let workingChatId: number | undefined;
	let workingLines: string[] = [];
	let agentText = "";

	const wizard = new SetupWizard(bot, config, (c) => Object.assign(config, c));
	registerReplyTool(pi, { bot, getChatId: () => currentChatId });

	const CMDS: Record<string, (c: number, a: string) => Promise<void>> = {
		"/start": async (c) => { if (!config.setupComplete) await wizard.start(c); else await bot.sendMessage(c, "Ready."); },
		"/config": async (c) => { await wizard.start(c); },
		"/abort": async (c) => { if (isAgentBusy) { onAbort?.(); await bot.sendMessage(c, "Aborted."); } else await bot.sendMessage(c, "Idle."); },
		"/new": async (c) => { onNew?.(); await bot.sendMessage(c, "Fresh."); },
		"/compact": async (c) => { if (!isAgentBusy) { onCompact?.(); await bot.sendMessage(c, "Compacting..."); } else await bot.sendMessage(c, "Busy."); },
		"/status": async (c) => { await bot.sendMessage(c, `Status: ${isAgentBusy ? "busy" : "idle"}`); },
		"/help": async (c) => { await bot.sendMessage(c, "/start /config /abort /new /compact /status /help"); },
	};

	bot.onMessage(async (msg) => {
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
		else { pi.sendUserMessage(text); workingChatId = msg.chatId; startWorking(); }
	});

	async function ch(): number { return workingChatId ?? currentChatId ?? 0; }

	async function startWorking(): Promise<void> {
		workingLines = [];
		try { workingMsgId = await bot.sendMessage(ch(), "\\- \\- \\-"); } catch { /* ok */ }
	}

	async function appendWorking(line: string): Promise<void> {
		workingLines.push(line);
		if (workingLines.length > 10) workingLines.shift();
		if (workingChatId && workingMsgId) bot.editMessage(workingChatId, workingMsgId, workingLines.join("\n")).catch(() => {});
	}

	pi.on("agent_start", () => { isAgentBusy = true; log("agent_start"); });
	pi.on("tool_execution_start", (e) => {
		const ev = e as unknown as { toolName?: string; args?: unknown };
		appendWorking(`${ev.toolName ?? "?"} ${toolSummary(ev.toolName ?? "?", ev.args)}`);
	});
	pi.on("message_end", (e) => {
		const ev = e as unknown as { message?: { role?: string; content?: Array<{ type: string; text?: string }> } };
		if (ev.message?.role !== "assistant" || !ev.message?.content) return;
		for (const c of ev.message.content) { if (c?.type === "text") agentText += c.text ?? ""; }
	});
	pi.on("turn_end", async (e) => {
		const ev = e as unknown as { message?: { usage?: { input: number; output: number } } };
		if (ev.message?.usage) { const t = (ev.message.usage.input ?? 0) + (ev.message.usage.output ?? 0); await appendWorking(`${t.toLocaleString()} tokens`); }
	});
	pi.on("agent_end", async () => {
		if (agentText.trim()) bot.sendMarkdown(ch(), agentText).catch(() => {});
		agentText = "";
		isAgentBusy = false;
		if (workingMsgId) { bot.editMessage(workingChatId ?? 0, workingMsgId, "\\- done").catch(() => {}); }
		workingMsgId = undefined; workingChatId = undefined; workingLines = [];
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
		default: return n;
	}
}
function truncate(s: string, m: number): string { return s.length <= m ? s : `${s.slice(0, m - 3)}...`; }
interface PD { mimeType: string; data: string }
function parseDataUrl(u: string): PD | undefined { const m = u.match(/^data:([^;]+);base64,(.+)$/); return m?.[2] ? { mimeType: m[1], data: m[2] } : undefined; }

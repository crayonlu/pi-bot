import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BotConfig } from "../../config.ts";
import { isAllowedUser } from "../../config.ts";
import { TelegramBot } from "./bot.ts";
import { registerReplyTool } from "./reply-tool.ts";
import { SetupWizard } from "./setup-wizard.ts";

const TEXT_MODEL = "deepseek/deepseek-v4-flash";
const IMAGE_MODEL = "xiaomimimo/mimo-v2.5";
const WATCHDOG_MS = 120_000;

function log(...a: unknown[]): void {
	console.log("[telegram]", ...a);
}

const DANGEROUS_PATTERNS = ["rm -rf", "mkfs", "dd if=", "> /dev/", "shutdown", "reboot", "systemctl stop"];

function isDangerous(ev: { toolName?: string; args?: unknown }): boolean {
	if (ev.toolName !== "bash") return false;
	const args = ev.args as { command?: string } | undefined;
	if (!args?.command) return false;
	const cmd = args.command.toLowerCase();
	return DANGEROUS_PATTERNS.some((p) => cmd.includes(p));
}

export default function telegramExtension(
	pi: ExtensionAPI,
	opts: { config: BotConfig; onAbort?: () => void; onNew?: () => void; onCompact?: () => void },
): void {
	const { config, onAbort, onNew, onCompact } = opts;
	const t = process.env.TELEGRAM_BOT_TOKEN;
	if (!t) {
		console.error("[telegram] no token");
		return;
	}
	log(`init: ${t.slice(0, 8)}...`);
	const bot = new TelegramBot(t);

	let cid: number | undefined;
	let busy = false;
	let wMid: number | undefined;
	let wCid: number | undefined;
	let wLines: string[] = [];
	let agentText = "";
	let currentModel = TEXT_MODEL;
	let watchdog: NodeJS.Timeout | undefined;
	let runStartTs = 0;
	let agentRuns = 0;
	let lastEndReason: string | undefined;

	const wz = new SetupWizard(bot, config, (c) => Object.assign(config, c));
	registerReplyTool(pi, { bot, getChatId: () => cid });

	function ch(): number {
		return wCid ?? cid ?? 0;
	}
	function resetWatchdog(): void {
		if (watchdog) {
			clearTimeout(watchdog);
			watchdog = undefined;
		}
	}

	function setWatchdog(chatId: number): void {
		resetWatchdog();
		watchdog = setTimeout(() => {
			log("WATCHDOG: run timed out after", Date.now() - runStartTs, "ms");
			lastEndReason = "watchdog";
			try {
				onAbort?.();
			} catch (e) {
				log("onAbort error:", (e as Error).message);
			}
			busy = false;
			wLines.push(
				`[${new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" })}] [fail] timeout`,
			);
			if (wCid && wMid) bot.editMessage(wCid, wMid, wLines.join("\n")).catch(() => {});
			bot.sendMessage(chatId, "Agent timed out. Reset.").catch(() => {});
			wMid = undefined;
			wCid = undefined;
			wLines = [];
			agentText = "";
		}, WATCHDOG_MS);
	}

	async function startW(chatId: number): Promise<void> {
		if (wMid) return;
		try {
			wMid = await bot.sendMessage(chatId, "Working...");
			wCid = chatId;
		} catch {
			/* ok */
		}
	}

	async function app(line: string): Promise<void> {
		wLines.push(
			`[${new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" })}] ${line}`,
		);
		if (wCid && wMid) bot.editMessage(wCid, wMid, wLines.join("\n")).catch((e) => log("edit err:", e.message));
	}

	async function switchModel(chatId: number, modelId: string): Promise<void> {
		if (modelId === currentModel) return;
		try {
			await pi.setModel({ provider: "ppio", id: modelId } as Parameters<typeof pi.setModel>[0]);
			currentModel = modelId;
			await bot.sendMessage(chatId, `Model: ${modelId}`);
		} catch {
			await bot.sendMessage(chatId, `Model switch failed.`);
		}
	}

	async function showModelKeyboard(chatId: number): Promise<void> {
		await bot.sendInlineKeyboard(chatId, "Select model:", [
			{ text: "DeepSeek V4 Flash", data: "model:deepseek/deepseek-v4-flash" },
			{ text: "DeepSeek V4 Pro", data: "model:deepseek/deepseek-v4" },
			{ text: "MiMo v2.5", data: "model:xiaomimimo/mimo-v2.5" },
		]);
	}

	bot.onCallback((data, chatId, userId) => {
		if (!isAllowedUser(config, userId)) return;
		if (data === "new_topic") {
			busy = false;
			wMid = undefined;
			wCid = undefined;
			wLines = [];
			agentText = "";
			resetWatchdog();
			bot.sendMessage(chatId, "Ready.");
		} else if (data === "model") {
			showModelKeyboard(chatId);
		} else if (data.startsWith("model:")) {
			switchModel(chatId, data.slice(6));
		}
	});

	const CMDS: Record<string, (c: number, a: string) => Promise<void>> = {
		"/start": async (c) => {
			if (!config.setupComplete) await wz.start(c);
			else await bot.sendMessage(c, "Ready.");
		},
		"/config": async (c) => {
			await wz.start(c);
		},
		"/abort": async (c) => {
			if (busy) {
				onAbort?.();
				busy = false;
				await bot.sendMessage(c, "Aborted.");
			} else await bot.sendMessage(c, "Idle.");
		},
		"/new": async (c) => {
			onNew?.();
			busy = false;
			wMid = undefined;
			wCid = undefined;
			wLines = [];
			agentText = "";
			resetWatchdog();
			await bot.sendMessage(c, "Fresh.");
		},
		"/compact": async (c) => {
			if (!busy) {
				onCompact?.();
				await bot.sendMessage(c, "Compacting...");
			} else await bot.sendMessage(c, "Busy.");
		},
		"/model": async (c, a) => {
			const id = a.trim();
			if (id) {
				await switchModel(c, id);
				return;
			}
			await showModelKeyboard(c);
		},
		"/status": async (c) => {
			await bot.sendMessage(
				c,
				`busy=${busy}\nruns=${agentRuns}\nmodel=${currentModel}\nlast_end=${lastEndReason ?? "n/a"}`,
			);
		},
		"/debug": async (c) => {
			const now = Date.now();
			const state = {
				busy,
				currentModel,
				chatId: cid,
				wCid,
				wMid,
				wLinesLen: wLines.length,
				agentTextLen: agentText.length,
				msSinceStart: busy ? now - runStartTs : 0,
				lastEndReason,
				agentRuns,
			};
			await bot.sendMessage(
				c,
				Object.entries(state)
					.map(([k, v]) => `${k}: ${v}`)
					.join("\n"),
			);
		},
		"/help": async (c) => {
			await bot.sendMessage(c, "/start /config /abort /new /compact /model /status /debug /help");
		},
	};

	bot.onMessage(async (msg) => {
		if (!msg.userId || !isAllowedUser(config, msg.userId)) return;
		log(`msg: uid=${msg.userId} txt="${msg.text?.slice(0, 50)}"`);
		cid = msg.chatId;

		// Auto-recovery: if a previous run is stuck past the watchdog, reset state.
		if (busy && Date.now() - runStartTs > WATCHDOG_MS) {
			log("auto-resetting stuck busy state");
			busy = false;
			wMid = undefined;
			wCid = undefined;
			wLines = [];
			agentText = "";
			resetWatchdog();
		}

		if (wz.active) {
			if (msg.text) await wz.handleMessage(msg.chatId, msg.text);
			return;
		}
		if (!config.setupComplete) {
			await wz.start(msg.chatId);
			return;
		}
		if (!msg.text) {
			if (msg.photo?.length) {
				try {
					const du = await bot.downloadFile(msg.photo[msg.photo.length - 1].file_id);
					const p = parse(du);
					if (!p) {
						await bot.sendMessage(msg.chatId, "Img fail");
						return;
					}
					await switchModel(msg.chatId, IMAGE_MODEL);
					pi.sendUserMessage(
						[
							{ type: "text" as const, text: msg.caption || "Analyze" },
							{ type: "image" as const, data: p.data, mimeType: p.mimeType },
						],
						busy ? { deliverAs: "followUp" } : undefined,
					);
					if (busy) await bot.sendMessage(msg.chatId, "Queued.");
					else {
						wCid = msg.chatId;
						startW(msg.chatId);
					}
				} catch {
					await bot.sendMessage(msg.chatId, "DL fail");
				}
			}
			return;
		}
		const tx = msg.text.trim();
		if (!tx) return;
		const cmd = tx.split(/\s/)[0]?.toLowerCase();
		if (cmd && cmd in CMDS) {
			await CMDS[cmd](msg.chatId, tx.slice(cmd.length).trim());
			return;
		}
		if (busy) {
			pi.sendUserMessage(tx, { deliverAs: "followUp" });
			await bot.sendMessage(msg.chatId, "Queued.");
			return;
		}
		await switchModel(msg.chatId, TEXT_MODEL);
		pi.sendUserMessage(tx);
		wCid = msg.chatId;
		startW(msg.chatId);
	});

	pi.on("agent_start", () => {
		busy = true;
		runStartTs = Date.now();
		agentRuns += 1;
		if (wCid) setWatchdog(wCid);
	});
	pi.on("turn_start", () => {
		agentText = "";
	});
	pi.on("tool_execution_start", (e) => {
		const ev = e as unknown as { toolName?: string; args?: unknown };
		const toolName = ev.toolName ?? "?";
		const argsText = sum(toolName, ev.args);
		app(`[tool] ${toolName} ${argsText}`);
		if (isDangerous(ev)) {
			app("[warn] dangerous operation; review before continuing");
			bot.sendMessage(ch(), `Dangerous command detected: ${toolName}`).catch(() => {});
		}
	});
	pi.on("message_end", (e) => {
		const ev = e as unknown as {
			message?: { role?: string; content?: Array<{ type: string; text?: string; thinking?: string }> };
		};
		if (ev.message?.role !== "assistant" || !ev.message?.content) return;
		for (const c of ev.message.content) {
			if (c?.type === "text") agentText += c.text ?? "";
			else if (c?.type === "thinking" && c?.thinking) app(`[think] ${tr(c.thinking, 80)}`);
		}
	});
	pi.on("turn_end", async (e) => {
		const ev = e as unknown as { message?: { usage?: { input: number; output: number } } };
		if (ev.message?.usage) {
			const tk = (ev.message.usage.input ?? 0) + (ev.message.usage.output ?? 0);
			await app(`[done] ${tk.toLocaleString()} tok`);
		}
	});
	pi.on("agent_end", () => {
		resetWatchdog();
		lastEndReason = "ok";
		const chat = ch();
		const text = cleanOutput(agentText);
		if (text.trim()) {
			bot.sendMarkdown(chat, text).catch((mdErr) => {
				log("sendMarkdown failed, falling back to plain text:", mdErr.message);
				bot.sendMessage(chat, text).catch((e) => log("sendMessage also failed:", e.message));
			});
		}
		agentText = "";
		wLines = [];
		if (wMid) {
			bot.editMessage(wCid ?? 0, wMid, "[done]").catch(() => {});
		}
		wMid = undefined;
		wCid = undefined;
		// Delay clearing busy until finishRun() has set isStreaming=false to avoid the
		// race where a new user message arrives between agent_end emission and finishRun.
		setTimeout(() => {
			busy = false;
		}, 0);
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

function sum(n: string, a: unknown): string {
	if (!a || typeof a !== "object") return n;
	const o = a as Record<string, unknown>;
	switch (n) {
		case "browser":
			return typeof o.action === "string" ? `${o.action} ${tr(String(o.url ?? ""), 50)}` : n;
		case "bash":
			return typeof o.command === "string" ? tr(o.command, 60) : n;
		case "read":
		case "edit":
		case "write":
			return typeof o.path === "string" ? o.path : n;
		default:
			return n;
	}
}
function tr(s: string, m: number): string {
	return s.length <= m ? s : `${s.slice(0, m - 3)}...`;
}
function parse(u: string): { mimeType: string; data: string } | undefined {
	const m = /^data:([^;]+);base64,(.+)$/.exec(u);
	return m?.[2] ? { mimeType: m[1], data: m[2] } : undefined;
}
function cleanOutput(s: string): string {
	// Strip any <thinking>...</thinking> blocks some models emit in plain text.
	return s.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim();
}

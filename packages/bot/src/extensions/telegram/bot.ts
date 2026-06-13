import { unlink, writeFile } from "node:fs/promises";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "grammy";
import type { PhotoSize } from "grammy/types";
import { HttpsProxyAgent } from "https-proxy-agent";
import { convert } from "telegram-markdown-v2";

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
if (proxyUrl) {
	const proxyAgent = new HttpsProxyAgent(proxyUrl);
	https.Agent = new Proxy(https.Agent, {
		construct() {
			return proxyAgent;
		},
	});
	console.log("[bot] proxy configured via", proxyUrl);
} else {
	console.log("[bot] no proxy configured");
}

export interface IncomingMessage {
	message_id: number;
	chatId: number;
	userId: number | undefined;
	text: string | undefined;
	photo: PhotoSize[] | undefined;
	caption: string | undefined;
}
export type MessageHandler = (message: IncomingMessage) => void | Promise<void>;
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TelegramBot {
	readonly raw: Bot;
	private handler: MessageHandler | undefined;
	private callbackHandler: ((data: string, chatId: number, userId: number) => void) | undefined;

	constructor(token: string) {
		this.raw = new Bot(token);
	}

	onMessage(h: MessageHandler): void {
		this.handler = h;
	}
	onCallback(h: (data: string, chatId: number, userId: number) => void): void {
		this.callbackHandler = h;
	}

	async start(): Promise<void> {
		if (this.handler) {
			this.raw.on("message", async (ctx) => {
				const msg = ctx.message;
				if (!msg) return;
				await this.handler!({
					message_id: msg.message_id,
					chatId: msg.chat.id,
					userId: msg.from?.id,
					text: "text" in msg ? (msg.text as string) : undefined,
					photo: "photo" in msg ? (msg.photo as PhotoSize[]) : undefined,
					caption: "caption" in msg ? (msg.caption as string) : undefined,
				});
			});
		}
		if (this.callbackHandler) {
			this.raw.on("callback_query:data", async (ctx) => {
				const cq = ctx.callbackQuery;
				if (!cq.data) return;
				await ctx.answerCallbackQuery();
				this.callbackHandler!(cq.data, cq.message?.chat.id ?? 0, cq.from.id);
			});
		}
		this.raw.catch((err) => {
			console.error("[telegram] bot error:", err.message);
		});
		await this.raw.start({
			drop_pending_updates: true,
			timeout: 30,
			allowed_updates: ["message", "callback_query"],
		});
	}

	stop(): void {
		this.raw.stop();
	}

	async sendMessage(chatId: number, text: string): Promise<number> {
		const maxLen = 4000;
		if (text.length <= maxLen) {
			const msg = await this.raw.api.sendMessage(chatId, text);
			return msg.message_id;
		}
		let lastId = 0;
		for (let i = 0; i < text.length; i += maxLen) {
			const msg = await this.raw.api.sendMessage(chatId, text.slice(i, i + maxLen));
			lastId = msg.message_id;
		}
		return lastId;
	}

	async sendMarkdown(chatId: number, text: string): Promise<number> {
		const escaped = convert(text);
		const maxLen = 4000;
		if (escaped.length <= maxLen) {
			const msg = await this.raw.api.sendMessage(chatId, escaped, { parse_mode: "MarkdownV2" });
			return msg.message_id;
		}
		let lastId = 0;
		for (let i = 0; i < escaped.length; i += maxLen) {
			const msg = await this.raw.api.sendMessage(chatId, escaped.slice(i, i + maxLen), { parse_mode: "MarkdownV2" });
			lastId = msg.message_id;
		}
		return lastId;
	}

	async sendInlineKeyboard(
		chatId: number,
		text: string,
		buttons: Array<{ text: string; data: string }>,
	): Promise<number> {
		const keyboard = { inline_keyboard: buttons.map((b) => [{ text: b.text, callback_data: b.data }]) };
		const msg = await this.raw.api.sendMessage(chatId, text, { reply_markup: keyboard });
		return msg.message_id;
	}

	// Rate-limited editMessage: max 15 edits/min (Telegram limit ~20/min).
	// Queue merges duplicate keys — only the latest text per message is kept.
	private editQueue: Map<string, { chatId: number; messageId: number; text: string }> = new Map();
	private editInFlight = false;
	private editTimestamps: number[] = [];

	async editMessage(chatId: number, messageId: number, text: string): Promise<void> {
		const key = `${chatId}:${messageId}`;
		this.editQueue.set(key, { chatId, messageId, text });
		this.processEditQueue();
	}

	private processEditQueue(): void {
		if (this.editInFlight || this.editQueue.size === 0) return;
		this.editInFlight = true;
		this.runEdit().finally(() => {
			this.editInFlight = false;
			if (this.editQueue.size > 0) this.processEditQueue();
		});
	}

	private async runEdit(): Promise<void> {
		const entry = this.editQueue.values().next().value;
		if (!entry) return;
		this.editQueue.delete(`${entry.chatId}:${entry.messageId}`);

		// Clean expired timestamps
		const now = Date.now();
		this.editTimestamps = this.editTimestamps.filter((t) => now - t < 60_000);

		// Wait if at rate limit
		if (this.editTimestamps.length >= 15) {
			const waitMs = this.editTimestamps[0] + 60_000 - now + 500;
			if (waitMs > 0) await sleep(waitMs);
			this.editTimestamps = this.editTimestamps.filter((t) => Date.now() - t < 60_000);
		}

		try {
			await this.raw.api.editMessageText(entry.chatId, entry.messageId, entry.text);
			this.editTimestamps.push(Date.now());
		} catch {
			// Edit may fail if content unchanged or message too old
		}
	}

	async sendPhoto(chatId: number, image: string, caption?: string): Promise<number> {
		if (image.startsWith("data:")) {
			const match = image.match(/^data:image\/[^;]+;base64,(.+)$/);
			if (match) {
				const tmpPath = join(tmpdir(), `pi-bot-${Date.now()}.png`);
				try {
					await writeFile(tmpPath, Buffer.from(match[1], "base64"));
					const msg = await this.raw.api.sendPhoto(chatId, tmpPath, { caption });
					return msg.message_id;
				} finally {
					unlink(tmpPath).catch(() => {});
				}
			}
		}
		const msg = await this.raw.api.sendPhoto(chatId, image, { caption });
		return msg.message_id;
	}

	async downloadFile(fileId: string): Promise<string> {
		const file = await this.raw.api.getFile(fileId);
		if (!file.file_path) throw new Error("No file_path");
		const url = `https://api.telegram.org/file/bot${this.raw.token}/${file.file_path}`;
		const resp = await fetch(url);
		const buf = await resp.arrayBuffer();
		const b64 = Buffer.from(buf).toString("base64");
		const ext = file.file_path.split(".").pop()?.toLowerCase();
		const mimes: Record<string, string> = {
			jpg: "image/jpeg",
			jpeg: "image/jpeg",
			png: "image/png",
			webp: "image/webp",
			gif: "image/gif",
		};
		return `data:${mimes[ext ?? ""] ?? "image/jpeg"};base64,${b64}`;
	}
}

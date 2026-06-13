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
} else console.log("[bot] no proxy configured");

export interface IncomingMessage {
	message_id: number;
	chatId: number;
	userId: number | undefined;
	text: string | undefined;
	photo: PhotoSize[] | undefined;
	caption: string | undefined;
}
export type MessageHandler = (message: IncomingMessage) => void | Promise<void>;

export class TelegramBot {
	readonly raw: Bot;
	private handler: MessageHandler | undefined;

	constructor(token: string) {
		this.raw = new Bot(token);
	}
	onMessage(h: MessageHandler): void {
		this.handler = h;
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
		this.raw.catch((err) => {
			console.error("[telegram] bot error:", err.message);
		});
		await this.raw.start({ drop_pending_updates: true, timeout: 30, allowed_updates: ["message"] });
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

	async editMessage(chatId: number, messageId: number, text: string): Promise<void> {
		await this.raw.api.editMessageText(chatId, messageId, text);
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

/**
 * Telegram Bot wrapper built on grammY.
 *
 * Supports proxy via HTTPS_PROXY env var using undici's ProxyAgent.
 */

import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "grammy";
import type { PhotoSize } from "grammy/types";
import { ProxyAgent, setGlobalDispatcher } from "undici";

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
		const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
		if (proxy) {
			setGlobalDispatcher(new ProxyAgent(proxy));
		}
		this.raw = new Bot(token);
	}

	onMessage(handler: MessageHandler): void {
		this.handler = handler;
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

		await this.raw.start({
			drop_pending_updates: true,
			timeout: 30,
			allowed_updates: ["message"],
		});
	}

	stop(): void {
		this.raw.stop();
	}

	async sendMessage(chatId: number, text: string): Promise<number> {
		const maxLen = 4000;
		if (text.length <= maxLen) {
			const msg = await this.raw.api.sendMessage(chatId, text, { parse_mode: "HTML" });
			return msg.message_id;
		}
		let lastId = 0;
		for (let i = 0; i < text.length; i += maxLen) {
			const chunk = text.slice(i, i + maxLen);
			const msg = await this.raw.api.sendMessage(chatId, chunk, { parse_mode: "HTML" });
			lastId = msg.message_id;
		}
		return lastId;
	}

	async editMessage(chatId: number, messageId: number, text: string): Promise<void> {
		await this.raw.api.editMessageText(chatId, messageId, text, { parse_mode: "HTML" });
	}

	/** Send a photo. `image` can be a URL, file_id, or base64 data URL. */
	async sendPhoto(chatId: number, image: string, caption?: string): Promise<number> {
		if (image.startsWith("data:")) {
			const match = image.match(/^data:image\/[^;]+;base64,(.+)$/);
			if (match) {
				const tmpPath = join(tmpdir(), `pi-bot-${Date.now()}.png`);
				try {
					await writeFile(tmpPath, Buffer.from(match[1], "base64"));
					const msg = await this.raw.api.sendPhoto(chatId, tmpPath, { caption, parse_mode: "HTML" });
					return msg.message_id;
				} finally {
					unlink(tmpPath).catch(() => {});
				}
			}
		}
		const msg = await this.raw.api.sendPhoto(chatId, image, { caption, parse_mode: "HTML" });
		return msg.message_id;
	}

	async downloadFile(fileId: string): Promise<string> {
		const file = await this.raw.api.getFile(fileId);
		const filePath = file.file_path;
		if (!filePath) throw new Error("No file_path returned from Telegram");

		const url = `https://api.telegram.org/file/bot${this.raw.token}/${filePath}`;
		const resp = await fetch(url);
		const buffer = await resp.arrayBuffer();
		const base64 = Buffer.from(buffer).toString("base64");

		const ext = filePath.split(".").pop()?.toLowerCase();
		const mimeMap: Record<string, string> = {
			jpg: "image/jpeg",
			jpeg: "image/jpeg",
			png: "image/png",
			webp: "image/webp",
			gif: "image/gif",
		};
		return `data:${mimeMap[ext ?? ""] ?? "image/jpeg"};base64,${base64}`;
	}
}

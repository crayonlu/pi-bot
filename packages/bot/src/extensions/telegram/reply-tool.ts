/**
 * Reply tool: lets the agent send messages/images to the Telegram user.
 */

import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TelegramBot } from "./bot.ts";

export interface ReplyToolContext {
	bot: TelegramBot;
	getChatId: () => number | undefined;
}

export function registerReplyTool(pi: ExtensionAPI, ctx: ReplyToolContext): void {
	pi.registerTool({
		name: "reply",
		label: "Reply",
		description:
			"Send text or an image to the user via Telegram. Use when you need to show a result, ask for confirmation, or send a screenshot.",
		parameters: Type.Object({
			text: Type.Optional(Type.String({ description: "Message text to send to the user" })),
			image: Type.Optional(
				Type.String({
					description:
						"Image as a URL, local file path, or base64 data URL. Local paths (e.g. agent_browser screenshot output) are read and sent automatically.",
				}),
			),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
			const chatId = ctx.getChatId();
			if (!chatId) return err("No active Telegram chat");

			try {
				const sent = [];

				if (params.image) {
					const image = resolveImage(params.image);
					const id = await ctx.bot.sendPhoto(chatId, image, params.text);
					sent.push(`image sent (id: ${id})`);
				} else if (params.text) {
					await ctx.bot.sendMessage(chatId, params.text);
					sent.push("text sent");
				} else {
					return err("Nothing to send — provide text or image");
				}

				return {
					content: [{ type: "text" as const, text: sent.join(", ") }],
					details: { sent: true },
				};
			} catch (e) {
				const msg = e instanceof Error ? e.message : "unknown error";
				return err(`Failed to send: ${msg}`);
			}
		},
	});
}

function err(message: string) {
	return {
		content: [{ type: "text" as const, text: `Reply: ${message}` }],
		details: { sent: false },
	};
}

const MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

/**
 * Normalize an image argument into something sendPhoto accepts:
 * data URLs and URLs/file_ids pass through; local file paths are read
 * and converted to a base64 data URL so grammy sends them as a photo.
 */
function resolveImage(image: string): string {
	if (image.startsWith("data:") || /^https?:\/\//.test(image) || /^file_id:/.test(image)) return image;
	// Treat as a local file path.
	if (existsSync(image)) {
		const mime = MIME_BY_EXT[extname(image).toLowerCase()] ?? "image/png";
		const b64 = readFileSync(image).toString("base64");
		return `data:${mime};base64,${b64}`;
	}
	// Unknown but non-local — pass through (grammy treats as file_id/URL).
	return image;
}

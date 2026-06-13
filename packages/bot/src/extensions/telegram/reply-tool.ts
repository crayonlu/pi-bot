/**
 * Reply tool: lets the agent send messages/images to the Telegram user.
 */

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
				Type.String({ description: "Image as a URL, file_id, or base64 data URL (from browser screenshot)" }),
			),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
			const chatId = ctx.getChatId();
			if (!chatId) return err("No active Telegram chat");

			try {
				const sent = [];

				if (params.image) {
					const id = await ctx.bot.sendPhoto(chatId, params.image, params.text);
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

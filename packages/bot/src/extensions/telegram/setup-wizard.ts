/**
 * Setup wizard: one-step persona configuration.
 *
 * State machine: idle → persona → complete
 *
 * User sends /start or /config, bot asks for persona.
 * User pastes any text. That becomes the system prompt. Done.
 */

import type { BotConfig } from "../../config.ts";
import { saveConfig } from "../../config.ts";
import type { TelegramBot } from "./bot.ts";

type WizardState = "idle" | "persona" | "complete";

export class SetupWizard {
	private state: WizardState = "idle";
	private config: BotConfig;
	private readonly bot: TelegramBot;
	private readonly onComplete: (config: BotConfig) => void;

	constructor(bot: TelegramBot, config: BotConfig, onComplete: (config: BotConfig) => void) {
		this.bot = bot;
		this.config = config;
		this.onComplete = onComplete;
	}

	get active(): boolean {
		return this.state !== "idle" && this.state !== "complete";
	}

	async start(chatId: number): Promise<void> {
		this.state = "persona";
		await this.bot.sendMessage(chatId, "Send your persona.\n\nPaste any text — it becomes my system prompt.");
	}

	async handleMessage(chatId: number, text: string): Promise<boolean> {
		if (!this.active) return false;

		const trimmed = text.trim();
		if (!trimmed) return false;

		if (this.state === "persona") {
			this.config.persona = trimmed;
			this.config.setupComplete = true;
			this.state = "complete";

			await saveConfig(this.config);
			this.onComplete(this.config);

			await this.bot.sendMessage(chatId, "Configured. Send a message to start.\n/config to reconfigure.");
			return true;
		}

		return false;
	}
}

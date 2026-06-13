/**
 * pi-bot configuration.
 *
 * Persists to ~/.pi/bot/config.json.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BotConfig {
	persona: string;
	allowedUsers: number[];
	setupComplete: boolean;
}

const DEFAULT_CONFIG: BotConfig = {
	persona: "",
	allowedUsers: [],
	setupComplete: false,
};

export function getConfigDir(): string {
	return join(homedir(), ".pi", "bot");
}

export function getConfigPath(): string {
	return join(getConfigDir(), "config.json");
}

export function getSessionDir(): string {
	return join(getConfigDir(), "sessions");
}

export async function loadConfig(): Promise<BotConfig> {
	const path = getConfigPath();
	if (!existsSync(path)) return { ...DEFAULT_CONFIG };
	try {
		const raw = await readFile(path, "utf-8");
		return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

export async function saveConfig(config: BotConfig): Promise<void> {
	const dir = getConfigDir();
	if (!existsSync(dir)) {
		await mkdir(dir, { recursive: true });
	}
	await writeFile(getConfigPath(), JSON.stringify(config, null, 2), "utf-8");
}

export function isAllowedUser(config: BotConfig, userId: number): boolean {
	return config.allowedUsers.length === 0 || config.allowedUsers.includes(userId);
}

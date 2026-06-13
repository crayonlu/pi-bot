#!/usr/bin/env node

/**
 * pi-bot: Server agent daemon.
 *
 * Runs a persistent pi agent session with Telegram as the UI.
 * The agent has full server access (cwd: /).
 *
 * Proxy: HTTPS_PROXY env var → node-fetch-compatible global override.
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=... node packages/bot/src/entry.ts
 *
 * Config: ~/.pi/bot/config.json (created by /start)
 * Sessions: ~/.pi/bot/sessions/
 */

import { mkdir } from "node:fs/promises";
import type { AgentSession, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getConfigDir, getSessionDir, loadConfig } from "./config.ts";
import browserExtension from "./extensions/browser/index.ts";
import personaPromptExtension from "./extensions/ops-prompt/index.ts";
import telegramExtension from "./extensions/telegram/index.ts";

async function main(): Promise<void> {
	const token = process.env.TELEGRAM_BOT_TOKEN;
	if (!token) {
		console.error("TELEGRAM_BOT_TOKEN environment variable is required");
		process.exit(1);
	}

	const config = await loadConfig();
	const cwd = "/";
	const agentDir = getConfigDir();
	const sessionDir = getSessionDir();

	await mkdir("/workspace", { recursive: true }).catch(() => {});

	const sessionRef: { current: AgentSession | undefined } = { current: undefined };

	const extensionFactories: ExtensionFactory[] = [
		(pi) =>
			telegramExtension(pi, {
				config,
				onAbort: () => sessionRef.current?.agent.abort(),
				onNew: () => {
					if (sessionRef.current) sessionRef.current.agent.state.messages = [];
				},
				onCompact: () => {},
			}),
		(pi) => personaPromptExtension(pi, config),
		(pi) => browserExtension(pi),
	];

	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories,
	});
	await resourceLoader.reload();

	const sessionManager = SessionManager.create(cwd, sessionDir);
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		settingsManager,
		resourceLoader,
		sessionManager,
		tools: ["bash", "read", "write", "edit", "grep", "find", "ls"],
	});
	sessionRef.current = session;

	await session.bindExtensions({ mode: "rpc" });

	const shutdown = () => {
		console.log("[pi-bot] shutting down...");
		session.agent.abort();
		process.exit(0);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);

	if (config.setupComplete) {
		console.log("[pi-bot] ready");
	} else {
		console.log("[pi-bot] ready — send /start to configure persona");
	}
}

main().catch((err) => {
	console.error("[pi-bot] fatal:", err);
	process.exit(1);
});

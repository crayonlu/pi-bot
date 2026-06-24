import { mkdir, writeFile } from "node:fs/promises";
import type { AgentSession, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { getConfigDir, getSessionDir, loadConfig } from "./config.ts";
import personaPromptExtension from "./extensions/ops-prompt/index.ts";
import telegramExtension from "./extensions/telegram/index.ts";

async function main(): Promise<void> {
	const token = process.env.TELEGRAM_BOT_TOKEN;
	if (!token) {
		console.error("TELEGRAM_BOT_TOKEN required");
		process.exit(1);
	}

	const config = await loadConfig();

	// Global HTTP proxy via Undici — covers OpenAI SDK, native fetch, etc.
	setGlobalDispatcher(new EnvHttpProxyAgent({ allowH2: false }));

	const cwd = "/";
	const agentDir = getConfigDir();
	const sessionDir = getSessionDir();
	await mkdir("/workspace", { recursive: true }).catch((err) => console.error("[pi-bot] workspace:", err.message));
	await writeFile("/workspace/memory.md", "", { flag: "a" }).catch(() => {});
	const sessionRef: { current: AgentSession | undefined } = { current: undefined };
	const extensionFactories: ExtensionFactory[] = [
		(pi) => {
			telegramExtension(pi, {
				config,
				onAbort: () => sessionRef.current?.agent.abort(),
				onNew: () => {
					if (sessionRef.current) sessionRef.current.agent.state.messages = [];
				},
				onCompact: () => {},
			});
		},
		(pi) => personaPromptExtension(pi, config),
	];

	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories });
	await resourceLoader.reload();

	const sessionManager = SessionManager.continueRecent(cwd, sessionDir);
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		settingsManager,
		resourceLoader,
		sessionManager,
		tools: [
			"bash",
			"read",
			"write",
			"edit",
			"grep",
			"find",
			"ls",
			"agent_browser",
			"ctx_execute",
			"ctx_execute_file",
			"ctx_search",
			"ctx_index",
			"ctx_batch_execute",
			"ctx_fetch_and_index",
			"ctx_stats",
			"preview_export",
			"process",
			"todo",
			"reply",
		],
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

	if (config.setupComplete) console.log("[pi-bot] ready");
	else console.log("[pi-bot] ready — send /start to configure persona");

	// Keep process alive indefinitely — grammy long-polling manages the connection
	await new Promise(() => {});
}

main().catch((err) => {
	console.error("[pi-bot] fatal:", err);
	process.exit(1);
});

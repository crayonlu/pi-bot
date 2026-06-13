/**
 * ProgressCard: single-message terminal-style progress display.
 *
 *   ▸ Working...
 *   │
 *   │  read  src/auth/login.ts
 *   │  bash  npm test -- auth
 *   │  └─ 2 passed, 1 failed
 *   │  edit  src/auth/login.ts (+8, -2)
 *   │
 *   ╰ Done │ 12,345 tokens │ $0.03
 */

export type CardStatus = "idle" | "streaming" | "tool_running" | "done" | "error";

interface ToolEntry {
	name: string;
	summary: string;
	result?: string;
	isError: boolean;
}

export class ProgressCard {
	private chatId = 0;
	private messageId = 0;
	private status: CardStatus = "idle";
	private currentAssistantText = "";
	private activeTools: Map<string, ToolEntry> = new Map();
	private completedTools: ToolEntry[] = [];
	private tokenSummary = "";
	private throttleTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly throttleMs: number;
	private readonly editFn: (chatId: number, messageId: number, text: string) => Promise<void>;

	constructor(throttleMs: number, editFn: (chatId: number, messageId: number, text: string) => Promise<void>) {
		this.throttleMs = throttleMs;
		this.editFn = editFn;
	}

	init(chatId: number, messageId: number): void {
		this.chatId = chatId;
		this.messageId = messageId;
		this.status = "streaming";
		this.currentAssistantText = "";
		this.activeTools.clear();
		this.completedTools = [];
		this.tokenSummary = "";
	}

	updateAssistantText(text: string): void {
		this.currentAssistantText = text;
		this.scheduleEdit();
	}

	toolStart(toolCallId: string, toolName: string, summary: string): void {
		this.activeTools.set(toolCallId, { name: toolName, summary, isError: false });
		this.status = "tool_running";
		this.scheduleEdit();
	}

	toolEnd(toolCallId: string, result: string, isError: boolean): void {
		const tool = this.activeTools.get(toolCallId);
		if (tool) {
			tool.result = truncateResult(result, 120);
			tool.isError = isError;
			this.completedTools.push(tool);
			this.activeTools.delete(toolCallId);
		}
		if (this.activeTools.size === 0) this.status = "streaming";
		this.scheduleEdit();
	}

	setTokenSummary(summary: string): void {
		this.tokenSummary = summary;
	}

	markDone(): void {
		this.status = "done";
		this.flushEdit();
	}

	markError(message: string): void {
		this.status = "error";
		this.currentAssistantText = message;
		this.flushEdit();
	}

	render(): string {
		const parts: string[] = [];

		if (this.status === "done") parts.push("Done");
		else if (this.status === "error") parts.push("Error");
		else parts.push("\u25B8 Working...");

		// Show at most last 8 completed tools to stay under Telegram limit
		const shown = this.completedTools.slice(-8);
		if (shown.length > 0 || this.activeTools.size > 0) {
			parts.push("\u2502");
			for (const tool of shown) {
				parts.push(`\u2502  ${formatToolName(tool.name)}  ${tool.summary}`);
				if (tool.result) parts.push(`\u2502  \u2514\u2500 ${tool.result}`);
			}
			for (const tool of this.activeTools.values()) {
				parts.push(`\u2502  ${formatToolName(tool.name)}  ${tool.summary} ...`);
			}
		}

		if (this.currentAssistantText && this.status !== "done" && this.status !== "error") {
			const trimmed = trimToLines(this.currentAssistantText, 8);
			if (trimmed) {
				parts.push("\u2502");
				for (const line of trimmed.split("\n")) parts.push(`\u2502  ${line}`);
			}
		}

		if (this.status === "done" || this.status === "error") {
			const footerParts: string[] = [];
			if (this.status === "error") footerParts.push(truncateResult(this.currentAssistantText, 200));
			if (this.tokenSummary) footerParts.push(this.tokenSummary);
			if (footerParts.length > 0) {
				parts.push("\u2502");
				parts.push(`\u2570 ${footerParts.join(" \u2502 ")}`);
			}
		}

		let result = escapeHtml(parts.join("\n"));
		// Keep under Telegram 4096 char limit with safety margin
		if (result.length > 4000) {
			result = `${result.slice(0, 4000)}\n\n[truncated]`;
		}
		return result;
	}

	private scheduleEdit(): void {
		if (this.throttleTimer) return;
		this.throttleTimer = setTimeout(() => {
			this.throttleTimer = undefined;
			void this.flushEdit();
		}, this.throttleMs);
	}

	private async flushEdit(): Promise<void> {
		if (this.throttleTimer) {
			clearTimeout(this.throttleTimer);
			this.throttleTimer = undefined;
		}
		if (!this.chatId || !this.messageId) return;
		try {
			await this.editFn(this.chatId, this.messageId, this.render());
		} catch {
			// Edit may fail if message is unchanged or too old
		}
	}

	reset(): void {
		this.chatId = 0;
		this.messageId = 0;
		this.status = "idle";
		this.currentAssistantText = "";
		this.activeTools.clear();
		this.completedTools = [];
		this.tokenSummary = "";
		if (this.throttleTimer) {
			clearTimeout(this.throttleTimer);
			this.throttleTimer = undefined;
		}
	}
}

function formatToolName(name: string): string {
	const labels: Record<string, string> = {
		bash: "bash",
		read: "read",
		edit: "edit",
		write: "write",
		grep: "grep",
		find: "find",
		ls: "ls",
	};
	return (labels[name] ?? name).padEnd(5);
}

function truncateResult(text: string, maxLen: number): string {
	const firstLine = text.split("\n")[0] ?? text;
	return firstLine.length <= maxLen ? firstLine : `${firstLine.slice(0, maxLen - 3)}...`;
}

function trimToLines(text: string, maxLines: number): string {
	const lines = text.split("\n");
	return lines.length <= maxLines ? text : lines.slice(-maxLines).join("\n");
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

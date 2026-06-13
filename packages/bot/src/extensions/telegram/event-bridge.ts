/**
 * Event bridge: maps pi session events to ProgressCard updates.
 */

import type { ProgressCard } from "./progress-card.ts";

interface MessageLike {
	role?: string;
	content?: Array<{ type: string; text?: string }>;
	usage?: { input: number; output: number; cacheRead?: number };
}

export interface EventBridgeOptions {
	showToolDetails: boolean;
	showTokenUsage: boolean;
}

function getAssistantText(message: MessageLike): string {
	if (!message.content) return "";
	const parts: string[] = [];
	for (const c of message.content) {
		if (c.type === "text" && c.text) parts.push(c.text);
	}
	return parts.join("\n");
}

function getToolSummary(toolName: string, args: unknown): string {
	if (!args || typeof args !== "object") return toolName;
	const a = args as Record<string, unknown>;
	switch (toolName) {
		case "bash":
			return typeof a.command === "string" ? truncate(a.command, 80) : toolName;
		case "read":
		case "edit":
		case "write":
			return typeof a.path === "string" ? a.path : toolName;
		case "grep":
			return typeof a.pattern === "string" ? `"${truncate(a.pattern, 40)}"` : toolName;
		case "find": {
			const p = a.paths;
			return Array.isArray(p) && typeof p[0] === "string" ? p[0] : toolName;
		}
		case "ls":
			return typeof a.path === "string" ? a.path : ".";
		default:
			return toolName;
	}
}

function formatTokenUsage(message: MessageLike): string | undefined {
	const usage = message.usage;
	if (!usage) return undefined;
	const total = (usage.input ?? 0) + (usage.output ?? 0);
	const parts = [`${total.toLocaleString()} tokens`];
	if (usage.cacheRead && usage.cacheRead > 0) parts.push(`(${usage.cacheRead.toLocaleString()} cached)`);
	return parts.join(" ");
}

function formatToolResult(result: unknown, isError: boolean): string {
	if (isError) return typeof result === "string" ? `FAIL: ${truncate(result, 100)}` : "FAIL";
	if (typeof result === "string") return truncate(result, 120);
	if (result && typeof result === "object" && "output" in result)
		return truncate(String((result as { output: unknown }).output), 120);
	return "ok";
}

function truncate(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max - 3)}...`;
}

export function createEventBridge(
	card: ProgressCard,
	options: EventBridgeOptions,
): (event: Record<string, unknown>) => void {
	return (event: Record<string, unknown>) => {
		switch (event.type as string) {
			case "message_update":
			case "message_end": {
				const msg = event.message as MessageLike;
				if (msg.role === "assistant") card.updateAssistantText(getAssistantText(msg));
				break;
			}
			case "tool_execution_start": {
				if (!options.showToolDetails) break;
				card.toolStart(
					event.toolCallId as string,
					event.toolName as string,
					getToolSummary(event.toolName as string, event.args),
				);
				break;
			}
			case "tool_execution_end": {
				if (!options.showToolDetails) break;
				card.toolEnd(
					event.toolCallId as string,
					formatToolResult(event.result, event.isError as boolean),
					event.isError as boolean,
				);
				break;
			}
			case "turn_end": {
				if (options.showTokenUsage) {
					const summary = formatTokenUsage(event.message as MessageLike);
					if (summary) card.setTokenSummary(summary);
				}
				break;
			}
		}
	};
}

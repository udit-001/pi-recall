/**
 * Thread Search and Reading Extension
 *
 * Four tools over two internal modules:
 *
 *   discovery — bounded head-scan + ripgrep across ~/.pi/agent/sessions
 *   reading   — full parse, branch resolution, message extraction, filtering
 *
 * Tools are thin policy adapters over those modules:
 *
 *   list_threads   cheap metadata listing (head-scan only)
 *   find_threads   message-content search (ripgrep scan)
 *   peek_thread    bounded head/tail slice
 *   search_thread  full filtered read
 *
 * The prior-thread rule — the running session is not history — lives in
 * `src/prior.ts` so both listing tools apply it identically.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	parseSessionEntries,
	type FileEntry,
	type SessionEntry,
	type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { Text, Container, Spacer } from "@earendil-works/pi-tui";
import { isRunningSession } from "./src/prior.ts";
import { threadLookupError } from "./src/thread-errors.ts";
import { extractTextContent } from "./src/content.ts";
import { firstUserPreview } from "./src/scan.ts";

// ============================================================================
// Types
// ============================================================================

/** Metadata-only view of one session file (discovery module output). */
interface ThreadSummary {
	id: string;
	cwd: string;
	created: string;
	/** File mtime — when the thread was last active. */
	modified: string;
	/** User-defined display name, when found in the head window. */
	name?: string;
	/** Source path of the parent session, when this session was forked. */
	parentSession?: string;
	/** First user message (truncated), from the head window. */
	/**
	 * First user message, truncated. Undefined when the session's preamble runs
	 * past the header scan's window — the listing fills these in for the page.
	 */
	preview?: string;
	filePath: string;
}

/** Shown when a session's first user message is past what the scans will read. */
const NO_PREVIEW = "(no user message)";

/** A summary's preview for display, resolved or not. */
function previewText(summary: ThreadSummary): string {
	return summary.preview ?? NO_PREVIEW;
}

/** One extracted message on the active branch (reading module output). */
interface ThreadMessage {
	/** 1-based position on the branch. */
	index: number;
	role: string;
	content: string;
	timestamp?: string;
	model?: string;
}

/** Fully-parsed thread (reading module output). */
interface ThreadData {
	header: SessionHeader;
	messages: ThreadMessage[];
	totalTokens: number;
	totalCost: number;
}

// ============================================================================
// Discovery module — cheap enumeration of sessions
// ============================================================================

function getSessionsDir(): string {
	return path.join(os.homedir(), ".pi", "agent", "sessions");
}

function getAllSessions(sessionsDir: string): string[] {
	const sessions: string[] = [];
	if (!fs.existsSync(sessionsDir)) return sessions;

	for (const dirEntry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
		if (!dirEntry.isDirectory() || dirEntry.name.startsWith(".")) continue;
		const dirPath = path.join(sessionsDir, dirEntry.name);
		for (const fileEntry of fs.readdirSync(dirPath, { withFileTypes: true })) {
			if (fileEntry.name.endsWith(".jsonl")) {
				sessions.push(path.join(dirPath, fileEntry.name));
			}
		}
	}
	return sessions;
}

const HEAD_SCAN_BYTES = 64 * 1024;

/**
 * Bounded head-scan of a session file: reads only the first HEAD_SCAN_BYTES,
 * extracts the header (id/cwd/timestamp/parentSession), the display name and
 * the first user message when they fall inside the window. Never parses the
 * whole file — this is what makes list_threads cheap.
 */
function headScanSessionFile(filePath: string): ThreadSummary | null {
	const fd = fs.openSync(filePath, "r");
	try {
		const stat = fs.fstatSync(fd);
		const buf = Buffer.alloc(Math.min(HEAD_SCAN_BYTES, stat.size));
		fs.readSync(fd, buf, 0, buf.length, 0);
		const text = buf.toString("utf-8");

		let header: SessionHeader | null = null;
		let name: string | undefined;
		let preview = "";

		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue; // truncated window tail
			}
			if (!header) {
				if (entry?.type === "session") header = entry as SessionHeader;
				continue;
			}
			if (entry.type === "session_info") {
				name = (entry.name || "").trim() || undefined;
			} else if (entry.type === "message" && !preview && entry.message?.role === "user") {
				const t = extractTextContent(entry.message.content);
				if (t.trim()) preview = t.trim();
			}
		}

		if (!header) return null;
		return {
			id: header.id,
			cwd: header.cwd || "",
			created: header.timestamp,
			modified: stat.mtime.toISOString(),
			name,
			parentSession: header.parentSession,
			preview: preview ? preview.slice(0, 200) : undefined,
			filePath,
		};
	} catch {
		return null;
	} finally {
		fs.closeSync(fd);
	}
}

/** Derive a session id from its file path (`<fileTimestamp>_<uuid>.jsonl`). */
function sessionIdFromPath(filePath: string): string | undefined {
	const base = path.basename(filePath, ".jsonl");
	const underscore = base.indexOf("_");
	if (underscore === -1) return undefined;
	return base.slice(underscore + 1) || undefined;
}

// ============================================================================
// Reading module — full parse, branch resolution, message extraction
// ============================================================================

function loadSessionFile(filePath: string): FileEntry[] {
	const content = fs.readFileSync(filePath, "utf-8");
	return parseSessionEntries(content);
}

function getSessionHeader(entries: FileEntry[]): SessionHeader | null {
	return entries.find((e): e is SessionHeader => e.type === "session") ?? null;
}

function getSessionEntries(entries: FileEntry[]): SessionEntry[] {
	return entries.filter((e): e is SessionEntry => e.type !== "session");
}

function getLeafEntry(entries: SessionEntry[]): SessionEntry | null {
	if (entries.length === 0) return null;

	const parentIds = new Set<string>();
	for (const entry of entries) {
		if ("parentId" in entry && entry.parentId) {
			parentIds.add(entry.parentId);
		}
	}

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (!parentIds.has(entry.id)) {
			return entry;
		}
	}

	return entries[entries.length - 1] ?? null;
}

/** Entries on the active branch, root → leaf. */
function getEntryPath(entries: SessionEntry[]): SessionEntry[] {
	const leaf = getLeafEntry(entries);
	if (!leaf) return [];

	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branchPath: SessionEntry[] = [];
	let current: SessionEntry | undefined = leaf;

	while (current) {
		branchPath.push(current);
		const parentId = "parentId" in current ? current.parentId : null;
		if (!parentId) break;
		current = byId.get(parentId);
	}

	return branchPath.reverse();
}

/** Resolve a thread id or file path to a session file path. */
function resolveThreadFile(threadId: string, sessionsDir: string): string | null {
	if (threadId.endsWith(".jsonl") || threadId.startsWith("/")) {
		return threadId;
	}
	for (const filePath of getAllSessions(sessionsDir)) {
		const summary = headScanSessionFile(filePath);
		if (summary?.id === threadId) return filePath;
	}
	return null;
}

/** Full parse + branch-resolved message extraction. */
function loadThread(filePath: string): ThreadData | null {
	const fileEntries = loadSessionFile(filePath);
	const header = getSessionHeader(fileEntries);
	if (!header) return null;

	const branchEntries = getEntryPath(getSessionEntries(fileEntries));
	const messages: ThreadMessage[] = [];
	let totalTokens = 0;
	let totalCost = 0;

	for (const entry of branchEntries) {
		if (entry.type === "custom_message") {
			const customEntry = entry as any;
			const customContent = extractTextContent(customEntry.content);
			if (!customContent.trim()) continue;
			messages.push({
				index: messages.length + 1,
				role: customEntry.customType ? `custom:${customEntry.customType}` : "custom",
				content: customContent.trim(),
				timestamp: customEntry.timestamp,
			});
			continue;
		}

		if (entry.type !== "message") continue;

		// AgentMessage is a union; only some members carry text content.
		const msg = entry.message as {
			role: string;
			content: unknown;
			model?: string;
			usage?: { input?: number; output?: number; cost?: { total?: number } };
		};
		const content = extractTextContent(msg.content);
		if (!content.trim()) continue;

		messages.push({
			index: messages.length + 1,
			role: msg.role,
			content: content.trim(),
			timestamp: entry.timestamp,
			model: msg.model,
		});

		if (msg.usage) {
			totalTokens += (msg.usage.input || 0) + (msg.usage.output || 0);
			totalCost += msg.usage.cost?.total || 0;
		}
	}

	return { header, messages, totalTokens, totalCost };
}

// ============================================================================
// Search module — ripgrep with grep fallback
// ============================================================================

async function searchWithGrep(
	exec: (cmd: string, args: string[], opts?: { timeout?: number }) => Promise<{ stdout: string; stderr: string; code: number }>,
	query: string,
	sessionsDir: string,
	onFallback?: () => void,
): Promise<Map<string, number>> {
	const results = new Map<string, number>();

	// Try ripgrep first
	try {
		const { stdout, code } = await exec("rg", ["-c", "-i", "--", query, sessionsDir], { timeout: 10000 });
		if (code === 0 || code === 1) {
			for (const line of stdout.split("\n")) {
				if (!line.trim()) continue;
				const match = line.match(/^(.+?):(\d+)$/);
				if (match) results.set(match[1]!, parseInt(match[2]!, 10));
			}
			return results;
		}
	} catch {
		// ripgrep not found or failed, fall back to grep
	}

	// Fallback to grep
	onFallback?.();
	try {
		const { stdout } = await exec("grep", ["-r", "-c", "-i", query, sessionsDir], { timeout: 30000 });
		for (const line of stdout.split("\n")) {
			if (!line.trim()) continue;
			const match = line.match(/^(.+?):(\d+)$/);
			if (match && parseInt(match[2]!, 10) > 0) {
				results.set(match[1]!, parseInt(match[2]!, 10));
			}
		}
	} catch {
		// grep also failed or no matches
	}
	return results;
}

// ============================================================================
// Formatter module — shared by model-facing text and TUI rendering
// ============================================================================

function snippet(text: string, max: number): string {
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length > max ? compact.slice(0, max) + "..." : compact;
}

/** Window around the first case-insensitive occurrence of query. */
function snippetAround(text: string, query: string, radius = 110): string {
	const compact = text.replace(/\s+/g, " ").trim();
	const idx = compact.toLowerCase().indexOf(query.toLowerCase());
	if (idx === -1) return snippet(compact, radius * 2);
	const start = Math.max(0, idx - radius);
	const end = Math.min(compact.length, idx + query.length + radius);
	const prefix = start > 0 ? "..." : "";
	const suffix = end < compact.length ? "..." : "";
	return `${prefix}${compact.slice(start, end)}${suffix}`;
}

function roleIcon(role: string): string {
	return role === "user" ? "👤" : role === "assistant" ? "🤖" : "🔧";
}

function truncateChars(text: string, max: number): string {
	return text.length > max ? text.slice(0, max) + "..." : text;
}

function formatDate(iso: string): string {
	return new Date(iso).toLocaleDateString();
}

// ============================================================================
// Parameter schemas
// ============================================================================

const ListThreadsParams = Type.Object({
	cwd: Type.Optional(Type.String({ description: "Filter by working directory (partial match)" })),
	include_current: Type.Optional(
		Type.Boolean({ description: "Include the running session in results (default: false)", default: false }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum threads to return (default: 10)", default: 10 })),
	offset: Type.Optional(Type.Number({ description: "Number of threads to skip (pagination: increment by the returned count)", default: 0 })),
	sort: Type.Optional(
		StringEnum(["recent", "oldest"] as const, {
			description: "Sort by last-modified time (default: recent)",
			default: "recent",
		}),
	),
});

const FindThreadsParams = Type.Object({
	query: Type.String({ description: "Text to search for in message bodies (ripgrep syntax)" }),
	cwd: Type.Optional(Type.String({ description: "Filter by working directory (partial match)" })),
	include_current: Type.Optional(
		Type.Boolean({ description: "Include the running session in results (default: false)", default: false }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum threads to return (default: 10)", default: 10 })),
	offset: Type.Optional(Type.Number({ description: "Number of ranked threads to skip (pagination: increment by the returned count)", default: 0 })),
	sort: Type.Optional(
		StringEnum(["relevance", "recent", "oldest"] as const, {
			description: "Ranking: relevance (match count, default), recent, or oldest",
			default: "relevance",
		}),
	),
});

const PeekThreadParams = Type.Object({
	thread_id: Type.String({
		description:
			"Session UUID from list_threads, or a path to a .jsonl session file — one copied off another machine reads the same",
	}),
	position: StringEnum(["head", "tail"] as const, {
		description: '"head" = oldest messages (gist), "tail" = newest messages (resume)',
	}),
	count: Type.Optional(Type.Number({ description: "Messages to return from that end (default: 10, max: 50)", default: 10 })),
	chars_per_message: Type.Optional(Type.Number({ description: "Truncate each message to this many chars (default: 800, max: 4000)", default: 800 })),
});

const SearchThreadParams = Type.Object({
	thread_id: Type.String({
		description:
			"Session UUID from list_threads, or a path to a .jsonl session file — one copied off another machine reads the same",
	}),
	query: Type.Optional(Type.String({ description: "Search for messages containing this text (case-insensitive). If omitted, returns all messages." })),
	context: Type.Optional(Type.Number({ description: "Include N messages before/after each match (default: 0)", default: 0 })),
	roles: Type.Optional(Type.Array(Type.String(), { description: "Filter to specific roles: user, assistant, toolResult (default: all)" })),
	max_messages: Type.Optional(Type.Number({ description: "Page size: maximum messages to return (with offset, pages forward through filtered results)" })),
	offset: Type.Optional(Type.Number({ description: "Number of filtered messages to skip (pagination: increment by the returned count)", default: 0 })),
	max_content_length: Type.Optional(Type.Number({ description: "Truncate each message content to N chars" })),
});

// ============================================================================
// Extension
// ============================================================================

export default function (pi: ExtensionAPI) {
	// ========================================================================
	// list_threads — cheap metadata listing
	// ========================================================================
	pi.registerTool({
		name: "list_threads",
		label: "List Threads",
		description:
			"List prior conversation threads as metadata only (reads session headers, no message scan), most recently modified first — the newest entry is the most recent thread before this one. Use to find 'the previous session' or discover what exists. The running session is excluded unless include_current is true. Each entry includes the thread ID, directory, first-user-message preview, and parentId when the thread was forked from another. Pass a thread ID to peek_thread or search_thread.",
		parameters: ListThreadsParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const startTime = Date.now();
			const limit = Math.max(1, params.limit ?? 10);
			const offset = Math.max(0, params.offset ?? 0);
			const sort = params.sort ?? "recent";

			let summaries: ThreadSummary[] = [];
			for (const filePath of getAllSessions(getSessionsDir())) {
				const summary = headScanSessionFile(filePath);
				if (!summary) continue;
				if (!params.include_current && isRunningSession(summary, ctx.sessionManager)) continue;
				summaries.push(summary);
			}

			if (params.cwd) {
				const needle = params.cwd.toLowerCase();
				summaries = summaries.filter((s) => s.cwd.toLowerCase().includes(needle));
			}

			summaries.sort((a, b) =>
				sort === "oldest"
					? Date.parse(a.modified) - Date.parse(b.modified)
					: Date.parse(b.modified) - Date.parse(a.modified),
			);

			const total = summaries.length;
			const page = summaries.slice(offset, offset + limit);

			// Second pass, and only for the rows being returned: a session's
			// preamble pushes its first user message past the header scan's
			// window, so the cheap pass over every session cannot see it.
			for (const s of page) {
				if (s.preview === undefined) s.preview = firstUserPreview(s.filePath);
			}

			const elapsed = Date.now() - startTime;
			const excluded = !params.include_current;
			let text = `Found ${total} ${excluded ? "prior threads" : "threads"} (${elapsed}ms)`;
			if (excluded) text += " · running session excluded";
			text += "\n\n";
			for (const s of page) {
				text += `**${s.id}**${s.name ? ` — ${s.name}` : ""} (${formatDate(s.modified)})\n`;
				text += `  📁 ${s.cwd}`;
				if (s.parentSession) {
					text += `  ·  🔀 forked from ${sessionIdFromPath(s.parentSession) ?? s.parentSession}`;
				}
				text += `\n  📝 ${snippet(previewText(s), 120)}\n\n`;
			}
			if (total > offset + page.length) {
				text += `Showing ${page.length} of ${total} — offset=${offset + page.length} for the next page.\n`;
			}

			return {
				content: [{ type: "text", text }],
				details: { threads: page, returned: page.length, total, offset },
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("list_threads"));
			if (args.cwd) text += " " + theme.fg("muted", `in ${args.cwd}`);
			if (args.limit) text += " " + theme.fg("dim", `limit:${args.limit}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as
				| { threads: ThreadSummary[]; total: number }
				| undefined;
			if (!details?.threads) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
			}

			const { threads, total } = details as { threads: ThreadSummary[]; total: number };
			const icon = threads.length > 0 ? theme.fg("success", "✓") : theme.fg("muted", "○");

			if (expanded) {
				const container = new Container();
				container.addChild(new Text(`${icon} ${threads.length} of ${total} threads`, 0, 0));
				for (const t of threads) {
					container.addChild(new Spacer(1));
					container.addChild(
						new Text(theme.fg("accent", t.id) + theme.fg("dim", ` (${formatDate(t.modified)})`), 0, 0),
					);
					container.addChild(new Text(theme.fg("muted", `  📁 ${t.cwd}`), 0, 0));
					container.addChild(new Text(theme.fg("toolOutput", `  📝 ${snippet(previewText(t), 90)}`), 0, 0));
				}
				return container;
			}

			let text = `${icon} ${threads.length} of ${total} threads`;
			for (const t of threads.slice(0, 3)) {
				text += `\n  ${theme.fg("accent", t.id.slice(0, 8))} ${theme.fg("dim", formatDate(t.modified))} ${theme.fg("muted", snippet(previewText(t), 50))}`;
			}
			if (threads.length > 3) {
				text += `\n  ${theme.fg("muted", `... +${threads.length - 3} more (Ctrl+O to expand)`)}`;
			}
			return new Text(text, 0, 0);
		},
	});

	// ========================================================================
	// find_threads — message-content search
	// ========================================================================
	pi.registerTool({
		name: "find_threads",
		label: "Find Threads",
		description:
			"Search past conversation threads by message content: ripgrep scans all sessions, threads ranked by match count, top matching snippets included. Cost: full-corpus text scan — prefer list_threads when you don't need message content. Each hit includes the thread ID; pass it to peek_thread for a quick gist or search_thread to read the surrounding conversation (its context parameter expands around matches).",
		parameters: FindThreadsParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const startTime = Date.now();
			const limit = Math.max(1, params.limit ?? 10);
			const offset = Math.max(0, params.offset ?? 0);
			const sort = params.sort ?? "relevance";
			const sessionsDir = getSessionsDir();

			const matchCounts = await searchWithGrep(
				pi.exec.bind(pi),
				params.query,
				sessionsDir,
				() => ctx.ui.notify("ripgrep not found, falling back to grep (slower)", "warning"),
			);

			// Head-scan candidates once: metadata + cwd filter without full parses.
			let candidates: Array<{ summary: ThreadSummary; matchCount: number }> = [];
			for (const [filePath, matchCount] of matchCounts) {
				const summary = headScanSessionFile(filePath);
				if (!summary) continue;
				if (!params.include_current && isRunningSession(summary, ctx.sessionManager)) continue;
				if (params.cwd && !summary.cwd.toLowerCase().includes(params.cwd.toLowerCase())) continue;
				candidates.push({ summary, matchCount });
			}

			if (sort === "recent") {
				candidates.sort((a, b) => Date.parse(b.summary.modified) - Date.parse(a.summary.modified));
			} else if (sort === "oldest") {
				candidates.sort((a, b) => Date.parse(a.summary.modified) - Date.parse(b.summary.modified));
			} else {
				candidates.sort(
					(a, b) =>
						b.matchCount - a.matchCount ||
						Date.parse(b.summary.modified) - Date.parse(a.summary.modified),
				);
			}

			const total = candidates.length;
			const page = candidates.slice(offset, offset + limit);

			// Snippets come from a full parse of just the paged files.
			const queryLower = params.query.toLowerCase();
			const hits = page.map(({ summary, matchCount }) => {
				const snippets: Array<{ role: string; text: string }> = [];
				const data = loadThread(summary.filePath);
				if (data) {
					for (const msg of data.messages) {
						if (snippets.length >= 3) break;
						if (msg.content.toLowerCase().includes(queryLower)) {
							snippets.push({ role: msg.role, text: snippetAround(msg.content, params.query) });
						}
					}
				}
				return {
					id: summary.id,
					cwd: summary.cwd,
					timestamp: summary.created,
					matchCount,
					snippets,
				};
			});
			const elapsed = Date.now() - startTime;

			let text = `Found ${total} threads matching "${params.query}" (${elapsed}ms)`;
			if (params.cwd) text += ` in ${params.cwd}`;
			if (!params.include_current) text += " · running session excluded";
			text += "\n\n";
			for (const h of hits) {
				text += `**${h.id}** (${formatDate(h.timestamp)}) · ${h.matchCount} matches\n`;
				text += `  📁 ${h.cwd}\n`;
				for (const s of h.snippets) {
					text += `  ${roleIcon(s.role)} ${s.text}\n`;
				}
				text += "\n";
			}
			if (total > offset + hits.length) {
				text += `Showing ${hits.length} of ${total} — offset=${offset + hits.length} for the next page.\n`;
			}

			return {
				content: [{ type: "text", text }],
				details: { threads: hits, returned: hits.length, total, offset },
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("find_threads"));
			text += " " + theme.fg("accent", `"${args.query}"`);
			if (args.cwd) text += " " + theme.fg("muted", `in ${args.cwd}`);
			if (args.sort && args.sort !== "relevance") text += " " + theme.fg("dim", `sort:${args.sort}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as
				| {
						threads: Array<{
							id: string;
							timestamp: string;
							matchCount: number;
							snippets: Array<{ role: string; text: string }>;
						}>;
						total: number;
					}
				| undefined;
			if (!details?.threads) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
			}

			const { threads, total } = details as {
				threads: Array<{ id: string; timestamp: string; matchCount: number; snippets: Array<{ role: string; text: string }> }>;
				total: number;
			};
			const icon = threads.length > 0 ? theme.fg("success", "✓") : theme.fg("muted", "○");

			if (expanded) {
				const container = new Container();
				container.addChild(new Text(`${icon} ${threads.length} of ${total} threads match`, 0, 0));
				for (const t of threads) {
					container.addChild(new Spacer(1));
					container.addChild(
						new Text(
							theme.fg("accent", t.id) +
								theme.fg("dim", ` (${formatDate(t.timestamp)})`) +
								theme.fg("warning", ` · ${t.matchCount} matches`),
							0,
							0,
						),
					);
					for (const s of t.snippets) {
						container.addChild(new Text(theme.fg("toolOutput", `  ${roleIcon(s.role)} ${snippet(s.text, 100)}`), 0, 0));
					}
				}
				return container;
			}

			let text = `${icon} ${threads.length} of ${total} threads match`;
			for (const t of threads.slice(0, 3)) {
				const firstSnippet = t.snippets[0]?.text ?? "";
				text += `\n  ${theme.fg("accent", t.id.slice(0, 8))} ${theme.fg("warning", `${t.matchCount}✓`)} ${theme.fg("muted", snippet(firstSnippet, 48))}`;
			}
			if (threads.length > 3) {
				text += `\n  ${theme.fg("muted", `... +${threads.length - 3} more (Ctrl+O to expand)`)}`;
			}
			return new Text(text, 0, 0);
		},
	});

	// ========================================================================
	// peek_thread — bounded head/tail slice
	// ========================================================================
	pi.registerTool({
		name: "peek_thread",
		label: "Peek Thread",
		description:
			"Peek at a bounded slice of one thread's conversation, like Unix head/tail: position 'head' returns the oldest messages (gist of what the session was about), 'tail' returns the newest (where it ended — use to resume a session). Bounded by design: fixed message count, no pagination. Switch to search_thread to read or filter the full conversation.",
		parameters: PeekThreadParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const position = params.position;
			const count = Math.min(50, Math.max(1, params.count ?? 10));
			const charsPerMessage = Math.min(4000, Math.max(200, params.chars_per_message ?? 800));

			const filePath = resolveThreadFile(params.thread_id, getSessionsDir());
			if (!filePath || !fs.existsSync(filePath)) {
				const err = threadLookupError("unknown-thread", { threadId: params.thread_id });
				return {
					content: [{ type: "text", text: err.text }],
					details: { error: err.error },
					isError: true,
				};
			}

			const data = loadThread(filePath);
			if (!data) {
				const err = threadLookupError("not-a-session-file", {
					threadId: params.thread_id,
					filePath,
				});
				return {
					content: [{ type: "text", text: err.text }],
					details: { error: err.error },
					isError: true,
				};
			}

			const total = data.messages.length;
			const sliced =
				position === "head" ? data.messages.slice(0, count) : data.messages.slice(-count);
			const shown = sliced.map((m) => ({ ...m, content: truncateChars(m.content, charsPerMessage) }));

			let text = `## Thread ${data.header.id} — ${position} ${shown.length} of ${total} messages\n`;
			text += `**Directory:** ${data.header.cwd}\n`;
			text += `**Started:** ${new Date(data.header.timestamp).toLocaleString()}\n\n---\n\n`;
			for (const msg of shown) {
				const label = msg.role === "toolResult" ? `tool:${msg.role}` : msg.role;
				text += `### #${msg.index} ${roleIcon(msg.role)} ${label}\n\n${msg.content}\n\n`;
			}
			text += `Bounded peek — use search_thread with thread_id="${data.header.id}" to read or filter the full conversation.\n`;

			return {
				content: [{ type: "text", text }],
				details: {
					thread: { id: data.header.id, cwd: data.header.cwd, messages: shown },
					position,
					totalMessages: total,
				},
			};
		},

		renderCall(args, theme) {
			const arrow = args.position === "head" ? "↑" : args.position === "tail" ? "↓" : "";
			let text = theme.fg("toolTitle", theme.bold("peek_thread"));
			text += " " + theme.fg("accent", `${arrow}${args.position ?? ""}`);
			text += " " + theme.fg("muted", String(args.thread_id ?? "").slice(0, 36));
			if (args.count) text += " " + theme.fg("dim", `count:${args.count}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as
				| {
						thread?: { id: string; cwd: string; messages: ThreadMessage[] };
						position?: string;
						totalMessages?: number;
						error?: string;
					}
				| undefined;
			if (!details?.thread) {
				const first = result.content[0];
				return new Text(
					first?.type === "text" ? theme.fg("error", first.text) : theme.fg("error", "(error)"),
					0,
					0,
				);
			}

			const { thread, position, totalMessages } = details as {
				thread: { id: string; cwd: string; messages: ThreadMessage[] };
				position: string;
				totalMessages: number;
			};
			const icon = theme.fg("success", "✓");
			const countInfo = `${position} ${thread.messages.length}/${totalMessages}`;

			if (expanded) {
				const container = new Container();
				container.addChild(new Text(`${icon} ${countInfo} — ${theme.fg("accent", thread.id.slice(0, 8))}`, 0, 0));
				container.addChild(new Text(theme.fg("muted", `📁 ${thread.cwd}`), 0, 0));
				for (const msg of thread.messages) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(`${roleIcon(msg.role)} ${theme.fg("accent", `#${msg.index} ${msg.role}`)}`, 0, 0));
					container.addChild(new Text(theme.fg("toolOutput", snippet(msg.content, 200)), 0, 0));
				}
				return container;
			}

			let text = `${icon} ${countInfo} ${theme.fg("accent", thread.id.slice(0, 8))}`;
			text += `\n  ${theme.fg("muted", thread.cwd)}`;
			for (const msg of thread.messages.slice(0, 3)) {
				text += `\n  ${roleIcon(msg.role)} ${theme.fg("dim", snippet(msg.content, 60))}`;
			}
			if (thread.messages.length > 3) {
				text += `\n  ${theme.fg("muted", `... +${thread.messages.length - 3} more (Ctrl+O to expand)`)}`;
			}
			return new Text(text, 0, 0);
		},
	});

	// ========================================================================
	// search_thread — full filtered read
	// ========================================================================
	pi.registerTool({
		name: "search_thread",
		label: "Search Thread",
		description:
			"Read one conversation thread by ID or file path: messages on the current branch, optionally narrowed by query text (case-insensitive, with N messages of context around each match), by roles, and paginated with offset + max_messages. Use find_threads or list_threads first when you only have content or a directory to go on.",
		parameters: SearchThreadParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { thread_id, query, context = 0, roles, max_messages, offset = 0, max_content_length } = params;

			const filePath = resolveThreadFile(thread_id, getSessionsDir());
			if (!filePath || !fs.existsSync(filePath)) {
				const err = threadLookupError("unknown-thread", { threadId: thread_id });
				return {
					content: [{ type: "text", text: err.text }],
					details: { thread: null, error: err.error },
					isError: true,
				};
			}

			const data = loadThread(filePath);
			if (!data) {
				const err = threadLookupError("not-a-session-file", { threadId: thread_id, filePath });
				return {
					content: [{ type: "text", text: err.text }],
					details: { thread: null, error: err.error },
					isError: true,
				};
			}

			const originalCount = data.messages.length;

			// 1. Role filter
			let filtered = data.messages;
			if (roles && roles.length > 0) {
				const rolesLower = roles.map((r) => r.toLowerCase());
				filtered = filtered.filter((msg) => rolesLower.includes(msg.role.toLowerCase()));
			}

			// 2. Query filter with context window
			let matchCount = 0;
			if (query) {
				const queryLower = query.toLowerCase();
				const keep = new Set<number>();
				for (let i = 0; i < filtered.length; i++) {
					if (filtered[i]!.content.toLowerCase().includes(queryLower)) {
						matchCount++;
						for (let j = Math.max(0, i - context); j <= Math.min(filtered.length - 1, i + context); j++) {
							keep.add(j);
						}
					}
				}
				filtered = filtered.filter((_, idx) => keep.has(idx));
			}

			// 3. Forward pagination
			const start = Math.max(0, offset);
			const paged = max_messages ? filtered.slice(start, start + max_messages) : filtered.slice(start);

			// 4. Content truncation
			const finalMessages = max_content_length
				? paged.map((msg) => ({ ...msg, content: truncateChars(msg.content, max_content_length) }))
				: paged;

			let text = `## Thread ${data.header.id}\n`;
			text += `**Directory:** ${data.header.cwd}\n`;
			text += `**Started:** ${new Date(data.header.timestamp).toLocaleString()}\n`;
			text += `**Messages:** ${originalCount} total | **Tokens:** ${data.totalTokens.toLocaleString()} | **Cost:** $${data.totalCost.toFixed(4)}\n`;

			const filters: string[] = [];
			if (query) filters.push(`query="${query}" (${matchCount} matches)`);
			if (roles) filters.push(`roles=[${roles.join(", ")}]`);
			if (context > 0) filters.push(`context=${context}`);
			if (offset > 0) filters.push(`offset=${offset}`);
			if (max_messages) filters.push(`max_messages=${max_messages}`);
			if (max_content_length) filters.push(`truncate=${max_content_length}`);

			if (filters.length > 0) {
				text += `**Filters:** ${filters.join(" | ")}\n`;
				text += `**Showing:** ${finalMessages.length}${max_messages || offset ? ` of ${filtered.length} filtered` : ""} (branch total ${originalCount})\n`;
			}

			text += "\n---\n\n";
			for (const msg of finalMessages) {
				const label = msg.role === "toolResult" ? `tool` : msg.role;
				text += `### #${msg.index} ${roleIcon(msg.role)} ${label}\n`;
				if (msg.model) text += `*${msg.model}*\n`;
				text += `\n${msg.content}\n\n`;
			}
			if (max_messages && start + finalMessages.length < filtered.length) {
				text += `More filtered messages remain — offset=${start + finalMessages.length} for the next page.\n`;
			}

			return {
				content: [{ type: "text", text }],
				details: { thread: { ...data, messages: finalMessages }, matchCount, originalCount, filteredCount: filtered.length },
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("search_thread"));
			text += " " + theme.fg("accent", String(args.thread_id ?? "").slice(0, 36));
			if (args.query) text += " " + theme.fg("warning", `"${args.query}"`);
			if (args.roles) text += " " + theme.fg("dim", `roles:[${args.roles.join(",")}]`);
			if (args.context) text += " " + theme.fg("dim", `ctx:${args.context}`);
			if (args.offset) text += " " + theme.fg("dim", `offset:${args.offset}`);
			if (args.max_messages) text += " " + theme.fg("dim", `page:${args.max_messages}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as
				| {
						thread?: ThreadData & { messages: ThreadMessage[] };
						matchCount?: number;
						originalCount?: number;
						filteredCount?: number;
						error?: string;
					}
				| undefined;
			if (!details?.thread) {
				const first = result.content[0];
				return new Text(
					first?.type === "text" ? theme.fg("error", first.text) : theme.fg("error", "(error)"),
					0,
					0,
				);
			}

			const { thread, matchCount, originalCount, filteredCount } = details as {
				thread: ThreadData & { messages: ThreadMessage[] };
				matchCount: number | undefined;
				originalCount: number;
				filteredCount: number;
			};
			const icon = theme.fg("success", "✓");
			const countInfo =
				matchCount !== undefined
					? `${matchCount} matches · showing ${thread.messages.length}/${filteredCount ?? originalCount}`
					: `${thread.messages.length} messages`;

			if (expanded) {
				const container = new Container();
				container.addChild(new Text(`${icon} Thread ${theme.fg("accent", thread.header.id.slice(0, 8))} (${countInfo})`, 0, 0));
				container.addChild(new Text(theme.fg("muted", `📁 ${thread.header.cwd}`), 0, 0));
				container.addChild(
					new Text(theme.fg("dim", `📊 ${thread.totalTokens.toLocaleString()} tokens | $${thread.totalCost.toFixed(4)}`), 0, 0),
				);
				for (const msg of thread.messages) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(`${roleIcon(msg.role)} ${theme.fg("accent", `#${msg.index} ${msg.role}`)}`, 0, 0));
					container.addChild(new Text(theme.fg("toolOutput", snippet(msg.content, 200)), 0, 0));
				}
				return container;
			}

			let text = `${icon} Thread ${theme.fg("accent", thread.header.id.slice(0, 8))} (${countInfo})`;
			text += `\n  ${theme.fg("muted", thread.header.cwd)}`;
			for (const msg of thread.messages.slice(0, 3)) {
				text += `\n  ${roleIcon(msg.role)} ${theme.fg("dim", snippet(msg.content, 60))}`;
			}
			if (thread.messages.length > 3) {
				text += `\n  ${theme.fg("muted", `... +${thread.messages.length - 3} more (Ctrl+O to expand)`)}`;
			}
			return new Text(text, 0, 0);
		},
	});
}

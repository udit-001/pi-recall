/**
 * The second pass of a listing: the first user message of one session file.
 *
 * A session opens with its preamble — system prompt, skills, tool schemas,
 * project instructions — written as entries ahead of the first thing the user
 * said. That preamble runs past any byte window small enough to keep a listing
 * cheap, so the header pass that walks every session stops before reaching the
 * message. This scan is the one that goes and gets it, and only for the rows a
 * listing actually returns.
 */

import * as fs from "node:fs";
import { extractTextContent } from "./content.ts";

/** Give up past this much preamble and report no preview. */
export const PREVIEW_MAX_BYTES = 1024 * 1024;

const PREVIEW_CHARS = 200;

/**
 * The first user message in a session file, truncated, or undefined when the
 * file has none within `maxBytes`.
 *
 * One read of at most the cap: the cap is the whole bound, and a megabyte held
 * for the length of one row costs less than the lines it would take to walk the
 * file a chunk at a time. A file that cannot be read reports no preview, the
 * same as one that has no user message in it.
 */
export function firstUserPreview(filePath: string, maxBytes = PREVIEW_MAX_BYTES): string | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, "r");
		const stat = fs.fstatSync(fd);
		const limit = Math.min(stat.size, maxBytes);
		if (limit === 0) return undefined;
		const buf = Buffer.alloc(limit);
		fs.readSync(fd, buf, 0, limit, 0);

		for (const line of buf.toString("utf-8").split("\n")) {
			if (!line.trim()) continue;
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue; // truncated tail, or a partial line at the read edge
			}
			if (entry?.type !== "message" || entry.message?.role !== "user") continue;
			const text = extractTextContent(entry.message.content).trim();
			if (text) return text.slice(0, PREVIEW_CHARS);
		}
		return undefined;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

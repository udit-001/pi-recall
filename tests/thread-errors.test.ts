import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { threadLookupError } from "../src/thread-errors.ts";

describe("threadLookupError", () => {
	it("names the path and the read tool for a transcript that is not a session file", () => {
		const { text, error } = threadLookupError("not-a-session-file", {
			threadId: "/tmp/t.jsonl",
			filePath: "/tmp/t.jsonl",
		});
		assert.match(text, /\/tmp\/t\.jsonl/);
		assert.match(text, /read tool/);
		assert.equal(error, "not a session file");
	});

	it("falls back to the thread id when no path was resolved", () => {
		const { text } = threadLookupError("not-a-session-file", { threadId: "abc" });
		assert.match(text, /^abc/);
	});

	it("offers both entry points for an unknown thread", () => {
		const { text, error } = threadLookupError("unknown-thread", { threadId: "abc" });
		assert.match(text, /list_threads/);
		assert.match(text, /another machine/);
		assert.equal(error, "unknown thread");
	});

	it("ends every message on a recoverable action", () => {
		for (const failure of ["unknown-thread", "not-a-session-file"] as const) {
			const { text } = threadLookupError(failure, { threadId: "x", filePath: "/x" });
			assert.ok(text.length > 40, `${failure} is too terse to act on`);
			assert.match(text, /\.$/);
		}
	});
});

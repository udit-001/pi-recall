import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isRunningSession, type RunningSession, type ThreadRef } from "../src/prior.ts";

const running = (id: string, file?: string): RunningSession => ({
	getSessionId: () => id,
	getSessionFile: () => file,
});

const thread = (id: string, filePath: string): ThreadRef => ({ id, filePath });

describe("isRunningSession", () => {
	it("matches on the session id", () => {
		assert.equal(isRunningSession(thread("abc", "/s/other.jsonl"), running("abc", "/s/abc.jsonl")), true);
	});

	it("matches on the file path when the ids disagree", () => {
		assert.equal(isRunningSession(thread("stale", "/s/live.jsonl"), running("fresh", "/s/live.jsonl")), true);
	});

	it("does not match a prior thread", () => {
		assert.equal(isRunningSession(thread("abc", "/s/abc.jsonl"), running("xyz", "/s/xyz.jsonl")), false);
	});

	it("falls back to the id when the manager has no session file", () => {
		assert.equal(isRunningSession(thread("abc", "/s/abc.jsonl"), running("abc", undefined)), true);
		assert.equal(isRunningSession(thread("abc", "/s/abc.jsonl"), running("xyz", undefined)), false);
	});

	it("does not match an unrelated thread sharing neither identifier", () => {
		assert.equal(isRunningSession(thread("a", "/s/a.jsonl"), running("b", "/s/b.jsonl")), false);
	});
});

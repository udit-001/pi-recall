import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { firstUserPreview, PREVIEW_MAX_BYTES } from "../src/scan.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-recall-scan-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A session file whose preamble is `preambleBytes` of non-user entries. */
function sessionWithPreamble(preambleBytes: number, userText = "the first thing said"): string {
	const path = join(dir, `session-${preambleBytes}.jsonl`);
	const lines = [JSON.stringify({ type: "session", version: 3, id: "a", timestamp: "t", cwd: "/x" })];

	// One long non-user entry per ~8KB, the way a system prompt lands in a file.
	let written = 0;
	while (written < preambleBytes) {
		const filler = "x".repeat(8 * 1024);
		const line = JSON.stringify({ type: "custom", content: filler }) + "\n";
		lines.push(line.trim());
		written += line.length;
	}
	lines.push(
		JSON.stringify({
			type: "message",
			id: "m1",
			timestamp: "t",
			message: { role: "user", content: [{ type: "text", text: userText }] },
		}),
	);
	writeFileSync(path, lines.join("\n") + "\n", "utf-8");
	return path;
}

describe("firstUserPreview", () => {
	it("finds the first user message past a 64KB preamble", () => {
		const path = sessionWithPreamble(200 * 1024);
		assert.equal(firstUserPreview(path), "the first thing said");
	});

	it("finds one inside a small preamble", () => {
		assert.equal(firstUserPreview(sessionWithPreamble(1024)), "the first thing said");
	});

	it("gives up past the cap rather than reading the whole file", () => {
		const path = sessionWithPreamble(PREVIEW_MAX_BYTES + 256 * 1024);
		assert.equal(firstUserPreview(path), undefined);
	});

	it("respects an explicit smaller cap", () => {
		const path = sessionWithPreamble(200 * 1024);
		assert.equal(firstUserPreview(path, 8 * 1024), undefined);
	});

	it("truncates a long first message", () => {
		const path = sessionWithPreamble(1024, "y".repeat(500));
		assert.equal(firstUserPreview(path)?.length, 200);
	});

	it("reports no preview for a file with no user message", () => {
		const path = join(dir, "assistant-only.jsonl");
		writeFileSync(
			path,
			JSON.stringify({ type: "message", id: "m1", message: { role: "assistant", content: "hi" } }) + "\n",
			"utf-8",
		);
		assert.equal(firstUserPreview(path), undefined);
	});

	it("reports no preview for a path that cannot be read", () => {
		assert.equal(firstUserPreview(join(dir, "missing.jsonl")), undefined);
	});

	it("ignores a truncated final line", () => {
		const path = join(dir, "torn.jsonl");
		const line = JSON.stringify({
			type: "message",
			id: "m1",
			message: { role: "user", content: "torn tail" },
		});
		writeFileSync(path, line.slice(0, line.length - 12), "utf-8");
		assert.equal(firstUserPreview(path), undefined);
	});
});

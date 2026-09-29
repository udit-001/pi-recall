/**
 * The failure vocabulary for reading a thread.
 *
 * Two failures look alike to the agent and need opposite next moves, so they
 * get different words. Each message ends on the move that recovers: hand over a
 * session file, or read a plain transcript with the built-in `read` tool.
 */

/** Why a thread could not be read. */
export type ThreadLookupFailure = "unknown-thread" | "not-a-session-file";

export interface ThreadLookupError {
	/** Shown to the agent; ends on the next action. */
	text: string;
	/** Machine-readable tag for the result details. */
	error: string;
}

/**
 * A session file is a `.jsonl` written by pi. Anything else on disk is a file
 * the agent can read, just not a thread.
 */
export function threadLookupError(
	failure: ThreadLookupFailure,
	ref: { threadId: string; filePath?: string },
): ThreadLookupError {
	if (failure === "not-a-session-file") {
		const path = ref.filePath ?? ref.threadId;
		return {
			text:
				`${path} carries no pi session header, so its messages cannot be read as a thread. ` +
				`A transcript in any other shape is a file: read it with the read tool, or hand over a .jsonl session file from pi.`,
			error: "not a session file",
		};
	}
	return {
		text:
			`No session matches "${ref.threadId}". ` +
			`Pass a UUID from list_threads, or a path to a .jsonl session file — one copied off another machine reads the same.`,
		error: "unknown thread",
	};
}

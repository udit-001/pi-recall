/**
 * The prior-thread rule: the running session is not history.
 *
 * A listing of prior threads is only useful if it contains no thread the agent
 * is already in — otherwise "the previous session" and "this conversation" are
 * the same row, and the agent re-reads itself. Both listing tools apply this
 * rule, so it lives here once.
 */

/** The minimum of a session's identity this rule needs. */
export interface RunningSession {
	getSessionId(): string;
	getSessionFile(): string | undefined;
}

/** What a listing knows about a thread: where it came from and when it moved. */
export interface ThreadRef {
	id: string;
	filePath: string;
}

/**
 * Is this thread the session the agent is running in?
 *
 * Both identifiers are compared because the id parsed from a session header and
 * the manager's id can disagree; matching either is what keeps the running
 * session out of a listing of prior threads.
 */
export function isRunningSession(summary: ThreadRef, session: RunningSession): boolean {
	return summary.id === session.getSessionId() || summary.filePath === session.getSessionFile();
}

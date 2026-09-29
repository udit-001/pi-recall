# Tool reference

The four tools as a ladder, cheapest call first: schemas, defaults, ordering, and
failure modes. What the project is: the [README](../README.md). Why it is built
this way: the [invariants](../AGENTS.md).

`list_threads` and `find_threads` return **prior** threads. The running
session is left out unless `include_current` is true, so the newest entry is
the most recent thread before this one.

`peek_thread` and `search_thread` both take `thread_id`: a session UUID from
either listing tool, or a path to a `.jsonl` session file. A value that starts
with `/` or ends in `.jsonl` is opened as given, with no check that it lives
under the sessions directory — which is what lets a session file copied off a
teammate's machine be read here.

## list_threads

Reads session headers only, never a message body, so a listing stays cheap on a
large history.

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `cwd` | string | — | Filter by working directory (partial match) |
| `include_current` | boolean | `false` | Include the running session |
| `limit` | number | `10` | Maximum threads to return |
| `offset` | number | `0` | Skip N threads; increment by the returned count |
| `sort` | `"recent"` \| `"oldest"` | `"recent"` | By last-modified time |

Each entry carries the thread ID, directory, first user message (truncated),
and `parentSession` when the session was forked from another. The header line
states the total and whether the running session was excluded.

## find_threads

A full-corpus scan of every session's message bodies, so reach for
`list_threads` first when the thread IDs are not what you need to find.

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `query` | string | — | **Required.** ripgrep syntax |
| `cwd` | string | — | Filter by working directory (partial match) |
| `include_current` | boolean | `false` | Include the running session |
| `limit` | number | `10` | Maximum threads to return |
| `offset` | number | `0` | Skip N ranked threads; increment by the returned count |
| `sort` | `"relevance"` \| `"recent"` \| `"oldest"` | `"relevance"` | Relevance is match count |

Each hit carries the thread ID, match count, and up to three matching-message
snippets.

## peek_thread

A bounded slice of one thread, like Unix `head`/`tail`: `head` is the oldest
messages (the gist of what the session was about), `tail` the newest (where it
ended, which is where you resume).

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `thread_id` | string | — | **Required.** Session UUID or session-file path |
| `position` | `"head"` \| `"tail"` | — | **Required.** Which end to read |
| `count` | number | `10` | Messages to return (max 50) |
| `chars_per_message` | number | `800` | Truncate each message (max 4000) |

## search_thread

One thread's messages on the active branch, read in full and narrowed by text
or role.

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `thread_id` | string | — | **Required.** Session UUID or session-file path |
| `query` | string | — | Keep messages containing this text (case-insensitive); omit for all |
| `context` | number | `0` | Messages of context before and after each match |
| `roles` | string[] | all | Filter to `user`, `assistant`, `toolResult` |
| `max_messages` | number | — | Page size; pair with `offset` |
| `offset` | number | `0` | Skip N filtered messages; increment by the returned count |
| `max_content_length` | number | — | Truncate each message to N chars |

`offset` counts within the *filtered* result: role filter, then query and its
context window, then the slice.

## When a thread will not open

Two failures, and the recovery differs:

- **No session matches** the id or path. Pass a UUID from `list_threads`, or a
  path to a `.jsonl` session file.
- **The file carries no pi session header.** Some tools write conversation
  transcripts in other shapes; the parser needs a `.jsonl` written by pi. Read
  those with the built-in `read` tool — they are files, not sessions.

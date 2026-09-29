# pi-recall

Four tools that let a pi agent recall its past conversations. It lists prior
sessions, searches what was said in them, and reads one back — straight off
your own disk, with no service in the middle.

Without it, "what did we decide about the retry logic?" means scrolling a
transcript you no longer have, or guessing. With it, the agent looks it up.

## Install

```bash
pi install git:github.com/udit-001/pi-recall
```

Or point at a local checkout in `~/.pi/agent/settings.json`:

```json
{ "packages": ["../../Dev/personal/pi-recall"] }
```

Then `pi reload`. Needs a pi that provides the `@earendil-works/*` packages
(developed against 0.99.1). Search runs on `ripgrep` when it is installed and
`grep` otherwise.

## What you get

- **Lists prior sessions.** Metadata only, newest first, optionally narrowed to
  one project directory. Cheap enough for the agent to call it on every "where
  were we?" question.
- **Searches message bodies.** ripgrep across every session, threads ranked by
  match count, with the matching snippets attached.
- **Leaves out the session you're in.** The running conversation is excluded
  from both listings, so "the previous session" is never this one. Pass
  `include_current` when you do want it, which is the move after a compaction.
- **Follows the branch that happened.** A forked session reports the
  conversation that actually occurred, not every abandoned attempt on the way
  there.
- **Bounds every read.** Head or tail slices, page limits, and per-message
  truncation, so a long session costs a screen instead of a scroll.
- **Never leaves your machine.** It reads `~/.pi/agent/sessions/`; a `thread_id`
  that is a path is read as given. Nothing is sent anywhere.

## The four tools

A ladder, cheapest first, which is the order worth calling them in:

```
list_threads → find_threads → peek_thread → search_thread
  (metadata)     (content)      (gist/tail)    (full read)
```

- `list_threads` — what sessions exist, newest first. Thread ID, directory,
  first user message, and the parent when a session was forked.
- `find_threads` — which sessions mention this, ranked, with snippets.
- `peek_thread` — the oldest or newest slice of one session, truncated per
  message. `tail` is how you resume.
- `search_thread` — one session's messages, filtered by text or role and paged.

Full parameters: [docs/tools.md](docs/tools.md).

## Your conversations

The tool reads your session history, and what it returns lands in an agent's
context. Treat its output as sensitive: the transcripts are yours, and a
session may hold credentials you pasted.

A teammate's session file reads the same as yours. Hand its path to
`peek_thread` or `search_thread` and the messages come back whole.

## Working on it

Changing the tools or the rules? Start at [AGENTS.md](AGENTS.md) — the five
invariants, which module holds the logic, and the dev loop.

MIT.

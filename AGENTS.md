# AGENTS.md

## What this is

pi-recall is a pi extension: four tools that give an agent recall over its past
conversation sessions. `list_threads` and `find_threads` enumerate **prior**
threads, `peek_thread` returns a bounded head or tail slice, `search_thread`
reads one thread's messages with filters. Sessions are read straight off disk
from `~/.pi/agent/sessions/`.

The four are a **ladder**, cheapest call first:

```
list_threads → find_threads → peek_thread → search_thread
  (metadata)     (content)      (gist/tail)    (full read)
```

`src/` is the pure logic and holds the tests: `prior.ts` carries the
prior-thread rule, `thread-errors.ts` the wording of a failed lookup.
Everything else is `index.ts`.

Schemas, defaults, and result shapes: `docs/tools.md`. Reach for it when
changing a tool's parameters or what it hands back.

## The invariants

Five rules. Each exists because breaking it makes the tools wrong in a way the
agent cannot see from the result it gets back.

1. **A listing holds prior threads.** The running session is not history: it is
   always the most recently modified file in its own cwd, so a listing hands
   back "this conversation" where the agent asked for the previous one, and the
   agent re-reads itself. `isRunningSession` in `src/prior.ts` is the one
   implementation and both listing tools route through it, matching on header
   id *and* file path because the two can disagree. `include_current` is the
   deliberate opt-in for the post-compaction re-read.

2. **Listing is a 64KB head-scan.** `headScanSessionFile` reads
   `HEAD_SCAN_BYTES` from the top of the file and stops; that bound is what
   makes `list_threads` cheap enough to call freely. Full parses belong to the
   reading path, where one thread's messages are needed.

3. **Reading follows the active branch.** A forked session is a tree. The leaf
   is the entry no other entry names as its `parentId`, and only the leaf path
   is read, so the result is the branch that happened.

4. **Nothing leaves the machine.** Search degrades rather than failing:
   ripgrep is preferred, `grep` answers when it is absent, and the fallback is
   announced to the user. A dependency that opens a socket does not belong in
   this extension.

5. **Text the agent reads carries the decision.** A tool description states cost,
   ordering, and the prior-thread exclusion as a fact about the result
   ("the running session is excluded unless `include_current` is true"), and
   behavior and description change in the same commit. A failure message ends
   on the next action — hand over a session file, or read a plain transcript
   with `read` — with that wording in `src/thread-errors.ts` so the four call
   sites cannot drift. A description that warns about a row to skip, or a
   failure that is only a verdict, costs the agent a retry loop.

## Verify

```bash
npm install && npm run typecheck && npm test
```

Then `pi reload` and round-trip the ladder once: `list_threads` for this
project, `find_threads` on a phrase from it, `peek_thread` on the result,
`search_thread` on that thread. The run is done when all four return and the
listing's header line reports the running session as excluded.

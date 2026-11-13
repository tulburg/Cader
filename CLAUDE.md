# Cader

Cader is a standalone desktop app (Bun + Electron) for writing blogs and speeches by voice. You dictate with Handy and a local Whisper model; Cader proofreads the text, corrects grammar, suggests rephrasings and stronger word substitutions for any highlighted span, and offers alternative ways to say a whole sentence. Every review pass is saved as a version until the piece is published. All models run locally.

---

## 1. Communication & output style

Prose (chat replies, commit messages, PR text, markdown, comments):
- **No em dashes.** Rewrite the sentence with a comma, semicolon, colon, period, or parentheses instead of an `—`. This targets em dashes and their look-alikes (`--`, spaced `-`, stray en dashes), not real hyphens: leave compound adjectives (`well-known`), ranges (`10-20`, `2019-2024`), and anything in code, paths, or URLs alone.
- Prefer plain ASCII punctuation and straight quotes over smart quotes and other Unicode decoration.
- No emojis unless the user asks for them.
- Skip filler openers ("Sure!", "Great question") and hollow closings ("Hope this helps!", "Let me know if..."). Answer directly and do not restate the request back.
- Be concise: short, direct statements over verbose explanation. Say "I don't know" rather than guess; do not invent APIs, files, or flags.

## 2. Code & scope

- Stay within the requested scope. No unsolicited refactors, renames, or "while I'm here" changes to code outside the task.
- Do not add or upgrade dependencies without listing them and asking first.
- Do not delete existing comments or code unrelated to the change.
- Prefer the simplest working solution; do not over-engineer or add abstraction that wasn't asked for.
- Treat user corrections as authoritative for the rest of the session.

## 3. Repo etiquette

- Branch off `main`; land changes via pull request (do not push to `main`).
- Match the style of the code you're editing.
- Verify a change by running it (tests, the app, the browser), not by reading it.

## 4. Specs live in Spill

**Always listen to the board.** At the start of every session, open a Spill listener (a background
monitor on `.spill/events.jsonl` that reports every user action) and check `spill_inbox`. Keep the
listener running for the whole session, re-arming it whenever it expires, and act on each event
as it arrives.

**Queued is the go-ahead.** Never ask in chat whether to build a spec. A spec the user queued
(Build) is the confirmation: build it, then go straight on to the next queued spec until the
queue is empty. Dependencies a queued spec needs are covered by the same confirmation; list them
on the spec card instead of asking.


Every question, spec, and decision for this project is tracked in **Spill**, the visual spec board.
The user watches the board to see what is being asked, approved, and worked on, so the board must
always reflect reality. Full instructions: [`.spill/SPILL.md`](.spill/SPILL.md). Read it at the
start of every session that touches product behavior.

The short version:
- **Most important: fetch and update spec state.** Check the board before each step, and never
  leave a spec `active` when you are not building it. When you stop for any reason (done, waiting
  on the user, blocked, switching away), move it in the same step: `done`, a question that blocks
  it, or back to `discussing`. Check every active spec before ending a turn.
- **Specs before code.** No feature code without an `approved` spec. Draft it on the board first.
- **Build means build.** Approved is not a go. When the user presses Build (the spec is `queued`),
  start building it without waiting to be asked (one active spec at a time, in the order queued).
- **Too large? Recommend a split.** At any point before a spec is done, if it has grown too large
  to build and check as one piece, ask on the board to break it into smaller specs, naming them.
  A split is a reorganization: each part is a complete spec that owns its questions and decisions
  (moved from the original), and the original is rewritten as the overview.
- **Questions go on the board, not only in chat.** Every question you need answered becomes a
  `Q-n` card. Check the board for answers (and for questions the user added) before asking again.
- **Move cards as you work.** Set a spec `active` when you start it and `done` when it ships.
  Only one spec is `active` per session unless the user says otherwise.
- **An answer that picks none of the options is a redirect.** Read it and act on what it means:
  an answer of the user's own is recorded as the decision; "this shouldn't be a question" drops the
  question (comment why); only an unclear question is rewritten and reopened. Never open a new
  question for the same thing.
- **Designs are drawn in Spill, on the spec.** UI changes are drawn first with Spill's design
  tools and reviewed on the board, then built.
- **Never approve or reject your own cards.** Only the user moves a card to `approved`, `queued` or `rejected`
  (the board can also auto-approve; that is not you).
- If the Spill MCP server is not connected, use the file fallback in `.spill/` described in
  `SPILL.md`, and say so once.

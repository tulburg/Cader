import { expect, test } from "bun:test";
import { applyEdit, changedWords, dictationFixes, diff, sentences, wordDiff } from "./proofread";

test("splits sentences with offsets", () => {
  const p = "First one. Second one? Third without end";
  expect(sentences(p)).toEqual([
    { text: "First one.", start: 0 },
    { text: "Second one?", start: 11 },
    { text: "Third without end", start: 23 },
  ]);
});

test("describes each correction with a reason", () => {
  const s = "The people who has worked on this renovaton gave more then there time";
  const fixed = "The people who have worked on this renovation gave more than their time.";
  const edits = diff(s, fixed);
  expect(edits.map((e) => [e.from, e.to, e.reason, e.auto])).toEqual([
    ["has", "have", "Grammar", false],
    ["renovaton", "renovation", "Spelling", true],
    ["then", "than", "Commonly confused word", false],
    ["there", "their", "Commonly confused word", false],
    ["time", "time.", "Missing end punctuation", false],
  ]);
});

test("flags dictation artifacts as their own kind", () => {
  const s = "So um, we went to the the library";
  const fixed = dictationFixes(s, true);
  expect(fixed).toBe("So we went to the library.");
  const edits = diff(s, fixed);
  expect(edits.map((e) => [e.reason, e.kind])).toEqual([
    ["Filler word", "dictation"],
    ["Repeated word", "dictation"],
    ["Missing end punctuation", "dictation"],
  ]);
});

test("accepting every edit, last first, yields the corrected sentence", () => {
  const s = "Me and my sister goes to the libary every weeks";
  const fixed = "My sister and I go to the library every week.";
  let out = s;
  for (const e of diff(s, fixed).reverse()) out = applyEdit(out, e);
  expect(out).toBe(fixed);
});

test("a doubled word next to a misspelling stays two edits", () => {
  const s = "on the the renovaton gave";
  expect(diff(s, "on the renovation gave").map((e) => [e.from, e.reason, e.auto])).toEqual([
    ["the", "Repeated word", false],
    ["renovaton", "Spelling", true],
  ]);
});

test("tense and ending changes are reviewed, not auto-fixed", () => {
  for (const [a, b] of [["come", "came"], ["work", "worked"], ["goes", "go"], ["build", "building"]]) {
    expect(diff(`They ${a} home.`, `They ${b} home.`)[0].auto).toBe(false);
  }
  expect(diff("A seperate room.", "A separate room.")[0].auto).toBe(true);
  expect(diff("We recieved it.", "We received it.")[0].auto).toBe(true);
});

test("a removed word leaves no double space", () => {
  const s = "Well um, it works.";
  const edits = diff(s, "Well, it works.");
  expect(edits.map((e) => e.reason)).toEqual(["Punctuation", "Filler word"]);
  expect(applyEdit(s, edits[1])).toBe("Well it works.");
  expect(edits.reverse().reduce(applyEdit, s)).toBe("Well, it works.");
});

test("marks the words an alternative changes", () => {
  const got = changedWords("So let me begin with a simple thank you.", "Let me begin, simply, by thanking you.");
  expect(got.filter((w) => w.changed).map((w) => w.text)).toEqual(["simply,", "by", "thanking"]);
  expect(got.map((w) => w.text).join(" ")).toBe("Let me begin, simply, by thanking you.");
});

test("word diff between versions", () => {
  expect(wordDiff("The people who has worked here.", "The people who have worked here.")).toEqual([
    { op: "same", text: "The people who" },
    { op: "del", text: "has" },
    { op: "ins", text: "have" },
    { op: "same", text: "worked here." },
  ]);
  expect(wordDiff("a promise that was made", "a promise made")).toEqual([
    { op: "same", text: "a promise" },
    { op: "del", text: "that was" },
    { op: "same", text: "made" },
  ]);
  expect(wordDiff("", "New text.")).toEqual([{ op: "ins", text: "New text." }]);
});

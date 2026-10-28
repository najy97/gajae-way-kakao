import { expect, test } from "bun:test";
import { batches, toBubbles } from "../src/bubbles";

test("empty text has no bubbles, exact 1000 stays whole and 1001 splits", () => {
	expect(toBubbles("")).toEqual([]);
	expect(toBubbles("x".repeat(1_000))).toEqual(["x".repeat(1_000)]);
	expect(toBubbles("x".repeat(1_001)).map((part) => part.length)).toEqual([1_000, 1]);
});

test("split prefers the last newline over a later space, then space over hard cut", () => {
	const text = `${"a".repeat(400)}\n${"b".repeat(400)}\n${"c".repeat(100)} ${"d".repeat(200)}`;
	const parts = toBubbles(text);
	expect(parts[0]).toBe(`${"a".repeat(400)}\n${"b".repeat(400)}\n`);
	expect(parts.join("")).toBe(text);
	const spaced = `${"x".repeat(900)} ${"y".repeat(200)}`;
	expect(toBubbles(spaced)[0]).toBe(`${"x".repeat(900)} `);
});

test("3500 characters become four bubbles and two batches of at most three", () => {
	const parts = toBubbles("x".repeat(3_500));
	expect(parts.map((part) => part.length)).toEqual([1_000, 1_000, 1_000, 500]);
	expect(batches(parts).map((batch) => batch.length)).toEqual([3, 1]);
	expect(batches([])).toEqual([]);
});

test("boundaries never produce empty chunks or split an astral character", () => {
	for (const text of [`\n${"x".repeat(1_001)}`, " ".repeat(2_001), `${"x".repeat(999)}😀tail`]) {
		const parts = toBubbles(text);
		expect(parts.join("")).toBe(text);
		expect(parts.every((part) => part.length > 0 && part.length <= 1_000 && part.isWellFormed())).toBe(true);
	}
});

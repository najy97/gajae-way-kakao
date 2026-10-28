/**
 * SkillResponse simpleText is limited to 1,000 characters per bubble. `prefix` (mention
 * placeholders) opens the first bubble and takes its room there; it is never a split point.
 */
export function toBubbles(text: string, prefix = ""): string[] {
	const result: string[] = [];
	let rest = text;
	while (rest.length > (result.length === 0 ? 1_000 - prefix.length : 1_000)) {
		let end = result.length === 0 ? 1_000 - prefix.length : 1_000;
		// Do not cut a UTF-16 surrogate pair at the hard boundary.
		if (/[\uD800-\uDBFF]/.test(rest[end - 1] ?? "")) end--;
		const window = rest.slice(0, end);
		const newline = window.lastIndexOf("\n");
		const space = window.lastIndexOf(" ");
		const boundary = newline >= 0 ? newline : space;
		if (boundary >= 0) end = boundary + 1;
		result.push(rest.slice(0, end));
		rest = rest.slice(end);
	}
	if (rest) result.push(rest);
	if (result.length > 0 && prefix) result[0] = `${prefix}${result[0]}`;
	return result;
}

/** A SkillResponse may carry at most three output bubbles. */
export function batches(bubbles: readonly string[]): string[][] {
	const result: string[][] = [];
	for (let index = 0; index < bubbles.length; index += 3) result.push(bubbles.slice(index, index + 3));
	return result;
}

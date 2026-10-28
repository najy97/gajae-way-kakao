import { expect, test } from "bun:test";
import { currentConversationNotice } from "../../gateway/src/server/server";

test("Kakao guidance excludes reactions, automatic eyes acknowledgement and threaded replies", () => {
	const text = currentConversationNotice({ platform: "kakao", kind: "channel", conversationId: "bg2_group" });
	expect(text).not.toContain("Reaction replies:");
	expect(text).not.toContain("The gateway already marks the message 👀");
	expect(text).not.toContain("Threaded replies:");
	expect(text).toContain("Posting to another room:");
	expect(text).toContain("Handoffs:");
});

test("existing chat platforms retain reaction, automatic acknowledgement and threading guidance", () => {
	for (const platform of ["discord", "telegram", "slack"] as const) {
		const text = currentConversationNotice({ platform, kind: "channel", conversationId: "room" });
		expect(text).toContain("Reaction replies: start your reply with [REACT:<emoji>]");
		expect(text).toContain(
			" The gateway already marks the message 👀 when it lands, so do not spend your reply on another reaction.",
		);
		expect(text).toContain("Threaded replies: start a reply part with [REPLY:<message id>]");
	}
	const loopback = currentConversationNotice({ platform: "loopback", kind: "loopback", conversationId: "loopback" });
	expect(loopback).not.toContain("Reaction replies:");
	expect(loopback).not.toContain("The gateway already marks the message 👀");
});

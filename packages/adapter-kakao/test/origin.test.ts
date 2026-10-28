import { expect, test } from "bun:test";
import {
	originKey,
	platformSupportsReaction,
	REACTION_ALLOWLIST,
	reactionAllowlistDescription,
	reactionAllowlistFor,
} from "@gajae-gateway/protocol";
import { kakaoMessageOrigin, seg } from "../src/origin";

const keys = {
	botGroupKey: "bg2_ExampleBotId0000000000000000000000",
	botUserKey: "bu2_ExampleUserId000000000000000000000",
};

test("channel chatroom is a DM scoped to both original bot keys", () => {
	const origin = kakaoMessageOrigin({ ...keys, isChannelChatroom: true });
	expect(origin).toEqual({ platform: "kakao", kind: "dm", conversationId: keys.botGroupKey, peerId: keys.botUserKey });
	expect(originKey(origin)).toBe(`kakao/dm/${keys.botGroupKey}/peer=${keys.botUserKey}`);
});

test("normal, open and team chatrooms share channel mapping", () => {
	const origin = kakaoMessageOrigin({ ...keys, isChannelChatroom: false });
	expect(origin).toEqual({ platform: "kakao", kind: "channel", conversationId: keys.botGroupKey });
	expect(originKey(origin)).toBe(`kakao/channel/${keys.botGroupKey}`);
});

test("segments retain protocol-safe keys and base64url encode unsafe keys without padding", () => {
	expect(seg("a_.:@+-9")).toBe("a_.:@+-9");
	for (const value of ["한글/채팅", "key=value", "", "b64.Lw"]) {
		expect(seg(value)).toBe(`b64.${Buffer.from(value).toString("base64url")}`);
		expect(seg(value)).not.toMatch(/[=/+]/);
	}
	const origin = kakaoMessageOrigin({ botGroupKey: "그룹/키", botUserKey: "사용자?", isChannelChatroom: true });
	expect(originKey(origin)).toBe(`kakao/dm/${seg("그룹/키")}/peer=${seg("사용자?")}`);
});

test("reserved encoding prefix prevents collisions and every generated origin is protocol-valid", () => {
	const origins = ["/", "b64.Lw", "a".repeat(256), "한글"].map((botGroupKey) =>
		kakaoMessageOrigin({ botGroupKey, botUserKey: "b64.Lw", isChannelChatroom: true }),
	);
	expect(originKey(origins[0]!)).not.toBe(originKey(origins[1]!));
	for (const origin of origins) expect(() => originKey(origin)).not.toThrow();
	for (const botGroupKey of ["a".repeat(257), "한".repeat(100), "b64." + "a".repeat(252)])
		expect(() => kakaoMessageOrigin({ botGroupKey, botUserKey: "user", isChannelChatroom: false })).toThrow("256");
});

test("Kakao cannot deliver any reaction, including custom reactions", () => {
	for (const name of [...REACTION_ALLOWLIST.map((entry) => entry.name), "custom_emoji"])
		expect(platformSupportsReaction("kakao", name)).toBe(false);
	expect(reactionAllowlistFor("kakao")).toEqual([]);
	expect(reactionAllowlistDescription("kakao")).toBe("none (reactions are not supported)");
});

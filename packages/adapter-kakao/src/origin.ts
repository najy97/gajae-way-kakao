import type { OriginRef } from "@gajae-gateway/protocol";

export interface KakaoMessageOriginShape {
	readonly botGroupKey: string;
	readonly botUserKey: string;
	readonly isChannelChatroom: boolean;
}

export function seg(value: string): string {
	const encoded =
		/^[A-Za-z0-9_.:@+-]{1,256}$/.test(value) && !value.startsWith("b64.")
			? value
			: `b64.${Buffer.from(value, "utf8").toString("base64url")}`;
	if (encoded.length > 256) throw new Error("Kakao origin segment exceeds 256 characters");
	return encoded;
}

export function kakaoMessageOrigin(message: KakaoMessageOriginShape): OriginRef {
	return message.isChannelChatroom
		? { platform: "kakao", kind: "dm", conversationId: seg(message.botGroupKey), peerId: seg(message.botUserKey) }
		: { platform: "kakao", kind: "channel", conversationId: seg(message.botGroupKey) };
}

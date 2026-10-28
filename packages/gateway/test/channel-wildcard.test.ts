import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kakaoMessageOrigin } from "../../adapter-kakao/src/origin";
import { type GatewayConfig, parseConfigFile } from "../src/config";
import {
	decideEngagement,
	resolveBotAudienceLimits,
	resolveChannelPolicy,
	threadMuteAddressed,
} from "../src/engagement/policy";
import { buildSessionBootstrap } from "../src/persona/bootstrap";
import { replyTargetConversation, resolvePostTarget } from "../src/server/server";

const config: GatewayConfig = {
	schemaVersion: 1,
	home: "/tmp/wildcard-home",
	configPath: "/tmp/wildcard-home/config.json",
	socketPath: "/tmp/wildcard-home/gateway.sock",
	dbPath: "/tmp/wildcard-home/gateway.db",
	gjc: { agentDir: "/tmp/wildcard-home/agent" },
	channels: {
		"kakao:*": {
			engagement: "open",
			audience: "human-only",
			botAudienceMaxConsecutiveTurns: 4,
			botAudienceMaxTurnsPerWindow: 7,
		},
	},
};
const origin = kakaoMessageOrigin({
	botGroupKey: "unpredictable-room-key",
	botUserKey: "human",
	isChannelChatroom: false,
});
let home = "";
afterEach(async () => {
	if (home) await rm(home, { recursive: true, force: true });
	home = "";
});

test("channel parser accepts platform wildcard keys but still rejects unknown policy fields", () => {
	expect(parseConfigFile({ schemaVersion: 1, channels: config.channels }).channels).toEqual(config.channels);
	expect(() => parseConfigFile({ schemaVersion: 1, channels: { "kakao:*": { typo: true } } })).toThrow(/unknown field/);
});

test("platform wildcard applies only after exact conversation and parent policies", () => {
	expect(resolveChannelPolicy(origin, config)).toBe(config.channels?.["kakao:*"]);
	const exact = { engagement: "closed" as const };
	const withExact = { ...config, channels: { ...config.channels, [`kakao:${origin.conversationId}`]: exact } };
	expect(resolveChannelPolicy(origin, withExact)).toBe(exact);
	expect(
		resolveChannelPolicy(
			{ ...origin, parentId: "parent" },
			{ ...config, channels: { ...config.channels, "kakao:parent": exact } },
		),
	).toBe(exact);
	// Even an empty exact policy wins as a whole. Wildcards do not merge into it.
	expect(
		resolveChannelPolicy(origin, {
			...config,
			channels: { ...config.channels, [`kakao:${origin.conversationId}`]: {} },
		}),
	).toEqual({});
	expect(resolveChannelPolicy({ ...origin, platform: "slack" }, config)).toBeUndefined();
	expect(resolveChannelPolicy(origin, { ...config, channels: undefined })).toBeUndefined();
	const discord = { ...config, channels: { "discord:*": { engagement: "open" as const }, parent: exact } };
	expect(resolveChannelPolicy({ platform: "discord", conversationId: "thread", parentId: "parent" }, discord)).toBe(
		exact,
	);
});

test("open wildcard engages Kakao group humans, including non-allowlisted authors, but not bots", () => {
	const engagement = { mentioned: true, group: true, authorId: "human" };
	expect(decideEngagement(origin, engagement, { ...config, channels: undefined }).engaged).toBe(false);
	expect(decideEngagement(origin, engagement, config)).toEqual({ engaged: true, botAudienceAdmission: false });
	expect(decideEngagement(origin, { ...engagement, mentioned: false }, config).engaged).toBe(true);
	expect(decideEngagement(origin, { ...engagement, authorIsBot: true }, config).engaged).toBe(false);
});

test("bot budgets and muted-thread addressing use the platform default policy", () => {
	expect(resolveBotAudienceLimits(origin, config)).toEqual({ maxConsecutiveTurns: 4, maxTurnsPerWindow: 7 });
	expect(threadMuteAddressed({ mentioned: true, group: true, authorId: "human" }, origin, config)).toBe(false);
	expect(
		threadMuteAddressed({ mentioned: true, explicitMention: true, group: true, authorId: "human" }, origin, config),
	).toBe(true);
});

test("wildcard never makes another room a POST or REPLY target; only an exact entry does", () => {
	const target = { platform: "kakao", kind: "channel", conversationId: "other-room" } as const;
	// A prompt-injected persona in one Kakao room must not write into another room the bot knows.
	expect(resolvePostTarget("kakao/channel/other-room", origin, config)).toEqual({
		ok: false,
		reason: "unconfigured_channel",
	});
	expect(resolvePostTarget("kakao:other-room", origin, config)).toEqual({ ok: false, reason: "unconfigured_channel" });
	expect(replyTargetConversation("kakao/channel/other-room", origin, config)).toEqual({
		ok: false,
		reason: "unconfigured_channel",
	});
	const listed = { ...config, channels: { ...config.channels, "kakao:other-room": { engagement: "closed" as const } } };
	expect(resolvePostTarget("kakao/channel/other-room", origin, listed)).toEqual({
		ok: true,
		target,
		key: "kakao/channel/other-room",
	});
	expect(resolvePostTarget("kakao/channel/other-room", origin, { ...config, channels: undefined })).toEqual({
		ok: false,
		reason: "unconfigured_channel",
	});
	expect(resolvePostTarget("kakao/dm/dm-room/peer=human", origin, listed)).toEqual({
		ok: false,
		reason: "not_a_channel",
	});
	expect(resolvePostTarget("slack/channel/other-room", origin, listed)).toEqual({
		ok: false,
		reason: "other_platform",
	});
	expect(resolvePostTarget(`kakao/channel/${origin.conversationId}`, origin, listed)).toEqual({
		ok: false,
		reason: "current_conversation",
	});
	// A bare id under a wildcard stays a message id (threads here), not a cross-room post.
	const discordOrigin = { platform: "discord", kind: "channel", conversationId: "here" } as const;
	expect(
		replyTargetConversation("123456789", discordOrigin, {
			...config,
			channels: { "discord:*": { engagement: "open" } },
		}),
	).toBeUndefined();
});

test("bootstrap describes wildcard engagement and audience for an unlisted Kakao room", async () => {
	home = await mkdtemp(join(tmpdir(), "gajaeway-wildcard-bootstrap-"));
	const bootstrap = await buildSessionBootstrap({ home, origin, epoch: 0, config: { ...config, home } });
	expect(bootstrap.text).toContain(`origin: kakao/channel/${origin.conversationId}`);
	expect(bootstrap.text).toContain("engagement-gate: open");
	expect(bootstrap.text).toContain("engagement-audience: human-only");
});

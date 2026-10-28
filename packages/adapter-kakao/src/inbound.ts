import { type OriginRef, originKey } from "@gajae-gateway/protocol";
import type { DeliveryClock, GatewayRequester } from "./delivery";
import { kakaoMessageOrigin } from "./origin";
import type { KakaoAdapterState, KakaoReplyRoute } from "./state";

interface PendingInbound {
	readonly origin: OriginRef;
	readonly route: KakaoReplyRoute;
	readonly params: Record<string, unknown>;
}

/** Kakao replays up to 100 events per connection on RESUME; remember well beyond that. */
const SEEN_MESSAGE_LIMIT = 2_000;

export class KakaoInbound {
	readonly #queues = new Map<string, PendingInbound[]>();
	readonly #pending = new Set<PendingInbound>();
	readonly #seen = new Set<string>();
	readonly #running = new Map<string, Promise<void>>();
	readonly #timers = new Map<string, unknown>();
	readonly #attempts = new Map<string, number>();
	#stopped = false;

	constructor(
		private readonly gateway: GatewayRequester,
		private readonly state: KakaoAdapterState,
		private readonly now: () => number = Date.now,
		private readonly log: Pick<Console, "info"> = console,
		private readonly clock: Pick<DeliveryClock, "setTimeout" | "clearTimeout"> = {
			setTimeout: (callback, delay) => setTimeout(callback, delay),
			clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
		},
	) {}

	async handleDispatch(type: string, data: Record<string, unknown>, receivedAt = this.now()): Promise<void> {
		if (this.#stopped) return;
		if (type !== "MESSAGE_CREATE") {
			this.log.info(`kakao_event type=${type}`);
			return;
		}
		if (
			typeof data.content !== "string" ||
			!data.content.trim() ||
			typeof data.botGroupKey !== "string" ||
			!data.botGroupKey ||
			typeof data.botUserKey !== "string" ||
			!data.botUserKey ||
			typeof data.isChannelChatroom !== "boolean"
		)
			return;
		if (typeof data.id !== "string" && !(typeof data.id === "number" && Number.isSafeInteger(data.id))) return;
		let origin: OriginRef;
		try {
			origin = kakaoMessageOrigin({
				botGroupKey: data.botGroupKey,
				botUserKey: data.botUserKey,
				isChannelChatroom: data.isChannelChatroom,
			});
		} catch {
			this.log.info("kakao_inbound result=invalid_origin");
			return;
		}
		const key = originKey(origin);
		const messageId = `${data.botGroupKey}:${data.id}`;
		// A RESUME replay re-dispatches events this adapter already took in. The gateway
		// dedups chat.send by messageId, but the replayed callback token would be
		// reinstalled after delivery consumed it, so a seen message is dropped whole.
		if (this.#seen.has(messageId)) {
			this.log.info(`kakao_inbound origin=${key} result=duplicate`);
			return;
		}
		this.#seen.add(messageId);
		if (this.#seen.size > SEEN_MESSAGE_LIMIT) this.#seen.delete(this.#seen.values().next().value!);
		// Install once on receipt, never on retry after consumption or replacement.
		if (typeof data.callbackToken === "string" && data.callbackToken)
			this.state.rememberToken(origin, data.callbackToken, receivedAt);
		const event: PendingInbound = {
			origin,
			route: { botGroupKey: data.botGroupKey, botUserKey: data.botUserKey, channelChatroom: data.isChannelChatroom },
			params: {
				origin,
				text: data.content,
				messageId,
				receivedAt: data.timestamp,
				engagement: { mentioned: true, group: !data.isChannelChatroom, authorId: data.botUserKey },
			},
		};
		const queue = this.#queues.get(key) ?? [];
		queue.push(event);
		this.#queues.set(key, queue);
		this.#pending.add(event);
		if (this.#pending.size > 500) {
			const oldest = this.#pending.values().next().value!;
			this.#pending.delete(oldest);
			const oldQueue = this.#queues.get(originKey(oldest.origin));
			const index = oldQueue?.indexOf(oldest) ?? -1;
			if (index >= 0) oldQueue!.splice(index, 1);
			this.log.info("kakao_inbound result=queue_full dropped=oldest");
		}
		if (!this.#timers.has(key)) await this.#drain(key);
	}

	stop(): void {
		this.#stopped = true;
		for (const timer of this.#timers.values()) this.clock.clearTimeout(timer);
		this.#timers.clear();
	}

	#drain(key: string): Promise<void> {
		const running = this.#running.get(key);
		if (running) return running;
		const next = this.#sendQueued(key).finally(() => this.#running.delete(key));
		this.#running.set(key, next);
		return next;
	}

	async #sendQueued(key: string): Promise<void> {
		const queue = this.#queues.get(key)!;
		while (queue.length && !this.#stopped) {
			const event = queue[0]!;
			try {
				await this.state.rememberRoute(event.origin, event.route);
				if (this.#stopped) return;
				await this.gateway.request("chat.send", event.params);
			} catch {
				if (this.#stopped) return;
				const attempt = this.#attempts.get(key) ?? 0;
				this.#attempts.set(key, attempt + 1);
				const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
				this.log.info(`kakao_inbound origin=${key} result=retry retry_in_ms=${delay}`);
				this.#timers.set(
					key,
					this.clock.setTimeout(() => {
						this.#timers.delete(key);
						void this.#drain(key);
					}, delay),
				);
				return;
			}
			this.#attempts.delete(key);
			this.#pending.delete(event);
			if (queue[0] === event) queue.shift();
		}
		this.#queues.delete(key);
	}
}

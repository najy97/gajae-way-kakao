import { type ChatMessagePayload, type ChatProgressPayload, type OriginRef, originKey } from "@gajae-gateway/protocol";
import {
	KAKAO_MAX_MENTIONS,
	KAKAO_REQUEST_TIMEOUT_MS,
	KakaoApiError,
	type KakaoBotApi,
	type KakaoMentions,
} from "./api";
import { batches, toBubbles } from "./bubbles";
import type { KakaoAdapterState } from "./state";

/** Mention placeholder prefix for the people a group-room reply answers (asker1, asker2, ...). */
const ASKER = "asker";

/**
 * Model text must never become Kakao template syntax: a literal `{{#mentions.x}}` would
 * otherwise let a prompt-injected reply mention or break against arbitrary keys.
 */
export function neutralizeMentionSyntax(text: string): string {
	return text.replaceAll("{{#", "{ {#");
}

export interface GatewayRequester {
	request<T = unknown>(verb: string, params?: unknown): Promise<T>;
}

export interface DeliveryClock {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(timer: unknown): void;
}

const realClock: DeliveryClock = {
	now: () => Date.now(),
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

interface BufferedDelivery {
	readonly deliveryId: string;
	readonly text: string;
	readonly askerIds: readonly string[];
}

/** Callback credentials are single-use and intentionally expire before Kakao's five-minute limit. */
export class KakaoDelivery {
	readonly #buffers = new Map<string, BufferedDelivery[]>();
	readonly #chains = new Map<string, Promise<void>>();
	readonly #timers = new Map<string, unknown>();
	readonly #pending = new Set<string>();
	readonly #runningTurns = new Map<string, Set<string>>();
	readonly #settlementTimers = new Map<string, unknown>();
	#stopped = false;

	constructor(
		private readonly gateway: GatewayRequester,
		private readonly bot: Pick<KakaoBotApi, "callback" | "sendMessage">,
		private readonly state: KakaoAdapterState,
		private readonly clock: DeliveryClock = realClock,
		private readonly log: Pick<Console, "info" | "error"> = console,
	) {}

	onChatMessage(message: ChatMessagePayload): Promise<void> {
		if (this.#stopped || message.origin.platform !== "kakao" || !message.deliveryId) return Promise.resolve();
		if (message.reaction || message.file) {
			return this.gateway.request<void>("delivery.fail", {
				deliveryId: message.deliveryId,
				reason: `Kakao does not support ${message.reaction ? "reaction" : "file"} deliveries`,
				ambiguous: false,
			});
		}
		if (this.#pending.has(message.deliveryId)) return Promise.resolve();
		this.#pending.add(message.deliveryId);
		const key = originKey(message.origin);
		const buffer = this.#buffers.get(key) ?? [];
		buffer.push({
			deliveryId: message.deliveryId,
			text: `${message.duplicateWarning ? "[복구됨, 중복일 수 있음] " : ""}${message.text}`,
			askerIds: message.askerIds ?? [],
		});
		this.#buffers.set(key, buffer);
		const token = this.#usableToken(message.origin);
		// A chat.message carries a per-delivery id, not the inbound turn id that chat.send
		// and chat.progress use, so interims are matched to a turn by origin: while a turn
		// is running here, non-final output is held with that turn's speech. In an idle room
		// a non-final message (restart notice, post from another room) goes out at once; in
		// a busy room it cannot be told apart and waits for the turn's end or the deadline.
		if (message.final) this.#runningTurns.delete(key);
		const running = (this.#runningTurns.get(key)?.size ?? 0) > 0;
		if (message.final || !token || !running) return this.flush(message.origin);
		const delay = token.receivedAt + 255_000 - this.clock.now();
		if (delay <= 0) return this.flush(message.origin);
		this.#clearTimer(key);
		this.#timers.set(
			key,
			this.clock.setTimeout(() => {
				void this.flush(message.origin);
			}, delay),
		);
		return Promise.resolve();
	}

	onChatProgress(progress: ChatProgressPayload): Promise<void> {
		if (this.#stopped || progress.origin.platform !== "kakao") return Promise.resolve();
		if (!progress.final) {
			this.onTurnStarted(progress.origin, progress.turnId);
			return Promise.resolve();
		}
		this.#runningTurns.get(originKey(progress.origin))?.delete(progress.turnId);
		return this.flush(progress.origin);
	}

	onTurnStarted(origin: OriginRef, turnId: string): void {
		if (this.#stopped || origin.platform !== "kakao") return;
		const key = originKey(origin);
		const turns = this.#runningTurns.get(key) ?? new Set<string>();
		turns.add(turnId);
		this.#runningTurns.set(key, turns);
	}

	stop(): void {
		this.#stopped = true;
		for (const key of this.#timers.keys()) this.#clearTimer(key);
		for (const timer of this.#settlementTimers.values()) this.clock.clearTimeout(timer);
		this.#settlementTimers.clear();
	}

	flush(origin: OriginRef): Promise<void> {
		if (this.#stopped) return Promise.resolve();
		const key = originKey(origin);
		this.#clearTimer(key);
		const buffer = this.#buffers.get(key);
		if (!buffer?.length) return this.#chains.get(key) ?? Promise.resolve();
		this.#buffers.delete(key);
		const previous = this.#chains.get(key) ?? Promise.resolve();
		const next = previous
			.then(() => this.#deliver(origin, buffer))
			.catch(() => {
				// Settlement may fail during a gateway restart. Its ledger replays the delivery.
				this.log.error(`kakao_delivery origin=${key} result=settlement_failed`);
			})
			.finally(() => {
				if (this.#chains.get(key) === next) this.#chains.delete(key);
			});
		this.#chains.set(key, next);
		return next;
	}

	#usableToken(origin: OriginRef) {
		const token = this.state.tokenFor(origin);
		return token && this.clock.now() - token.receivedAt < 270_000 - KAKAO_REQUEST_TIMEOUT_MS ? token : undefined;
	}

	async #settle(deliveryId: string, failure?: { reason: string; ambiguous: boolean }, attempt = 0): Promise<void> {
		if (this.#stopped) return;
		try {
			await this.gateway.request(failure ? "delivery.fail" : "delivery.confirm", { deliveryId, ...failure });
			this.#pending.delete(deliveryId);
		} catch {
			if (this.#stopped) return;
			// Only confirm is idempotent in the ledger. Every delivery.fail counts an attempt,
			// so a fail whose answer was lost is not resent. Whether or not the gateway
			// committed it, the row is still unsettled (inflight, pending or failed_ambiguous)
			// or expired, and the ledger sweep decides any reissue, handled here as new.
			if (failure) {
				this.#pending.delete(deliveryId);
				this.log.error("kakao_delivery result=fail_unacknowledged");
				return;
			}
			this.log.error("kakao_delivery result=settlement_retry");
			this.#settlementTimers.set(
				deliveryId,
				this.clock.setTimeout(
					() => {
						this.#settlementTimers.delete(deliveryId);
						void this.#settle(deliveryId, failure, attempt + 1);
					},
					Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5)),
				),
			);
		}
	}

	#clearTimer(key: string): void {
		if (this.#timers.has(key)) this.clock.clearTimeout(this.#timers.get(key));
		this.#timers.delete(key);
	}

	async #deliver(origin: OriginRef, buffer: readonly BufferedDelivery[]): Promise<void> {
		if (this.#stopped) return;
		const key = originKey(origin);
		const text = neutralizeMentionSyntax(
			buffer
				.map((entry) => entry.text)
				.filter(Boolean)
				.join("\n\n"),
		);
		const route = this.state.routeFor(origin);
		const token = this.#usableToken(origin);
		// A group-room reply (channel chat has no mentions) mentions the people the gateway
		// says its turn answered. A reply without that attribution goes out unmentioned.
		const askers =
			text && route && !route.channelChatroom
				? [...new Set(buffer.flatMap((entry) => entry.askerIds))].slice(-KAKAO_MAX_MENTIONS)
				: [];
		const mentions: KakaoMentions | undefined =
			askers.length > 0 ? Object.fromEntries(askers.map((id, index) => [`${ASKER}${index + 1}`, id])) : undefined;
		const plain = toBubbles(text);
		let bubbles = mentions
			? toBubbles(
					text,
					`${Object.keys(mentions)
						.map((name) => `{{#mentions.${name}}}`)
						.join(" ")} `,
				)
			: plain;
		let path = token ? "callback" : "send_message";
		let posted = false;
		let failure: { reason: string; ambiguous: boolean } | undefined;
		let result = "confirmed";
		try {
			try {
				if (bubbles.length > 0) {
					if (!route) throw new KakaoApiError(400, "Kakao origin has no reply route");
					if (token) this.state.takeToken(origin);
					let groups = batches(bubbles);
					for (let index = 0; index < groups.length; index++) {
						const group = groups[index] as string[];
						if (index > 0) await this.bot.sendMessage(route, group);
						else {
							try {
								// Placeholders open the text, so only the first request carries mentions.
								if (token) await this.bot.callback(token.token, group, mentions);
								else await this.bot.sendMessage(route, group, mentions);
							} catch (error) {
								// Kakao refused the mentioned request outright (a definitive refusal posts
								// nothing). The mention must not cost the answer: send it plain, once,
								// through send_message, because a callback token is single-use.
								if (!mentions || !(error instanceof KakaoApiError)) throw error;
								this.log.error(`kakao_delivery origin=${key} result=mention_refused`);
								bubbles = plain;
								groups = batches(bubbles);
								path = `${path}+send_message`;
								await this.bot.sendMessage(route, groups[0] as string[]);
							}
						}
						posted = true;
					}
				}
			} catch (error) {
				failure = {
					reason: error instanceof Error ? error.message : String(error),
					ambiguous: posted || !(error instanceof KakaoApiError),
				};
				result = failure.ambiguous ? "failed_ambiguous" : "failed_definitive";
			}
			for (const { deliveryId } of buffer) {
				await this.#settle(deliveryId, failure);
			}
		} catch (error) {
			result = "settlement_failed";
			throw error;
		} finally {
			this.log.info(`kakao_flush origin=${key} bubbles=${bubbles.length} path=${path} result=${result}`);
		}
	}
}

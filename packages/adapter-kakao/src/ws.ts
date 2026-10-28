export const KAKAO_GATEWAY_URL = "wss://bot-gateway.kakao.com/gateway";
const FATAL_CLOSE_CODES = new Set([4001, 4003, 4004]);

export interface KakaoGatewayFrame {
	readonly op: number;
	readonly s?: number | string;
	readonly t?: string;
	readonly d?: Record<string, unknown>;
}

/** Tokenize JSON strings as a whole so digits inside content are never rewritten. */
export function parseKakaoFrame(raw: string): KakaoGatewayFrame {
	const preserved = raw.replace(/"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (token) => {
		if (/^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token))) return JSON.stringify(token);
		return token;
	});
	const frame: unknown = JSON.parse(preserved);
	if (typeof frame !== "object" || frame === null || typeof (frame as KakaoGatewayFrame).op !== "number")
		throw new Error("Invalid Kakao gateway frame");
	return frame as KakaoGatewayFrame;
}

export interface WebSocketClock {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(timer: unknown): void;
	setInterval(callback: () => void, delayMs: number): unknown;
	clearInterval(timer: unknown): void;
}

const realClock: WebSocketClock = {
	now: () => Date.now(),
	setTimeout: (callback, delay) => setTimeout(callback, delay),
	clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
	setInterval: (callback, delay) => setInterval(callback, delay),
	clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
};

export interface KakaoGatewayOptions {
	readonly token: string;
	readonly onDispatch: (type: string, data: Record<string, unknown>, receivedAt: number) => void | Promise<void>;
	readonly createWebSocket?: (url: string) => WebSocket;
	readonly clock?: WebSocketClock;
	readonly log?: Pick<Console, "info" | "error">;
}

export class KakaoGateway {
	readonly fatal: Promise<never>;
	readonly #clock: WebSocketClock;
	readonly #log: Pick<Console, "info" | "error">;
	#rejectFatal!: (error: Error) => void;
	#socket: WebSocket | undefined;
	readonly #closing = new WeakSet<WebSocket>();
	#closeTimeout: unknown;
	#sessionId: string | undefined;
	#seq: number | string = 0;
	#heartbeat: unknown;
	#handshake: unknown;
	#retry: unknown;
	#awaitingAck = false;
	#attempt = 0;
	#openedAt: number | undefined;
	#stopped = false;
	#dispatchChain: Promise<void> = Promise.resolve();

	constructor(private readonly options: KakaoGatewayOptions) {
		this.#clock = options.clock ?? realClock;
		this.#log = options.log ?? console;
		this.fatal = new Promise<never>((_resolve, reject) => {
			this.#rejectFatal = reject;
		});
	}

	start(): void {
		if (this.#socket || this.#retry !== undefined || this.#stopped) return;
		this.#connect();
	}

	stop(): void {
		this.#stopped = true;
		this.#clearConnectionTimers();
		this.#clock.clearTimeout(this.#closeTimeout);
		this.#clock.clearTimeout(this.#retry);
		this.#retry = undefined;
		const socket = this.#socket;
		this.#socket = undefined;
		socket?.close();
	}

	#connect(): void {
		if (this.#stopped) return;
		this.#openedAt = undefined;
		let socket: WebSocket;
		try {
			socket = (this.options.createWebSocket ?? ((url) => new WebSocket(url)))(KAKAO_GATEWAY_URL);
		} catch {
			this.#scheduleReconnect();
			return;
		}
		this.#socket = socket;
		this.#handshake = this.#clock.setTimeout(() => this.#disconnect(socket), 15_000);
		socket.onopen = () => {
			if (this.#socket === socket) this.#openedAt = this.#clock.now();
		};
		socket.onmessage = (event) => {
			if (this.#socket !== socket || this.#closing.has(socket)) return;
			const receivedAt = this.#clock.now();
			try {
				if (typeof event.data !== "string") throw new Error("Non-text Kakao gateway frame");
				this.#frame(socket, parseKakaoFrame(event.data), receivedAt);
			} catch {
				this.#log.error("kakao_gateway result=invalid_frame");
				this.#disconnect(socket);
			}
		};
		// WebSocket emits close after error. Preserve its authoritative close code.
		socket.onerror = () => this.#log.error("kakao_gateway result=socket_error");
		socket.onclose = (event) => {
			const current = this.#socket === socket;
			if (!current && !this.#closing.has(socket)) return;
			this.#closing.delete(socket);
			if (current) {
				this.#socket = undefined;
				this.#clearConnectionTimers();
				this.#clock.clearTimeout(this.#closeTimeout);
			}
			if (FATAL_CLOSE_CODES.has(event.code)) {
				this.stop();
				this.#rejectFatal(new Error(`Kakao gateway closed with fatal code ${event.code}`));
				return;
			}
			if (event.code === 4009) {
				this.#sessionId = undefined;
				this.#seq = 0;
				if (!current && this.#socket) this.#disconnect(this.#socket);
			}
			if (current) this.#scheduleReconnect();
		};
	}

	#frame(socket: WebSocket, frame: KakaoGatewayFrame, receivedAt: number): void {
		switch (frame.op) {
			case 10: {
				const interval = frame.d?.heartbeat_interval;
				if (typeof interval !== "number" || !Number.isFinite(interval) || interval <= 0)
					throw new Error("Invalid Kakao heartbeat interval");
				this.#clock.clearInterval(this.#heartbeat);
				this.#awaitingAck = false;
				this.#heartbeat = this.#clock.setInterval(
					() => {
						if (this.#socket !== socket) return;
						if (this.#awaitingAck) {
							this.#disconnect(socket);
							return;
						}
						this.#awaitingAck = true;
						try {
							socket.send(JSON.stringify({ op: 1 }));
						} catch {
							this.#disconnect(socket);
						}
					},
					Math.max(1, interval * 0.9),
				);
				socket.send(
					JSON.stringify(
						this.#sessionId
							? { op: 6, d: { token: this.options.token, session_id: this.#sessionId, seq: this.#seq } }
							: { op: 2, d: { token: this.options.token } },
					),
				);
				// RESUME replays DISPATCH directly and need not send another READY.
				if (this.#sessionId) {
					this.#clock.clearTimeout(this.#handshake);
					this.#handshake = undefined;
				}
				break;
			}
			case 3:
				if (typeof frame.d?.session_id !== "string") throw new Error("Invalid Kakao READY");
				this.#sessionId = frame.d.session_id;
				this.#clock.clearTimeout(this.#handshake);
				this.#handshake = undefined;
				this.#log.info("kakao_gateway result=ready");
				break;
			case 11:
				this.#awaitingAck = false;
				break;
			case 0:
				if (frame.s !== undefined) this.#seq = frame.s;
				if (typeof frame.t === "string" && frame.d && typeof frame.d === "object") {
					const type = frame.t;
					const data = frame.d;
					this.#dispatchChain = this.#dispatchChain
						.then(() => this.options.onDispatch(type, data, receivedAt))
						.catch(() => {
							this.#log.error(`kakao_dispatch type=${type} result=failed`);
						});
				}
				break;
		}
	}

	#disconnect(socket: WebSocket): void {
		if (this.#socket !== socket || this.#closing.has(socket)) return;
		this.#closing.add(socket);
		this.#clearConnectionTimers();
		this.#closeTimeout = this.#clock.setTimeout(() => {
			if (this.#socket !== socket) return;
			this.#socket = undefined;
			(socket as WebSocket & { terminate?: () => void }).terminate?.();
			this.#log.info("kakao_gateway result=close_timeout");
			this.#scheduleReconnect();
		}, 5_000);
		socket.close();
	}

	#clearConnectionTimers(): void {
		this.#clock.clearInterval(this.#heartbeat);
		this.#clock.clearTimeout(this.#handshake);
		this.#heartbeat = undefined;
		this.#handshake = undefined;
	}

	#scheduleReconnect(): void {
		if (this.#stopped || this.#retry !== undefined) return;
		if (this.#openedAt !== undefined && this.#clock.now() - this.#openedAt >= 60_000) this.#attempt = 0;
		const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.#attempt++, 5));
		this.#retry = this.#clock.setTimeout(() => {
			this.#retry = undefined;
			this.#connect();
		}, delay);
	}
}

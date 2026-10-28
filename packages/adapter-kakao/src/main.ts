import { acquireLease, exitOnLeaseHeld, type Lease, LeaseHeldError } from "@gajae-gateway/home";
import type { OriginRef } from "@gajae-gateway/protocol";
import { GajaewayClient } from "@gajae-gateway/sdk";
import { KakaoBotApi } from "./api";
import { adapterHome, type LoadedKakaoAdapterConfig, loadKakaoAdapterConfig } from "./config";
import { type GatewayRequester, KakaoDelivery } from "./delivery";
import { KakaoInbound } from "./inbound";
import { KakaoAdapterState } from "./state";
import { KakaoGateway } from "./ws";

/** Shared delivery state survives gateway socket reconnects and replay. */
export class ReconnectingGateway implements GatewayRequester {
	#client: GajaewayClient | undefined;
	#reconnecting = false;
	#attempt = 0;
	#stopped = false;
	#retry: ReturnType<typeof setTimeout> | undefined;
	#monitor: ReturnType<typeof setTimeout> | undefined;
	#subscriptions: (() => void)[] = [];
	readonly #delivery: KakaoDelivery;

	constructor(
		readonly socketPath: string,
		bot: KakaoBotApi,
		state: KakaoAdapterState,
	) {
		this.#delivery = new KakaoDelivery(this, bot, state);
	}

	async connectInitial(): Promise<void> {
		await this.#connect(true);
	}

	async #connect(initial = false): Promise<void> {
		try {
			const options = {
				clientName: "adapter-kakao",
				onRetry: (attempt: number, delayMs: number) =>
					console.warn(
						`gateway_socket_waiting client=adapter-kakao path=${this.socketPath} attempt=${attempt} retry_in_ms=${delayMs}`,
					),
			};
			const client = initial
				? await GajaewayClient.connectSocketWithBackoff(this.socketPath, options)
				: await GajaewayClient.connectSocket(this.socketPath, options);
			if (this.#stopped) {
				await client.close();
				return;
			}
			this.#client = client;
			this.#attempt = 0;
			this.#unsubscribe();
			this.#subscriptions = [
				client.onChatMessage((message) => {
					void this.#delivery
						.onChatMessage(message)
						.catch(() => console.error("kakao_delivery result=settlement_failed"));
				}),
				client.onChatProgress((progress) => {
					void this.#delivery
						.onChatProgress(progress)
						.catch(() => console.error("kakao_delivery result=settlement_failed"));
				}),
			];
			this.#subscriptions.push(
				client.onDisconnect(() => {
					if (this.#client === client) this.#scheduleReconnect();
				}),
			);
			this.#monitorClient(client);
		} catch {
			this.#scheduleReconnect();
		}
	}

	async request<T = unknown>(verb: string, params?: unknown): Promise<T> {
		if (!this.#client) throw new Error("gateway is not connected");
		try {
			const result = await this.#client.request<T>(verb, params);
			if (verb === "chat.send" && typeof (result as { turnId?: unknown } | null)?.turnId === "string")
				this.#delivery.onTurnStarted((params as { origin: OriginRef }).origin, (result as { turnId: string }).turnId);
			return result;
		} catch (error) {
			this.#scheduleReconnect();
			throw error;
		}
	}

	async close(): Promise<void> {
		this.#stopped = true;
		clearTimeout(this.#retry);
		clearTimeout(this.#monitor);
		this.#unsubscribe();
		this.#delivery.stop();
		const client = this.#client;
		this.#client = undefined;
		await client?.close();
	}

	#unsubscribe(): void {
		for (const off of this.#subscriptions) off();
		this.#subscriptions = [];
	}

	#monitorClient(client: GajaewayClient): void {
		this.#monitor = setTimeout(() => {
			if (this.#client !== client) return;
			void client.request("gateway.status").then(
				() => this.#monitorClient(client),
				() => this.#scheduleReconnect(),
			);
		}, 30_000);
	}

	#scheduleReconnect(): void {
		if (this.#stopped || this.#reconnecting) return;
		this.#reconnecting = true;
		const old = this.#client;
		this.#client = undefined;
		this.#unsubscribe();
		clearTimeout(this.#monitor);
		void old?.close().catch(() => {});
		const delay = Math.min(30_000, 500 * 2 ** Math.min(this.#attempt++, 6));
		const jitter = Math.floor(Math.random() * Math.max(1, delay / 4));
		this.#retry = setTimeout(() => {
			this.#reconnecting = false;
			void this.#connect();
		}, delay + jitter);
	}
}

export async function startKakaoAdapter(config: LoadedKakaoAdapterConfig): Promise<void> {
	const state = await KakaoAdapterState.load(adapterHome());
	const bot = new KakaoBotApi(config.token);
	const gateway = new ReconnectingGateway(config.gatewaySocket ?? `${adapterHome()}/gateway.sock`, bot, state);
	await gateway.connectInitial();
	const inbound = new KakaoInbound(gateway, state);
	const ws = new KakaoGateway({
		token: config.token,
		onDispatch: (type, data, receivedAt) => inbound.handleDispatch(type, data, receivedAt),
	});
	try {
		ws.start();
		await ws.fatal;
	} finally {
		ws.stop();
		inbound.stop();
		await gateway.close();
	}
}

export async function runKakaoAdapterWithLease<T>(home: string, start: (lease: Lease) => Promise<T>): Promise<T> {
	let lease: Lease;
	try {
		lease = await acquireLease(home, "adapter-kakao");
		console.info(`lease_acquired name=adapter-kakao pid=${process.pid}`);
	} catch (error) {
		if (!(error instanceof LeaseHeldError))
			console.error(`lease_failed name=adapter-kakao detail=${error instanceof Error ? error.message : String(error)}`);
		throw error;
	}
	try {
		return await start(lease);
	} finally {
		await lease.release();
	}
}

if (import.meta.main) {
	void runKakaoAdapterWithLease(adapterHome(), async (lease) => {
		const shutdown = (): void => {
			void lease.release().then(
				() => process.exit(0),
				() => {
					console.error("Kakao adapter lease release failed");
					process.exit(1);
				},
			);
		};
		process.once("SIGINT", shutdown);
		process.once("SIGTERM", shutdown);
		await startKakaoAdapter(await loadKakaoAdapterConfig());
	}).catch((error) => {
		if (error instanceof LeaseHeldError) exitOnLeaseHeld(error);
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}

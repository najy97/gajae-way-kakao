import { expect, test } from "bun:test";
import { KakaoGateway, parseKakaoFrame } from "../src/ws";
import { FakeClock, quietLog } from "./helpers";

class FakeSocket {
	constructor(private readonly clock: FakeClock) {}
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: ((event: { code: number; reason?: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	readonly sent: unknown[] = [];
	closed = false;
	ended = false;
	closeDelay = 0;
	send(raw: string) {
		this.sent.push(JSON.parse(raw));
	}
	close() {
		this.closed = true;
		this.clock.setTimeout(() => this.end(1000), this.closeDelay);
	}
	terminate() {
		this.ended = true;
	}
	open() {
		this.onopen?.();
	}
	receive(frame: unknown) {
		this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
	}
	end(code: number) {
		this.ended = true;
		this.onclose?.({ code, reason: "never log secret close reasons" });
	}
}

function fixture() {
	const sockets: FakeSocket[] = [];
	const clock = new FakeClock();
	const dispatches: unknown[] = [];
	const ws = new KakaoGateway({
		token: "bot-secret",
		clock,
		log: quietLog,
		onDispatch: (type, data, receivedAt) => {
			dispatches.push({ type, data, receivedAt });
		},
		createWebSocket: () => {
			const socket = new FakeSocket(clock);
			sockets.push(socket);
			return socket as unknown as WebSocket;
		},
	});
	ws.start();
	const socket = sockets[0] as FakeSocket;
	socket.open();
	return { ws, clock, sockets, socket, dispatches };
}
function ready(socket: FakeSocket, interval = 1_000) {
	socket.receive({ op: 10, d: { heartbeat_interval: interval } });
	socket.receive({ op: 3, d: { session_id: "session", bot: { id: "bot" } } });
}

test("frame parsing preserves a 19-digit id exactly without changing numbers in string content", () => {
	const frame = parseKakaoFrame(
		String.raw`{"op":0,"s":12,"t":"MESSAGE_CREATE","d":{"id":1234567890123456789,"content":"digits 1234567890123456789 and \"id\":1234567890123456789"}}`,
	);
	expect(frame.d?.id).toBe("1234567890123456789");
	expect(frame.s).toBe(12);
	expect(frame.d?.content).toBe('digits 1234567890123456789 and "id":1234567890123456789');
	expect(() => parseKakaoFrame("invalid")).toThrow();
});

test("HELLO identifies, READY starts dispatch and heartbeat ACK keeps the connection alive", async () => {
	const f = fixture();
	ready(f.socket);
	expect(f.socket.sent).toEqual([{ op: 2, d: { token: "bot-secret" } }]);
	f.clock.advance(899);
	expect(f.socket.sent).toHaveLength(1);
	f.clock.advance(1);
	expect(f.socket.sent.at(-1)).toEqual({ op: 1 });
	f.socket.receive({ op: 11 });
	f.clock.advance(900);
	expect(f.socket.closed).toBe(false);
	f.socket.receive('{"op":0,"s":1,"t":"MESSAGE_CREATE","d":{"id":1234567890123456789}}');
	await Promise.resolve();
	expect(f.dispatches).toEqual([{ type: "MESSAGE_CREATE", data: { id: "1234567890123456789" }, receivedAt: 1800 }]);
	f.ws.stop();
});

test("local disconnect waits for asynchronous closure before opening a replacement", () => {
	const f = fixture();
	f.socket.closeDelay = 3_000;
	ready(f.socket);
	f.clock.advance(1_800);
	expect(f.socket.ended).toBe(false);
	f.clock.advance(2_999);
	expect(f.sockets).toHaveLength(1);
	f.clock.advance(1_001);
	expect(f.sockets).toHaveLength(2);
	expect(f.sockets.filter((socket) => !socket.ended)).toHaveLength(1);
	f.ws.stop();
});

test("late fatal close after forced closure timeout still stops the replacement", async () => {
	const f = fixture();
	f.socket.closeDelay = 20_000;
	ready(f.socket);
	f.clock.advance(7_800);
	expect(f.sockets).toHaveLength(2);
	expect(f.sockets.filter((socket) => !socket.ended)).toHaveLength(1);
	f.socket.end(4004);
	await expect(f.ws.fatal).rejects.toThrow("fatal code 4004");
	f.clock.advance(120_000);
	expect(f.sockets).toHaveLength(2);
	expect(f.sockets.every((socket) => socket.ended)).toBe(true);
});

test("late 4009 after forced timeout resets the session and replaces an already resumed socket", () => {
	const f = fixture();
	f.socket.closeDelay = 20_000;
	ready(f.socket);
	f.clock.advance(7_800);
	const resumed = f.sockets[1]!;
	resumed.open();
	resumed.receive({ op: 10, d: { heartbeat_interval: 100_000 } });
	expect(resumed.sent[0]).toMatchObject({ op: 6 });
	f.socket.end(4009);
	f.clock.advance(2_000);
	const fresh = f.sockets[2]!;
	fresh.open();
	fresh.receive({ op: 10, d: { heartbeat_interval: 100_000 } });
	expect(fresh.sent[0]).toEqual({ op: 2, d: { token: "bot-secret" } });
	f.ws.stop();
});

test("queued dispatch retains frame receipt time rather than handler execution time", async () => {
	const clock = new FakeClock();
	const socket = new FakeSocket(clock);
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const receipts: number[] = [];
	const ws = new KakaoGateway({
		token: "secret",
		clock,
		log: quietLog,
		createWebSocket: () => socket as unknown as WebSocket,
		onDispatch: async (_type, _data, receivedAt) => {
			receipts.push(receivedAt);
			if (receipts.length === 1) await held;
		},
	});
	ws.start();
	ready(socket, 1_000_000);
	socket.receive({ op: 0, t: "MESSAGE_CREATE", d: {} });
	await Promise.resolve();
	clock.advance(100);
	socket.receive({ op: 0, t: "MESSAGE_CREATE", d: {} });
	clock.advance(200_000);
	release();
	for (let i = 0; i < 10; i++) await Promise.resolve();
	expect(receipts).toEqual([0, 100]);
	ws.stop();
});

test("a missing heartbeat ACK closes and reconnects, resuming the last sequence", () => {
	const f = fixture();
	ready(f.socket);
	f.socket.receive({ op: 0, s: 42, t: "LEAVE", d: {} });
	f.clock.advance(1_800);
	expect(f.socket.closed).toBe(true);
	f.clock.advance(999);
	expect(f.sockets).toHaveLength(1);
	f.clock.advance(1);
	const next = f.sockets[1] as FakeSocket;
	next.open();
	next.receive({ op: 10, d: { heartbeat_interval: 1_000 } });
	expect(next.sent).toEqual([{ op: 6, d: { token: "bot-secret", session_id: "session", seq: 42 } }]);
	f.ws.stop();
});

test("server restart resumes but 4009 discards the expired session", () => {
	for (const code of [1001, 4009]) {
		const f = fixture();
		ready(f.socket);
		f.socket.end(code);
		f.clock.advance(1_000);
		const next = f.sockets[1] as FakeSocket;
		next.open();
		next.receive({ op: 10, d: { heartbeat_interval: 1_000 } });
		expect(next.sent).toEqual([
			code === 1001
				? { op: 6, d: { token: "bot-secret", session_id: "session", seq: 0 } }
				: { op: 2, d: { token: "bot-secret" } },
		]);
		f.ws.stop();
	}
});

test("auth failure, invalid payload and replaced connection reject fatal without reconnect", async () => {
	for (const code of [4001, 4003, 4004]) {
		const f = fixture();
		if (code === 4004) f.socket.onerror?.();
		f.socket.end(code);
		await expect(f.ws.fatal).rejects.toThrow(`fatal code ${code}`);
		f.clock.advance(120_000);
		expect(f.sockets).toHaveLength(1);
		f.ws.stop();
	}
});

test("RESUME needs no READY, retains heartbeat ACK checks and resets on subsequent 4009", () => {
	const f = fixture();
	ready(f.socket);
	f.socket.end(1001);
	f.clock.advance(1_000);
	const resumed = f.sockets[1] as FakeSocket;
	resumed.open();
	resumed.receive({ op: 10, d: { heartbeat_interval: 20_000 } });
	f.clock.advance(15_000);
	expect(resumed.closed).toBe(false);
	f.clock.advance(3_000);
	expect(resumed.sent.at(-1)).toEqual({ op: 1 });
	f.clock.advance(18_000);
	expect(resumed.closed).toBe(true);
	f.clock.advance(2_000);
	const expired = f.sockets[2] as FakeSocket;
	expired.open();
	expired.receive({ op: 10, d: { heartbeat_interval: 20_000 } });
	expect(expired.sent[0]).toEqual({ op: 6, d: { token: "bot-secret", session_id: "session", seq: 0 } });
	expired.end(4009);
	f.clock.advance(4_000);
	const fresh = f.sockets[3] as FakeSocket;
	fresh.open();
	fresh.receive({ op: 10, d: { heartbeat_interval: 20_000 } });
	expect(fresh.sent[0]).toEqual({ op: 2, d: { token: "bot-secret" } });
	f.ws.stop();
});

test("retry backoff doubles from one second to a 30-second ceiling", () => {
	const f = fixture();
	for (const [index, delay] of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000].entries()) {
		const socket = f.sockets[index] as FakeSocket;
		socket.open();
		socket.end(1001);
		f.clock.advance(delay - 1);
		expect(f.sockets).toHaveLength(index + 1);
		f.clock.advance(1);
		expect(f.sockets).toHaveLength(index + 2);
	}
	f.ws.stop();
});

test("60 seconds of uptime resets backoff and stop cancels future reconnects", () => {
	const f = fixture();
	f.socket.end(1001);
	f.clock.advance(1_000);
	const next = f.sockets[1] as FakeSocket;
	next.open();
	ready(next, 100_000);
	f.clock.advance(60_000);
	next.end(1001);
	f.clock.advance(1_000);
	expect(f.sockets).toHaveLength(3);
	f.ws.stop();
	f.clock.advance(120_000);
	expect(f.sockets).toHaveLength(3);
});

test("missing HELLO or malformed payload cannot leave a wedged socket forever", () => {
	const f = fixture();
	f.clock.advance(15_000);
	expect(f.socket.closed).toBe(true);
	f.clock.advance(1_000);
	const next = f.sockets[1] as FakeSocket;
	next.receive({ op: 10, d: { heartbeat_interval: 0 } });
	expect(next.closed).toBe(true);
	f.ws.stop();
});

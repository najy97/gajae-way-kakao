import type { WebSocketClock } from "../src/ws";

export class FakeClock implements WebSocketClock {
	time = 0;
	#next = 1;
	readonly #timers = new Map<number, { at: number; callback: () => void; interval?: number }>();
	now = (): number => this.time;
	setTimeout = (callback: () => void, delay: number): number => {
		const id = this.#next++;
		this.#timers.set(id, { at: this.time + delay, callback });
		return id;
	};
	clearTimeout = (timer: unknown): void => {
		this.#timers.delete(timer as number);
	};
	setInterval = (callback: () => void, delay: number): number => {
		const id = this.setTimeout(callback, delay);
		const timer = this.#timers.get(id);
		if (timer) timer.interval = delay;
		return id;
	};
	clearInterval = this.clearTimeout;
	advance(ms: number): void {
		const target = this.time + ms;
		for (;;) {
			const next = [...this.#timers.entries()]
				.filter(([, timer]) => timer.at <= target)
				.sort((a, b) => a[1].at - b[1].at)[0];
			if (!next) break;
			const [id, timer] = next;
			this.time = timer.at;
			if (timer.interval) timer.at += timer.interval;
			else this.#timers.delete(id);
			timer.callback();
		}
		this.time = target;
	}
}

export const quietLog = { info: (_message: string) => {}, error: (_message: string) => {} };

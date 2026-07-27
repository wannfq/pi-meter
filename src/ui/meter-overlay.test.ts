import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import type {
	AwaitingProviderSnapshot,
	LiveProviderSnapshot,
	Meter,
	ProviderSnapshot,
} from "../meter.js";
import { MeterOverlay } from "./meter-overlay.js";

const T0 = new Date("2026-07-26T12:00:00.000Z");

class FakeMeter implements Meter {
	snapshots: readonly ProviderSnapshot[];
	readonly refreshCalls: Array<
		{ readonly force?: boolean; readonly signal?: AbortSignal } | undefined
	> = [];
	readonly unsubscribe = vi.fn();
	private readonly listeners = new Set<() => void>();

	constructor(snapshots: readonly ProviderSnapshot[]) {
		this.snapshots = snapshots;
	}

	snapshot(): readonly ProviderSnapshot[] {
		return this.snapshots;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
			this.unsubscribe();
		};
	}

	async refresh(options?: {
		readonly force?: boolean;
		readonly signal?: AbortSignal;
	}): Promise<readonly ProviderSnapshot[]> {
		this.refreshCalls.push(options);
		return this.snapshots;
	}

	publish(snapshots: readonly ProviderSnapshot[]): void {
		this.snapshots = snapshots;
		for (const listener of this.listeners) listener();
	}
}

function live(
	overrides: Partial<LiveProviderSnapshot> = {},
): LiveProviderSnapshot {
	return {
		support: "live",
		id: "openai-codex",
		displayName: "OpenAI Codex",
		evidence: "first-party-source",
		freshness: "absent",
		refreshing: false,
		...overrides,
	};
}

function ready(
	overrides: Partial<LiveProviderSnapshot> = {},
): LiveProviderSnapshot {
	return live({
		freshness: "current",
		visibleReading: {
			provider: "openai-codex",
			plan: "Plus",
			fetchedAt: T0,
			observedAt: new Date(T0.getTime() - 30_000),
			windows: [
				{
					id: "primary",
					label: "5 hour",
					usedPercent: 38,
					windowMinutes: 300,
					resetsAt: new Date(T0.getTime() + 3_600_000),
				},
				{
					id: "secondary",
					label: "Weekly",
					usedPercent: 18,
					windowMinutes: 10_080,
				},
			],
		},
		lastSuccessAt: T0,
		...overrides,
	});
}

function awaiting(
	overrides: Partial<AwaitingProviderSnapshot> = {},
): AwaitingProviderSnapshot {
	return {
		support: "awaiting-interface",
		id: "opencode-go",
		displayName: "OpenCode Go",
		explanation: "Waiting for a public OpenCode Go quota API",
		...overrides,
	};
}

function theme(ansi = false): Theme {
	const style = (color: string, text: string): string => {
		if (!ansi) return text;
		const code =
			color === "success"
				? 92
				: color === "accent"
					? 96
					: color === "muted"
						? 90
						: 36;
		return `\u001b[${code}m${text}\u001b[0m`;
	};
	return {
		fg: style,
		bg: style,
		bold: (text: string) => text,
		italic: (text: string) => text,
		strikethrough: (text: string) => text,
	} as unknown as Theme;
}

function createOverlay(
	meter: FakeMeter,
	options: { readonly now?: () => Date; readonly forceRefresh?: boolean } = {},
) {
	const requestRender = vi.fn();
	const done = vi.fn();
	const overlay = new MeterOverlay(
		{ requestRender },
		theme(),
		meter,
		done,
		options,
	);
	return { done, overlay, requestRender };
}

function plain(lines: readonly string[]): string {
	return lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
}

describe("MeterOverlay", () => {
	it("renders loading and awaiting-interface rows immediately", () => {
		const meter = new FakeMeter([live({ refreshing: true }), awaiting()]);
		const { overlay } = createOverlay(meter, { now: () => T0 });

		const output = plain(overlay.render(48));
		expect(output).toContain("Meter");
		expect(output).toContain("OpenAI Codex  Loading…");
		expect(output).toContain("OpenCode Go · awaiting interface");
		expect(output).toContain("Waiting for a public OpenCode Go quota API");
		expect(output).toContain("r refresh · Esc/q close");
		overlay.dispose();
	});

	it("progressively renders ready, stale-warning, and expired states", () => {
		const meter = new FakeMeter([live({ refreshing: true }), awaiting()]);
		const { overlay, requestRender } = createOverlay(meter, { now: () => T0 });
		requestRender.mockClear();

		meter.publish([ready(), awaiting()]);
		let output = plain(overlay.render(48));
		expect(requestRender).toHaveBeenCalledTimes(1);
		expect(output).toContain("OpenAI Codex · Plus");
		expect(output).toContain(`5 hour  ${"─".repeat(20)}  62% left`);
		expect(output).toContain("Next reset: in 1 hour ·");
		expect(output).toContain(`Weekly  ${"─".repeat(20)}  82% left`);
		expect(output).toContain("Next reset: unavailable");
		expect(output).toContain("fetched just now");
		expect(output).not.toContain("first-party-source");
		expect(output).toContain("provider observed just now");

		meter.publish([
			ready({
				freshness: "stale",
				latestFailure: {
					reason: "network",
					failedAt: new Date(T0.getTime() + 70_000),
				},
			}),
			awaiting(),
		]);
		output = plain(overlay.render(48));
		expect(output).toContain("Network unavailable");

		meter.publish([
			live({
				freshness: "expired",
				lastSuccessAt: new Date(T0.getTime() - 301_000),
				latestFailure: { reason: "invalid-response", failedAt: T0 },
			}),
			awaiting(),
		]);
		output = plain(overlay.render(48));
		expect(output).toContain("usage unavailable");
		expect(output).toContain("Provider response changed");
		expect(output).toContain("last successful fetch 5m ago");
		expect(output).not.toContain("62% left");
		overlay.dispose();
	});

	it("styles remaining bar cells as success and used cells as muted", () => {
		const meter = new FakeMeter([ready()]);
		const overlay = new MeterOverlay(
			{ requestRender: vi.fn() },
			theme(true),
			meter,
			vi.fn(),
			{ now: () => T0 },
		);

		const output = overlay.render(60).join("\n");
		expect(output).toContain(
			`\u001b[92m${"─".repeat(12)}\u001b[0m\u001b[90m${"─".repeat(8)}\u001b[0m`,
		);
		overlay.dispose();
	});

	it("aligns gauges after differently sized quota labels", () => {
		const baseReading = ready().visibleReading;
		if (!baseReading) throw new Error("Expected a visible reading");
		const meter = new FakeMeter([
			ready({
				visibleReading: {
					...baseReading,
					windows: [
						{ id: "primary", label: "1 day", usedPercent: 38 },
						{ id: "secondary", label: "Monthly", usedPercent: 18 },
					],
				},
			}),
		]);
		const { overlay } = createOverlay(meter, { now: () => T0 });

		const quotaLines = plain(overlay.render(60))
			.split("\n")
			.filter((line) => line.includes("% left"));
		expect(quotaLines).toHaveLength(2);
		expect(quotaLines[0]?.indexOf("─")).toBe(quotaLines[1]?.indexOf("─"));
		expect(quotaLines[0]).toContain("1 day    ─");
		expect(quotaLines[1]).toContain("Monthly  ─");
		overlay.dispose();
	});

	it("does not display a failure older than the visible successful reading", () => {
		const meter = new FakeMeter([
			ready({
				latestFailure: {
					reason: "unauthorized",
					failedAt: new Date(T0.getTime() - 1),
				},
			}),
		]);
		const { overlay } = createOverlay(meter, { now: () => T0 });

		expect(plain(overlay.render(48))).not.toContain("authentication expired");
		overlay.dispose();
	});

	it("shows safety-floor feedback and sends force refresh on r", async () => {
		const meter = new FakeMeter([
			ready({ nextRefreshAt: new Date(T0.getTime() + 5_000) }),
		]);
		const { overlay, requestRender } = createOverlay(meter, { now: () => T0 });
		await Promise.resolve();
		meter.refreshCalls.length = 0;
		requestRender.mockClear();

		overlay.handleInput("r");
		expect(meter.refreshCalls).toHaveLength(1);
		expect(meter.refreshCalls[0]).toMatchObject({ force: true });
		expect(plain(overlay.render(48))).toContain("Refresh available in 5s");
		expect(requestRender).toHaveBeenCalled();
		overlay.dispose();
	});

	it.each([
		"\u001b",
		"q",
	])("closes with %s, aborts, and unsubscribes exactly once", async (key) => {
		const meter = new FakeMeter([live({ refreshing: true })]);
		const { done, overlay, requestRender } = createOverlay(meter, {
			now: () => T0,
		});
		const signal = meter.refreshCalls[0]?.signal;
		requestRender.mockClear();

		overlay.handleInput(key);
		overlay.dispose();
		overlay.dispose();
		meter.publish([ready()]);
		await Promise.resolve();

		expect(done).toHaveBeenCalledTimes(1);
		expect(meter.unsubscribe).toHaveBeenCalledTimes(1);
		expect(signal?.aborted).toBe(true);
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("redraws at a freshness boundary and clears its one-shot timer", () => {
		vi.useFakeTimers({ now: T0 });
		try {
			const meter = new FakeMeter([ready()]);
			const { overlay, requestRender } = createOverlay(meter, {
				now: () => new Date(Date.now()),
			});
			requestRender.mockClear();
			expect(vi.getTimerCount()).toBe(1);

			vi.advanceTimersByTime(60_001);
			expect(requestRender).toHaveBeenCalledTimes(1);

			overlay.dispose();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps every ANSI and Unicode line within narrow render widths", () => {
		const meter = new FakeMeter([
			ready({
				displayName:
					"OpenAI Codex with an exceptionally long provider label 中文",
			}),
			awaiting({
				displayName: "OpenCode Go 中文日本語",
				explanation:
					"Waiting for a public OpenCode Go quota API with a deliberately long explanation 中文日本語",
			}),
		]);
		const overlay = new MeterOverlay(
			{ requestRender: vi.fn() },
			theme(true),
			meter,
			vi.fn(),
			{ now: () => T0 },
		);

		for (const width of [1, 2, 3, 10, 24, 48]) {
			expect(
				overlay.render(width).every((line) => visibleWidth(line) <= width),
			).toBe(true);
		}
		overlay.dispose();
	});
});

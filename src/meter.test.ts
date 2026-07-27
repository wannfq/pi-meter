import { describe, expect, it, vi } from "vitest";

import {
	createMeter,
	type AllowanceSource,
	type ProviderDefinition,
	type SourceObservation,
	type SourceResult,
} from "./meter.js";

const T0 = new Date("2026-07-26T12:00:00.000Z");

function observation(
	usedPercent: number,
	overrides: Partial<SourceObservation> = {},
): SourceObservation {
	return {
		windows: [{ id: "primary", label: "5 hour", usedPercent }],
		...overrides,
	};
}

function success(usedPercent: number): SourceResult {
	return { kind: "success", observation: observation(usedPercent) };
}

function live(
	id: string,
	source: AllowanceSource,
	displayName = id,
): ProviderDefinition {
	return {
		support: "live",
		id,
		displayName,
		evidence: "first-party-source",
		source,
	};
}

function awaiting(id: string, displayName = id): ProviderDefinition {
	return {
		support: "awaiting-interface",
		id,
		displayName,
		explanation: "Waiting for a public interface",
	};
}

function deferred<T>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
	readonly reject: (reason?: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function liveSnapshot(meter: ReturnType<typeof createMeter>, index = 0) {
	const snapshot = meter.snapshot()[index];
	expect(snapshot?.support).toBe("live");
	if (!snapshot || snapshot.support !== "live") {
		throw new Error("Expected a live provider snapshot");
	}
	return snapshot;
}

describe("createMeter", () => {
	it("validates IDs, preserves order, and skips awaiting providers", async () => {
		const source = { read: vi.fn(async () => success(10)) };
		const meter = createMeter([
			awaiting("opencode-go", "OpenCode Go"),
			live("openai-codex", source, "OpenAI Codex"),
		]);

		expect(meter.snapshot().map(({ id }) => id)).toEqual([
			"opencode-go",
			"openai-codex",
		]);
		expect(meter.snapshot().map(({ displayName }) => displayName)).toEqual([
			"OpenCode Go",
			"OpenAI Codex",
		]);
		expect(source.read).not.toHaveBeenCalled();

		await meter.refresh();
		expect(source.read).toHaveBeenCalledTimes(1);
		expect(meter.snapshot()[0]).toEqual({
			support: "awaiting-interface",
			id: "opencode-go",
			displayName: "OpenCode Go",
			explanation: "Waiting for a public interface",
		});
		expect(() =>
			createMeter([awaiting("duplicate"), awaiting("duplicate")]),
		).toThrow("Duplicate provider ID");
		expect(() => createMeter([awaiting("Not A Slug")])).toThrow(
			"Invalid provider ID",
		);
	});

	it("refreshes live providers concurrently and commits partial results progressively", async () => {
		const first = deferred<SourceResult>();
		const second = deferred<SourceResult>();
		const firstSource = { read: vi.fn(() => first.promise) };
		const secondSource = { read: vi.fn(() => second.promise) };
		const meter = createMeter(
			[live("first", firstSource), live("second", secondSource)],
			{ now: () => T0 },
		);
		const snapshots: string[][] = [];
		const unsubscribe = meter.subscribe(() => {
			snapshots.push(
				meter
					.snapshot()
					.map((item) =>
						item.support === "live"
							? `${item.id}:${item.freshness}:${item.refreshing}`
							: item.id,
					),
			);
		});

		const refreshing = meter.refresh();
		await vi.waitFor(() => {
			expect(firstSource.read).toHaveBeenCalledTimes(1);
			expect(secondSource.read).toHaveBeenCalledTimes(1);
		});
		first.resolve(success(25));
		await vi.waitFor(() => {
			expect(liveSnapshot(meter, 0).freshness).toBe("current");
			expect(liveSnapshot(meter, 1).refreshing).toBe(true);
		});
		second.resolve({
			kind: "failure",
			failure: { reason: "unauthorized" },
		});
		await refreshing;

		expect(liveSnapshot(meter, 0).visibleReading?.windows[0]?.usedPercent).toBe(
			25,
		);
		expect(liveSnapshot(meter, 1).latestFailure?.reason).toBe("unauthorized");
		expect(
			snapshots.some(
				(items) =>
					items[0] === "first:current:false" &&
					items[1] === "second:absent:true",
			),
		).toBe(true);

		unsubscribe();
		unsubscribe();
		const notificationCount = snapshots.length;
		await meter.refresh({ force: true });
		expect(snapshots).toHaveLength(notificationCount);
	});

	it("isolates listener errors from other listeners and provider settlement", async () => {
		const source = { read: vi.fn(async () => success(40)) };
		const meter = createMeter([live("provider", source)], { now: () => T0 });
		const healthyListener = vi.fn();
		meter.subscribe(() => {
			throw new Error("listener failed");
		});
		meter.subscribe(healthyListener);

		await expect(meter.refresh()).resolves.toHaveLength(1);
		expect(healthyListener).toHaveBeenCalledTimes(2);
		expect(liveSnapshot(meter).freshness).toBe("current");
	});

	it("uses meter fetch time for freshness and hides expired readings", async () => {
		let currentTime = T0;
		const observedAt = new Date("2020-01-01T00:00:00.000Z");
		const source = {
			read: vi.fn(async () => ({
				kind: "success" as const,
				observation: observation(30, { observedAt }),
			})),
		};
		const meter = createMeter([live("provider", source)], {
			now: () => currentTime,
		});

		await meter.refresh();
		expect(liveSnapshot(meter)).toMatchObject({
			freshness: "current",
			lastSuccessAt: T0,
			visibleReading: { fetchedAt: T0, observedAt },
		});

		currentTime = new Date(T0.getTime() + 60_000);
		expect(liveSnapshot(meter).freshness).toBe("current");
		currentTime = new Date(T0.getTime() + 60_001);
		expect(liveSnapshot(meter).freshness).toBe("stale");
		currentTime = new Date(T0.getTime() + 300_000);
		expect(liveSnapshot(meter).visibleReading).toBeDefined();
		currentTime = new Date(T0.getTime() + 300_001);
		expect(liveSnapshot(meter)).toMatchObject({
			freshness: "expired",
			lastSuccessAt: T0,
		});
		expect(liveSnapshot(meter).visibleReading).toBeUndefined();
	});

	it("reuses fresh cache unless forced and preserves a reading after failure", async () => {
		let currentTime = T0;
		const source = {
			read: vi
				.fn<AllowanceSource["read"]>()
				.mockResolvedValueOnce(success(10))
				.mockResolvedValueOnce({
					kind: "failure",
					failure: { reason: "network" },
				})
				.mockResolvedValueOnce(success(80)),
		};
		const meter = createMeter([live("provider", source)], {
			now: () => currentTime,
		});

		await meter.refresh();
		currentTime = new Date(T0.getTime() + 10_000);
		await meter.refresh();
		expect(source.read).toHaveBeenCalledTimes(1);

		await meter.refresh({ force: true });
		const snapshot = liveSnapshot(meter);
		expect(source.read).toHaveBeenCalledTimes(2);
		expect(snapshot.visibleReading?.windows[0]?.usedPercent).toBe(10);
		expect(snapshot.latestFailure?.reason).toBe("network");

		currentTime = new Date(T0.getTime() + 20_000);
		await meter.refresh({ force: true });
		expect(liveSnapshot(meter).visibleReading?.windows[0]?.usedPercent).toBe(
			80,
		);
		expect(liveSnapshot(meter).latestFailure?.reason).toBe("network");
	});

	it.each([
		0, 100,
	])("accepts a used percentage at the valid boundary (%s)", async (usedPercent) => {
		const meter = createMeter([
			live("provider", { read: vi.fn(async () => success(usedPercent)) }),
		]);

		await meter.refresh();
		expect(liveSnapshot(meter).visibleReading?.windows[0]?.usedPercent).toBe(
			usedPercent,
		);
	});

	it.each([
		Number.NaN,
		Number.POSITIVE_INFINITY,
		-1,
		101,
	])("maps an invalid used percentage (%s) to invalid-response", async (usedPercent) => {
		const meter = createMeter([
			live("provider", { read: vi.fn(async () => success(usedPercent)) }),
		]);

		await meter.refresh();
		expect(liveSnapshot(meter)).toMatchObject({
			freshness: "absent",
			latestFailure: { reason: "invalid-response" },
		});
	});

	it("coalesces an in-flight provider without making the blocked refresh wait", async () => {
		const pending = deferred<SourceResult>();
		const source = { read: vi.fn(() => pending.promise) };
		const meter = createMeter([live("provider", source)]);

		const firstRefresh = meter.refresh();
		await vi.waitFor(() => expect(source.read).toHaveBeenCalledTimes(1));
		await expect(meter.refresh({ force: true })).resolves.toHaveLength(1);
		expect(liveSnapshot(meter).refreshing).toBe(true);
		expect(source.read).toHaveBeenCalledTimes(1);

		pending.resolve(success(20));
		await firstRefresh;
	});

	it("enforces the start-time floor at its exact boundary", async () => {
		let currentTime = T0;
		const source = { read: vi.fn(async () => success(10)) };
		const meter = createMeter([live("provider", source)], {
			now: () => currentTime,
		});

		await meter.refresh();
		currentTime = new Date(T0.getTime() + 9_999);
		await meter.refresh({ force: true });
		expect(source.read).toHaveBeenCalledTimes(1);
		expect(liveSnapshot(meter).nextRefreshAt).toEqual(
			new Date(T0.getTime() + 10_000),
		);
		expect(liveSnapshot(meter).refreshing).toBe(false);

		currentTime = new Date(T0.getTime() + 10_000);
		await meter.refresh({ force: true });
		expect(source.read).toHaveBeenCalledTimes(2);
	});

	it("lets a later Retry-After extend the request floor without scheduling work", async () => {
		let currentTime = T0;
		const retryAt = new Date(T0.getTime() + 60_000);
		const source = {
			read: vi
				.fn<AllowanceSource["read"]>()
				.mockResolvedValueOnce({
					kind: "failure",
					failure: { reason: "rate-limited", retryAt },
				})
				.mockResolvedValueOnce(success(5)),
		};
		const meter = createMeter([live("provider", source)], {
			now: () => currentTime,
		});

		await meter.refresh();
		expect(liveSnapshot(meter).nextRefreshAt).toEqual(retryAt);
		currentTime = new Date(T0.getTime() + 59_999);
		await meter.refresh({ force: true });
		expect(source.read).toHaveBeenCalledTimes(1);

		currentTime = retryAt;
		await meter.refresh({ force: true });
		expect(source.read).toHaveBeenCalledTimes(2);
	});

	it("lets the ten-second floor dominate an earlier Retry-After", async () => {
		let currentTime = T0;
		const retryAt = new Date(T0.getTime() + 5_000);
		const source = {
			read: vi
				.fn<AllowanceSource["read"]>()
				.mockResolvedValueOnce({
					kind: "failure",
					failure: { reason: "rate-limited", retryAt },
				})
				.mockResolvedValueOnce(success(5)),
		};
		const meter = createMeter([live("provider", source)], {
			now: () => currentTime,
		});

		await meter.refresh();
		expect(liveSnapshot(meter).nextRefreshAt).toEqual(
			new Date(T0.getTime() + 10_000),
		);
		currentTime = new Date(T0.getTime() + 10_000);
		await meter.refresh({ force: true });
		expect(liveSnapshot(meter).nextRefreshAt).toEqual(
			new Date(T0.getTime() + 20_000),
		);
	});

	it("turns the request deadline into a timeout failure and discards a late result", async () => {
		vi.useFakeTimers();
		try {
			const pending = deferred<SourceResult>();
			const source = { read: vi.fn(() => pending.promise) };
			const meter = createMeter([live("provider", source)], {
				now: () => T0,
				requestDeadlineMs: 100,
			});

			const refresh = meter.refresh();
			await vi.advanceTimersByTimeAsync(100);
			await refresh;
			expect(liveSnapshot(meter)).toMatchObject({
				refreshing: false,
				latestFailure: { reason: "timeout" },
			});

			pending.resolve(success(99));
			await Promise.resolve();
			expect(liveSnapshot(meter).freshness).toBe("absent");
		} finally {
			vi.useRealTimers();
		}
	});

	it("resolves on caller abort and discards older generations that settle late", async () => {
		let currentTime = T0;
		const first = deferred<SourceResult>();
		const second = deferred<SourceResult>();
		const source = {
			read: vi
				.fn<AllowanceSource["read"]>()
				.mockImplementationOnce(() => first.promise)
				.mockImplementationOnce(() => second.promise),
		};
		const meter = createMeter([live("provider", source)], {
			now: () => currentTime,
		});
		const controller = new AbortController();

		const abortedRefresh = meter.refresh({ signal: controller.signal });
		await vi.waitFor(() => expect(source.read).toHaveBeenCalledTimes(1));
		controller.abort();
		await expect(abortedRefresh).resolves.toHaveLength(1);
		expect(liveSnapshot(meter)).toMatchObject({
			freshness: "absent",
			refreshing: false,
		});
		expect(liveSnapshot(meter).latestFailure).toBeUndefined();

		currentTime = new Date(T0.getTime() + 10_000);
		const newerRefresh = meter.refresh();
		await vi.waitFor(() => expect(source.read).toHaveBeenCalledTimes(2));
		second.resolve(success(20));
		await newerRefresh;
		first.resolve(success(90));
		await Promise.resolve();
		expect(liveSnapshot(meter).visibleReading?.windows[0]?.usedPercent).toBe(
			20,
		);
	});

	it("keeps other rows available when a source rejects unexpectedly", async () => {
		const meter = createMeter([
			live("broken", {
				read: vi.fn(async () => {
					throw new Error("raw provider error");
				}),
			}),
			live("healthy", { read: vi.fn(async () => success(15)) }),
		]);

		await expect(meter.refresh()).resolves.toHaveLength(2);
		expect(liveSnapshot(meter, 0).latestFailure?.reason).toBe("network");
		expect(liveSnapshot(meter, 1).freshness).toBe("current");
	});
});

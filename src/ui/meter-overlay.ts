import type {
	ExtensionCommandContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	visibleWidth,
	type Component,
	type OverlayOptions,
	type TUI,
} from "@earendil-works/pi-tui";

import type {
	AttemptFailure,
	LiveProviderSnapshot,
	Meter,
	ProviderSnapshot,
} from "../meter.js";
import {
	DEFAULT_ALLOWANCE_BAR_CELLS,
	DEFAULT_ALLOWANCE_BAR_CHARACTER,
	fitLine,
	formatAge,
	formatAllowanceWindow,
	formatRefreshDelay,
	padLine,
	wrapLine,
} from "./format.js";

const MIN_OVERLAY_WIDTH = 24;
const OVERLAY_NON_BAR_COLUMNS = 40;

interface MeterOverlayOptions {
	readonly barCells?: number;
	readonly barCharacter?: string;
	readonly forceRefresh?: boolean;
	readonly now?: () => Date;
	readonly overlayWidth?: OverlayOptions["width"];
}

export async function showMeterOverlay(
	ctx: ExtensionCommandContext,
	meter: Meter,
	options: MeterOverlayOptions = {},
): Promise<void> {
	const barCells = options.barCells ?? DEFAULT_ALLOWANCE_BAR_CELLS;
	const overlayWidth =
		options.overlayWidth ??
		Math.max(MIN_OVERLAY_WIDTH, barCells + OVERLAY_NON_BAR_COLUMNS);

	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) =>
			new MeterOverlay(tui, theme, meter, done, options),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: overlayWidth,
				minWidth: MIN_OVERLAY_WIDTH,
				maxHeight: "80%",
			},
		},
	);
}

export class MeterOverlay implements Component {
	private readonly abortController = new AbortController();
	private readonly barCells: number;
	private readonly barCharacter: string;
	private readonly now: () => Date;
	private unsubscribe: (() => void) | undefined;
	private freshnessTimer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;
	private feedback: string | undefined;

	constructor(
		private readonly tui: Pick<TUI, "requestRender">,
		private readonly theme: Theme,
		private readonly meter: Meter,
		private readonly done: () => void,
		options: MeterOverlayOptions = {},
	) {
		this.barCells = options.barCells ?? DEFAULT_ALLOWANCE_BAR_CELLS;
		this.barCharacter = options.barCharacter ?? DEFAULT_ALLOWANCE_BAR_CHARACTER;
		this.now = options.now ?? (() => new Date());
		this.unsubscribe = meter.subscribe(() => this.onMeterChange());
		this.scheduleFreshnessBoundary();
		this.refresh(Boolean(options.forceRefresh), false);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.close();
			return;
		}
		if (matchesKey(data, "r")) {
			this.refresh(true, true);
		}
	}

	render(width: number): string[] {
		if (width <= 2) return [fitLine("Meter", width)];

		const innerWidth = width - 2;
		const lines = [this.topBorder(innerWidth)];
		const snapshots = this.meter.snapshot();
		const labelWidth = allowanceLabelWidth(snapshots);

		snapshots.forEach((snapshot, index) => {
			lines.push(...this.renderProvider(snapshot, innerWidth, labelWidth));
			if (index < snapshots.length - 1) lines.push(this.row("", innerWidth));
		});

		if (this.feedback) {
			lines.push(this.row("", innerWidth));
			lines.push(
				this.row(` ${this.theme.fg("warning", this.feedback)}`, innerWidth),
			);
		}
		lines.push(this.row("", innerWidth));
		lines.push(
			this.row(
				` ${this.theme.fg("dim", "r refresh · Esc/q close")}`,
				innerWidth,
			),
		);
		lines.push(this.bottomBorder(innerWidth));
		return lines;
	}

	invalidate(): void {
		// Rendering is stateless and always uses the callback theme.
	}

	dispose(): void {
		this.cleanup();
	}

	private renderProvider(
		snapshot: ProviderSnapshot,
		innerWidth: number,
		labelWidth: number,
	): string[] {
		if (snapshot.support === "awaiting-interface") {
			const title = ` ${this.theme.fg("accent", snapshot.displayName)} · ${this.theme.fg("warning", "awaiting interface")}`;
			const explanation = wrapLine(
				snapshot.explanation,
				Math.max(1, innerWidth - 3),
			);
			return [
				this.row(title, innerWidth),
				...explanation.map((line) =>
					this.row(`  ${this.theme.fg("muted", line)}`, innerWidth),
				),
			];
		}

		return this.renderLiveProvider(snapshot, innerWidth, labelWidth);
	}

	private renderLiveProvider(
		snapshot: LiveProviderSnapshot,
		innerWidth: number,
		labelWidth: number,
	): string[] {
		const now = this.now();
		const reading = snapshot.visibleReading;
		if (!reading) {
			return this.renderUnavailable(snapshot, innerWidth, now);
		}

		const status = reading.plan ? ` · ${reading.plan}` : "";
		const lines = [
			this.row(
				` ${this.theme.fg("accent", snapshot.displayName)}${status}`,
				innerWidth,
			),
			...reading.windows.flatMap((window) =>
				formatAllowanceWindow(window, now, {
					labelWidth,
					bar: {
						cells: this.barCells,
						character: this.barCharacter,
						remainingStyle: (text) => this.theme.fg("success", text),
						usedStyle: (text) => this.theme.fg("muted", text),
					},
				}).map((line) => this.row(`  ${line}`, innerWidth)),
			),
		];

		const metadata = [`fetched ${formatAge(reading.fetchedAt, now)}`];
		if (snapshot.refreshing) metadata.push("refreshing");
		lines.push(
			this.row(`  ${this.theme.fg("dim", metadata.join(" · "))}`, innerWidth),
		);

		if (reading.observedAt) {
			lines.push(
				this.row(
					`  ${this.theme.fg("dim", `provider observed ${formatAge(reading.observedAt, now)}`)}`,
					innerWidth,
				),
			);
		}
		if (hasFailureAfterReading(snapshot)) {
			lines.push(
				this.row(
					`  ${this.theme.fg("warning", failureMessage(snapshot))}`,
					innerWidth,
				),
			);
		}
		return lines;
	}

	private renderUnavailable(
		snapshot: LiveProviderSnapshot,
		innerWidth: number,
		now: Date,
	): string[] {
		if (snapshot.freshness === "absent" && snapshot.refreshing) {
			return [
				this.row(
					` ${this.theme.fg("accent", snapshot.displayName)}  ${this.theme.fg("dim", "Loading…")}`,
					innerWidth,
				),
			];
		}

		const lines = [
			this.row(
				` ${this.theme.fg("accent", snapshot.displayName)} · ${this.theme.fg("warning", "usage unavailable")}`,
				innerWidth,
			),
		];
		if (snapshot.latestFailure) {
			lines.push(
				this.row(
					`  ${this.theme.fg("muted", failureMessage(snapshot))}`,
					innerWidth,
				),
			);
		}
		if (snapshot.lastSuccessAt) {
			lines.push(
				this.row(
					`  ${this.theme.fg("dim", `last successful fetch ${formatAge(snapshot.lastSuccessAt, now)}`)}`,
					innerWidth,
				),
			);
		}
		return lines;
	}

	private refresh(force: boolean, userInitiated: boolean): void {
		if (this.disposed) return;

		if (userInitiated) {
			this.feedback = refreshFeedback(this.meter.snapshot(), this.now());
			this.tui.requestRender();
		}

		void this.meter
			.refresh({ force, signal: this.abortController.signal })
			.then(() => {
				if (this.disposed) return;
				if (userInitiated && this.feedback === "Refreshing…") {
					this.feedback = undefined;
				}
				this.scheduleFreshnessBoundary();
				this.tui.requestRender();
			})
			.catch(() => {
				if (this.disposed) return;
				this.feedback = "Refresh unavailable";
				this.tui.requestRender();
			});
	}

	private onMeterChange(): void {
		if (this.disposed) return;
		this.scheduleFreshnessBoundary();
		this.tui.requestRender();
	}

	private scheduleFreshnessBoundary(): void {
		if (this.freshnessTimer) clearTimeout(this.freshnessTimer);
		this.freshnessTimer = undefined;
		if (this.disposed) return;

		const nowMs = this.now().getTime();
		const boundaries = this.meter.snapshot().flatMap((snapshot) => {
			if (
				snapshot.support !== "live" ||
				!snapshot.lastSuccessAt ||
				snapshot.freshness === "expired"
			) {
				return [];
			}
			const boundary =
				snapshot.lastSuccessAt.getTime() +
				(snapshot.freshness === "current" ? 60_001 : 300_001);
			return boundary > nowMs ? [boundary] : [];
		});
		const nextBoundary = Math.min(...boundaries);
		if (!Number.isFinite(nextBoundary)) return;

		this.freshnessTimer = setTimeout(
			() => {
				this.freshnessTimer = undefined;
				if (this.disposed) return;
				this.tui.requestRender();
				this.scheduleFreshnessBoundary();
			},
			Math.min(nextBoundary - nowMs, 2_147_483_647),
		);
	}

	private close(): void {
		if (this.disposed) return;
		this.cleanup();
		this.done();
	}

	private cleanup(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.abortController.abort();
		if (this.freshnessTimer) clearTimeout(this.freshnessTimer);
		this.freshnessTimer = undefined;
	}

	private topBorder(innerWidth: number): string {
		const title = fitLine(" Meter ", innerWidth);
		const remainder = Math.max(0, innerWidth - title.length);
		return this.theme.fg("border", `╭${title}${"─".repeat(remainder)}╮`);
	}

	private bottomBorder(innerWidth: number): string {
		return this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`);
	}

	private row(content: string, innerWidth: number): string {
		return (
			this.theme.fg("border", "│") +
			padLine(content, innerWidth) +
			this.theme.fg("border", "│")
		);
	}
}

function allowanceLabelWidth(snapshots: readonly ProviderSnapshot[]): number {
	let width = 0;
	for (const snapshot of snapshots) {
		if (snapshot.support !== "live" || !snapshot.visibleReading) continue;
		for (const window of snapshot.visibleReading.windows) {
			width = Math.max(width, visibleWidth(window.label));
		}
	}
	return width;
}

function hasFailureAfterReading(snapshot: LiveProviderSnapshot): boolean {
	return Boolean(
		snapshot.latestFailure &&
			snapshot.visibleReading &&
			snapshot.latestFailure.failedAt.getTime() >=
				snapshot.visibleReading.fetchedAt.getTime(),
	);
}

function failureMessage(snapshot: LiveProviderSnapshot): string {
	const failure: AttemptFailure | undefined = snapshot.latestFailure;
	switch (failure?.reason) {
		case "not-configured":
			return `Log in with /login ${snapshot.id}`;
		case "unauthorized":
			return `${snapshot.displayName} authentication expired`;
		case "rate-limited":
			return "Rate limited";
		case "timeout":
			return "Request timed out";
		case "network":
			return "Network unavailable";
		case "invalid-response":
			return "Provider response changed";
		default:
			return "Usage unavailable";
	}
}

function refreshFeedback(
	snapshots: readonly ProviderSnapshot[],
	now: Date,
): string {
	const live = snapshots.filter(
		(snapshot): snapshot is LiveProviderSnapshot => snapshot.support === "live",
	);
	if (live.some((snapshot) => snapshot.refreshing)) {
		return "Refresh already in progress";
	}

	const futureRefreshes = live
		.map((snapshot) => snapshot.nextRefreshAt)
		.filter(
			(nextRefreshAt): nextRefreshAt is Date =>
				nextRefreshAt !== undefined && nextRefreshAt.getTime() > now.getTime(),
		);
	if (futureRefreshes.length === live.length && futureRefreshes.length > 0) {
		const earliest = new Date(
			Math.min(...futureRefreshes.map((value) => value.getTime())),
		);
		return `Refresh available ${formatRefreshDelay(earliest, now)}`;
	}
	return "Refreshing…";
}

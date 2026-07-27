import {
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import type { AllowanceWindow } from "../meter.js";

export const DEFAULT_ALLOWANCE_BAR_CELLS = 20;
export const DEFAULT_ALLOWANCE_BAR_CHARACTER = "─";

type TextStyle = (text: string) => string;

interface AllowanceBarOptions {
	readonly cells?: number;
	readonly character?: string;
	readonly remainingStyle?: TextStyle;
	readonly usedStyle?: TextStyle;
}

interface AllowanceWindowFormatOptions {
	readonly bar?: AllowanceBarOptions;
	readonly labelWidth?: number;
}

export function remainingPercent(usedPercent: number): number {
	return Math.round(100 - usedPercent);
}

export function formatAllowanceBar(
	usedPercent: number,
	options: AllowanceBarOptions = {},
): string {
	const cells = options.cells ?? DEFAULT_ALLOWANCE_BAR_CELLS;
	const character = options.character ?? DEFAULT_ALLOWANCE_BAR_CHARACTER;
	const remaining = remainingPercent(usedPercent);
	const remainingCells = Math.round((remaining / 100) * cells);
	const usedCells = Math.max(0, cells - remainingCells);
	const styleRemaining = options.remainingStyle ?? identity;
	const styleUsed = options.usedStyle ?? identity;
	return `${styleRemaining(character.repeat(remainingCells))}${styleUsed(character.repeat(usedCells))}`;
}

export function formatAllowanceWindow(
	window: AllowanceWindow,
	now: Date,
	options: AllowanceWindowFormatOptions = {},
): readonly [string, string] {
	const remaining = remainingPercent(window.usedPercent);
	const label =
		options.labelWidth === undefined
			? window.label
			: padLine(window.label, options.labelWidth);
	const summary = `${label}  ${formatAllowanceBar(window.usedPercent, options.bar)}  ${remaining}% left`;
	const reset = window.resetsAt
		? `Next reset: ${formatTimeUntil(window.resetsAt, now)} · ${formatReset(window.resetsAt)}`
		: "Next reset: unavailable";
	return [summary, reset];
}

function formatTimeUntil(target: Date, now: Date): string {
	const delayMs = target.getTime() - now.getTime();
	if (delayMs <= 0) return "now";

	const totalMinutes = Math.ceil(delayMs / 60_000);
	if (totalMinutes < 60) return `in ${formatUnit(totalMinutes, "minute")}`;
	if (totalMinutes < 24 * 60) {
		const hours = Math.floor(totalMinutes / 60);
		const minutes = totalMinutes % 60;
		return minutes > 0
			? `in ${formatUnit(hours, "hour")} ${formatUnit(minutes, "minute")}`
			: `in ${formatUnit(hours, "hour")}`;
	}

	const totalHours = Math.ceil(totalMinutes / 60);
	const days = Math.floor(totalHours / 24);
	const hours = totalHours % 24;
	return hours > 0
		? `in ${formatUnit(days, "day")} ${formatUnit(hours, "hour")}`
		: `in ${formatUnit(days, "day")}`;
}

export function formatReset(resetsAt: Date): string {
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(resetsAt);
}

export function formatAge(at: Date, now: Date): string {
	const elapsedMs = Math.max(0, now.getTime() - at.getTime());
	if (elapsedMs < 60_000) return "just now";

	const minutes = Math.floor(elapsedMs / 60_000);
	if (minutes < 60) return `${minutes}m ago`;

	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;

	return `${Math.floor(hours / 24)}d ago`;
}

export function formatRefreshDelay(nextRefreshAt: Date, now: Date): string {
	const delayMs = nextRefreshAt.getTime() - now.getTime();
	if (delayMs <= 0) return "now";
	return `in ${Math.ceil(delayMs / 1_000)}s`;
}

export function fitLine(text: string, width: number): string {
	if (width <= 0) return "";
	return truncateToWidth(text, width, "…");
}

export function padLine(text: string, width: number): string {
	const fitted = fitLine(text, width);
	return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
}

export function wrapLine(text: string, width: number): readonly string[] {
	if (width <= 0) return [""];
	return wrapTextWithAnsi(text, width);
}

function formatUnit(value: number, unit: "minute" | "hour" | "day"): string {
	return `${value} ${unit}${value === 1 ? "" : "s"}`;
}

function identity(text: string): string {
	return text;
}

import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
	fitLine,
	formatAge,
	formatAllowanceBar,
	formatAllowanceWindow,
	formatRefreshDelay,
	formatReset,
	padLine,
	remainingPercent,
	wrapLine,
} from "./format.js";

describe("meter formatting", () => {
	it("derives remaining allowance and a parameterized twenty-cell bar", () => {
		expect(remainingPercent(38)).toBe(62);
		expect(formatAllowanceBar(38)).toBe("─".repeat(20));
		expect(formatAllowanceBar(0)).toBe("─".repeat(20));
		expect(formatAllowanceBar(100)).toBe("─".repeat(20));
		expect(
			formatAllowanceBar(50, {
				cells: 4,
				character: "|",
				remainingStyle: (text) => `<bright>${text}</bright>`,
				usedStyle: (text) => `<muted>${text}</muted>`,
			}),
		).toBe("<bright>||</bright><muted>||</muted>");
	});

	it("formats an allowance as summary and reset lines without changing its Date", () => {
		const now = new Date(2026, 6, 26, 10, 0);
		const resetsAt = new Date(2026, 6, 26, 14, 32);

		const formatted = formatAllowanceWindow(
			{
				id: "primary",
				label: "5 hour",
				usedPercent: 38,
				windowMinutes: 300,
				resetsAt,
			},
			now,
		);

		expect(formatted).toEqual([
			`5 hour  ${"─".repeat(20)}  62% left`,
			`Next reset: in 4 hours 32 minutes · ${formatReset(resetsAt)}`,
		]);
		expect(resetsAt).toEqual(new Date(2026, 6, 26, 14, 32));
	});

	it("formats reset delays and local date-times", () => {
		const now = new Date(2026, 6, 20, 10, 0);
		const reset = new Date(2026, 6, 22, 14, 32);
		const resetLine = (resetsAt: Date): string =>
			formatAllowanceWindow(
				{ id: "primary", label: "5 hour", usedPercent: 38, resetsAt },
				now,
			)[1];

		expect(resetLine(new Date(now.getTime() - 1))).toContain(
			"Next reset: now ·",
		);
		expect(resetLine(new Date(now.getTime() + 60_000))).toContain(
			"Next reset: in 1 minute ·",
		);
		expect(
			resetLine(new Date(now.getTime() + (4 * 60 * 60 + 32 * 60 + 1) * 1_000)),
		).toContain("Next reset: in 4 hours 33 minutes ·");
		expect(resetLine(reset)).toContain("Next reset: in 2 days 5 hours ·");
		expect(formatReset(reset)).toBe(
			new Intl.DateTimeFormat(undefined, {
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
				hour12: false,
			}).format(reset),
		);
	});

	it("formats fetch ages and refresh delays at their boundaries", () => {
		const now = new Date("2026-07-26T12:00:00.000Z");

		expect(formatAge(new Date(now.getTime() - 59_999), now)).toBe("just now");
		expect(formatAge(new Date(now.getTime() - 60_000), now)).toBe("1m ago");
		expect(formatAge(new Date(now.getTime() - 3_600_000), now)).toBe("1h ago");
		expect(formatAge(new Date(now.getTime() - 86_400_000), now)).toBe("1d ago");
		expect(formatRefreshDelay(now, now)).toBe("now");
		expect(formatRefreshDelay(new Date(now.getTime() + 1_001), now)).toBe(
			"in 2s",
		);
	});

	it("fits, pads, and wraps ANSI and Unicode text by visible width", () => {
		const styled =
			"\u001b[31mOpenCode 中文 provider with a long label\u001b[0m";

		expect(visibleWidth(fitLine(styled, 12))).toBeLessThanOrEqual(12);
		expect(visibleWidth(padLine(styled, 20))).toBe(20);
		expect(wrapLine(styled, 10).every((line) => visibleWidth(line) <= 10)).toBe(
			true,
		);
	});
});

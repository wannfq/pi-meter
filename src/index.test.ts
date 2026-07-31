import type {
	ExtensionAPI,
	ExtensionCommandContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import type { Meter } from "./meter.js";
import type * as MeterOverlayModule from "./ui/meter-overlay.js";

type ShowMeterOverlay = typeof MeterOverlayModule.showMeterOverlay;
const capturedState: { meter?: Meter } = {};

vi.mock("./ui/meter-overlay.js", async () => {
	const actual =
		await vi.importActual<typeof MeterOverlayModule>("./ui/meter-overlay.js");
	return {
		...actual,
		showMeterOverlay: async (
			...args: Parameters<ShowMeterOverlay>
		): Promise<void> => {
			capturedState.meter = args[1];
			await actual.showMeterOverlay(...args);
		},
	};
});

import meterExtension from "./index.js";

interface RegisteredCommand {
	readonly description?: string;
	readonly handler: (
		args: string,
		ctx: ExtensionCommandContext,
	) => Promise<void>;
}

function registerExtension(): {
	readonly command: RegisteredCommand;
	readonly registerCommand: ReturnType<typeof vi.fn>;
} {
	let command: RegisteredCommand | undefined;
	const registerCommand = vi.fn(
		(_name: string, options: RegisteredCommand): void => {
			command = options;
		},
	);
	meterExtension({ registerCommand } as unknown as ExtensionAPI);
	if (!command) throw new Error("Expected /meter registration");
	return { command, registerCommand };
}

function fakeTheme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		strikethrough: (text: string) => text,
	} as unknown as Theme;
}

function context(
	mode: ExtensionCommandContext["mode"],
	authenticated: false | true | "xai" | "both" = false,
) {
	const notify = vi.fn();
	const hasOpenAi = authenticated === true || authenticated === "both";
	const hasXaiOAuth = authenticated === "xai" || authenticated === "both";
	const getProviderAuth = vi.fn(async (provider: string) => {
		if (provider === "openai-codex" && hasOpenAi) {
			return { auth: { apiKey: "synthetic-openai-auth" } };
		}
		if (provider === "xai" && hasXaiOAuth) {
			return { auth: { apiKey: "synthetic-xai-oauth" } };
		}
		return undefined;
	});
	const getAll = vi.fn(() => [{ provider: "xai", id: "grok-4.5" }]);
	const isUsingOAuth = vi.fn(() => hasXaiOAuth);
	const renders: string[][] = [];
	const custom = vi.fn(
		async (
			factory: (
				tui: { requestRender(): void },
				theme: Theme,
				keybindings: object,
				done: () => void,
			) => Component,
			options: unknown,
		): Promise<void> => {
			await new Promise<void>((resolve) => {
				const component = factory(
					{ requestRender: vi.fn() },
					fakeTheme(),
					{},
					resolve,
				);
				renders.push(component.render(48));
				component.handleInput?.("\u001b");
			});
			void options;
		},
	);
	return {
		ctx: {
			mode,
			ui: { notify, custom },
			modelRegistry: { getAll, getProviderAuth, isUsingOAuth },
		} as unknown as ExtensionCommandContext,
		custom,
		getAll,
		getProviderAuth,
		isUsingOAuth,
		notify,
		renders,
	};
}

describe("pi-meter extension composition", () => {
	it("registers /meter without starting auth or network work", () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		try {
			const { command, registerCommand } = registerExtension();

			expect(registerCommand).toHaveBeenCalledWith(
				"meter",
				expect.objectContaining({
					description: "Show provider allowance windows",
				}),
			);
			expect(command.handler).toBeTypeOf("function");
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("rejects invalid arguments without opening or refreshing", async () => {
		const { command } = registerExtension();
		const { ctx, custom, getProviderAuth, notify } = context("tui");

		await command.handler("unexpected", ctx);

		expect(notify).toHaveBeenCalledWith("Usage: /meter [refresh]", "warning");
		expect(custom).not.toHaveBeenCalled();
		expect(getProviderAuth).not.toHaveBeenCalled();
	});

	it.each([
		"rpc",
		"json",
		"print",
	] as const)("returns an interactive-mode notice in %s mode without a request", async (mode) => {
		const { command } = registerExtension();
		const { ctx, custom, getProviderAuth, notify } = context(mode);

		await command.handler("", ctx);

		expect(notify).toHaveBeenCalledWith(
			"/meter is available in interactive mode",
			"warning",
		);
		expect(custom).not.toHaveBeenCalled();
		expect(getProviderAuth).not.toHaveBeenCalled();
	});

	it("opens unauthenticated TUI with awaiting providers", async () => {
		capturedState.meter = undefined;
		const { command } = registerExtension();
		const { ctx, custom, getProviderAuth, renders } = context("tui");

		await command.handler("", ctx);

		expect(custom).toHaveBeenCalledTimes(1);
		expect(capturedState.meter).toBeDefined();
		const meter = capturedState.meter!;
		expect(meter.snapshot().map(({ id }) => id)).toEqual([
			"openai-codex",
			"anthropic",
			"opencode-go",
			"xai",
		]);
		expect(meter.snapshot()).toEqual(
			expect.arrayContaining([
				{
					support: "awaiting-interface",
					id: "anthropic",
					displayName: "Claude",
					explanation:
						"Waiting for Anthropic to publish a supported Claude allowance interface",
				},
				{
					support: "awaiting-interface",
					id: "opencode-go",
					displayName: "OpenCode Go",
					explanation: "Waiting for a public OpenCode Go quota API",
				},
			]),
		);
		expect(getProviderAuth).not.toHaveBeenCalledWith("anthropic");
		expect(getProviderAuth).not.toHaveBeenCalledWith("opencode-go");
		const rendered = renders[0]?.join("\n") ?? "";
		const renderedText = rendered.replaceAll("│", " ").replace(/\s+/g, " ");
		expect(renderedText).toContain(
			"Waiting for Anthropic to publish a supported Claude allowance interface",
		);
		expect(renderedText).toContain("Waiting for a public OpenCode Go quota API");
	});

	it.each([
		"",
		"refresh",
	])("opens a centered overlay for /meter %s in TUI mode", async (argument) => {
		const { command } = registerExtension();
		const { ctx, custom, renders } = context("tui", true);

		await command.handler(argument, ctx);

		expect(custom).toHaveBeenCalledTimes(1);
		const rendered = renders[0]?.join("\n") ?? "";
		const renderedText = rendered.replaceAll("│", " ").replace(/\s+/g, " ");
		expect(renderedText).toContain(
			"Waiting for Anthropic to publish a supported Claude allowance interface",
		);
		expect(renderedText).toContain("Waiting for a public OpenCode Go quota API");
		expect(rendered).toContain("OpenAI Codex");
		expect(rendered).toContain("Claude");
		expect(rendered).toContain("OpenCode Go");
		expect(rendered).toContain("xAI SuperGrok");
		expect(rendered.indexOf("OpenAI Codex")).toBeLessThan(
			rendered.indexOf("Claude"),
		);
		expect(rendered.indexOf("Claude")).toBeLessThan(
			rendered.indexOf("OpenCode Go"),
		);
		expect(rendered.indexOf("OpenCode Go")).toBeLessThan(
			rendered.indexOf("xAI SuperGrok"),
		);
		expect(custom.mock.calls[0]?.[1]).toEqual({
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: 60,
				minWidth: 24,
				maxHeight: "80%",
			},
		});
	});

	it("opens for xAI OAuth without requiring OpenAI authentication", async () => {
		const fetchMock = vi
			.fn<typeof globalThis.fetch>()
			.mockRejectedValue(new DOMException("aborted", "AbortError"));
		vi.stubGlobal("fetch", fetchMock);
		try {
			const { command } = registerExtension();
			const { ctx, custom, getProviderAuth, isUsingOAuth, renders } = context(
				"tui",
				"xai",
			);

			await command.handler("", ctx);

			expect(getProviderAuth).toHaveBeenCalledWith("openai-codex");
			expect(isUsingOAuth).toHaveBeenCalled();
			expect(custom).toHaveBeenCalledTimes(1);
			expect(renders[0]?.join("\n")).toContain("xAI SuperGrok");
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

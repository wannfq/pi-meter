import { describe, expect, it, vi } from "vitest";

import type { AllowanceSource, SourceResult } from "../meter.js";
import { createOpenAiCodexProvider } from "./openai-codex.js";

const ACCOUNT_CLAIM = "https://api.openai.com/auth";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const TOKEN = syntheticJwt({
	[ACCOUNT_CLAIM]: { chatgpt_account_id: "synthetic-account" },
});

function syntheticJwt(payload: Record<string, unknown>): string {
	const encode = (value: object): string =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none" })}.${encode(payload)}.synthetic-signature`;
}

function source(options: {
	readonly fetch?: typeof globalThis.fetch;
	readonly resolveAuth?: () => Promise<
		{ readonly auth: { readonly apiKey?: string } } | undefined
	>;
}): AllowanceSource {
	const provider = createOpenAiCodexProvider({
		resolveAuth:
			options.resolveAuth ?? (async () => ({ auth: { apiKey: TOKEN } })),
		...(options.fetch ? { fetch: options.fetch } : {}),
	});
	if (provider.support !== "live") throw new Error("Expected live provider");
	return provider.source;
}

function usagePayload(
	options: {
		readonly primaryUsedPercent?: number;
		readonly primaryWindowSeconds?: number;
		readonly includeSecondary?: boolean;
	} = {},
): unknown {
	return {
		plan_type: "plus",
		rate_limit: {
			primary_window: {
				used_percent: options.primaryUsedPercent ?? 38,
				limit_window_seconds: options.primaryWindowSeconds ?? 18_000,
				reset_at: 1_893_456_000,
			},
			secondary_window:
				options.includeSecondary === false
					? null
					: {
							used_percent: 18,
							limit_window_seconds: 604_800,
							reset_at: 1_893_628_800,
						},
		},
	};
}

function jsonResponse(
	payload: unknown,
	status = 200,
	headers?: Record<string, string>,
): Response {
	return new Response(JSON.stringify(payload), { status, headers });
}

async function readWith(
	allowanceSource: AllowanceSource,
	signal = new AbortController().signal,
): Promise<SourceResult> {
	return allowanceSource.read(signal);
}

describe("OpenAI Codex provider", () => {
	it("creates the evidence-backed live provider definition", () => {
		const provider = createOpenAiCodexProvider({
			resolveAuth: async () => undefined,
			fetch: vi.fn(),
		});

		expect(provider).toMatchObject({
			support: "live",
			id: "openai-codex",
			displayName: "OpenAI Codex",
			evidence: "first-party-source",
		});
	});

	it("normalizes primary and secondary allowance windows", async () => {
		const payload = usagePayload();
		const fetchMock = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(jsonResponse(payload));

		const signal = new AbortController().signal;
		const result = await readWith(source({ fetch: fetchMock }), signal);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe(USAGE_URL);
		expect(init).toMatchObject({ method: "GET" });
		expect(init?.signal).toBe(signal);
		expect(init?.body).toBeUndefined();
		expect(init?.headers).toEqual({
			Accept: "application/json",
			Authorization: `Bearer ${TOKEN}`,
			"ChatGPT-Account-Id": "synthetic-account",
		});
		expect(result).toEqual({
			kind: "success",
			observation: {
				plan: "Plus",
				windows: [
					{
						id: "primary",
						label: "5 hour",
						usedPercent: 38,
						windowMinutes: 300,
						resetsAt: new Date(1_893_456_000_000),
					},
					{
						id: "secondary",
						label: "Weekly",
						usedPercent: 18,
						windowMinutes: 10_080,
						resetsAt: new Date(1_893_628_800_000),
					},
				],
			},
		});
		expect(JSON.stringify(result)).not.toMatch(
			/synthetic-account|authorization|bearer|token|credits|email/i,
		);
	});

	it.each([
		[86_399, "24 hour"],
		[86_400, "1 day"],
		[604_799, "168 hour"],
		[604_800, "Weekly"],
		[2_591_999, "720 hour"],
		[2_592_000, "Monthly"],
	] as const)("labels a %i-second primary window as %s", async (primaryWindowSeconds, expectedLabel) => {
		const result = await readWith(
			source({
				fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
					jsonResponse(
						usagePayload({
							primaryWindowSeconds,
							includeSecondary: false,
						}),
					),
				),
			}),
		);

		expect(result).toMatchObject({
			kind: "success",
			observation: { windows: [{ label: expectedLabel }] },
		});
	});

	it("accepts a response without the optional secondary window", async () => {
		const payload = usagePayload({
			primaryUsedPercent: 25,
			includeSecondary: false,
		});
		const result = await readWith(
			source({
				fetch: vi
					.fn<typeof globalThis.fetch>()
					.mockResolvedValue(jsonResponse(payload)),
			}),
		);

		expect(result).toMatchObject({
			kind: "success",
			observation: {
				plan: "Plus",
				windows: [
					{
						id: "primary",
						usedPercent: 25,
						windowMinutes: 300,
					},
				],
			},
		});
	});

	it.each([
		["missing auth", async (): Promise<undefined> => undefined],
		["missing token", async (): Promise<{ auth: object }> => ({ auth: {} })],
		[
			"unusable token",
			async (): Promise<{ auth: { apiKey: string } }> => ({
				auth: { apiKey: "not-a-jwt" },
			}),
		],
		[
			"missing account claim",
			async (): Promise<{ auth: { apiKey: string } }> => ({
				auth: { apiKey: syntheticJwt({ [ACCOUNT_CLAIM]: {} }) },
			}),
		],
		[
			"unsafe account claim",
			async (): Promise<{ auth: { apiKey: string } }> => ({
				auth: {
					apiKey: syntheticJwt({
						[ACCOUNT_CLAIM]: { chatgpt_account_id: "unsafe\nheader" },
					}),
				},
			}),
		],
	] as const)("returns not-configured for %s without fetching", async (_, resolveAuth) => {
		const fetchMock = vi.fn<typeof globalThis.fetch>();

		await expect(
			readWith(source({ resolveAuth, fetch: fetchMock })),
		).resolves.toEqual({
			kind: "failure",
			failure: { reason: "not-configured" },
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("maps auth resolution failure to a sanitized network failure", async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>();
		const result = await readWith(
			source({
				resolveAuth: async () => {
					throw new Error("secret auth refresh detail");
				},
				fetch: fetchMock,
			}),
		);

		expect(result).toEqual({
			kind: "failure",
			failure: { reason: "network" },
		});
		expect(JSON.stringify(result)).not.toContain("secret auth refresh detail");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([401, 403])("maps HTTP %s to unauthorized", async (status) => {
		const result = await readWith(
			source({
				fetch: vi
					.fn<typeof globalThis.fetch>()
					.mockResolvedValue(new Response(null, { status })),
			}),
		);

		expect(result).toEqual({
			kind: "failure",
			failure: { reason: "unauthorized" },
		});
	});

	it("maps HTTP 429 and a future Retry-After date without scheduling", async () => {
		const retryAt = new Date(
			Math.ceil(Date.now() / 1_000) * 1_000 + 60 * 60 * 1_000,
		);
		const result = await readWith(
			source({
				fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
					new Response(null, {
						status: 429,
						headers: { "Retry-After": retryAt.toUTCString() },
					}),
				),
			}),
		);

		expect(result).toEqual({
			kind: "failure",
			failure: { reason: "rate-limited", retryAt },
		});
	});

	it("converts Retry-After seconds relative to local receipt time", async () => {
		const now = new Date("2026-07-26T12:00:00.000Z");
		vi.useFakeTimers({ now });
		try {
			const result = await readWith(
				source({
					fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
						new Response(null, {
							status: 429,
							headers: { "Retry-After": "30" },
						}),
					),
				}),
			);

			expect(result).toEqual({
				kind: "failure",
				failure: {
					reason: "rate-limited",
					retryAt: new Date(now.getTime() + 30_000),
				},
			});

			const malformed = await readWith(
				source({
					fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
						new Response(null, {
							status: 429,
							headers: { "Retry-After": "-5" },
						}),
					),
				}),
			);
			expect(malformed).toEqual({
				kind: "failure",
				failure: { reason: "rate-limited" },
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("maps network, abort, and server failures to typed results", async () => {
		const network = await readWith(
			source({
				fetch: vi
					.fn<typeof globalThis.fetch>()
					.mockRejectedValue(new Error("socket detail")),
			}),
		);
		const server = await readWith(
			source({
				fetch: vi
					.fn<typeof globalThis.fetch>()
					.mockResolvedValue(new Response("private body", { status: 500 })),
			}),
		);
		const controller = new AbortController();
		controller.abort();
		const aborted = await readWith(
			source({
				fetch: vi
					.fn<typeof globalThis.fetch>()
					.mockRejectedValue(new DOMException("aborted", "AbortError")),
			}),
			controller.signal,
		);

		expect(network).toEqual({
			kind: "failure",
			failure: { reason: "network" },
		});
		expect(server).toEqual(network);
		expect(aborted).toEqual({
			kind: "failure",
			failure: { reason: "timeout" },
		});
		expect(JSON.stringify([network, server, aborted])).not.toMatch(
			/socket detail|private body|aborted/i,
		);
	});

	it("maps malformed JSON and schema drift to invalid-response", async () => {
		const malformedJson = await readWith(
			source({
				fetch: vi
					.fn<typeof globalThis.fetch>()
					.mockResolvedValue(new Response("{")),
			}),
		);
		expect(malformedJson).toEqual({
			kind: "failure",
			failure: { reason: "invalid-response" },
		});

		const invalidPayloads: unknown[] = [
			null,
			{},
			{ plan_type: "plus", rate_limit: null },
			{
				plan_type: "plus\nINJECT",
				rate_limit: {
					primary_window: {
						used_percent: 25,
						limit_window_seconds: 18_000,
						reset_at: 1_893_456_000,
					},
				},
			},
			{
				plan_type: "plus\u001b[2JINJECT",
				rate_limit: {
					primary_window: {
						used_percent: 25,
						limit_window_seconds: 18_000,
						reset_at: 1_893_456_000,
					},
				},
			},
			{
				plan_type: "a".repeat(65),
				rate_limit: {
					primary_window: {
						used_percent: 25,
						limit_window_seconds: 18_000,
						reset_at: 1_893_456_000,
					},
				},
			},
			{
				plan_type: "plus",
				rate_limit: { primary_window: null, secondary_window: null },
			},
			{
				plan_type: "plus",
				rate_limit: {
					primary_window: {
						used_percent: 101,
						limit_window_seconds: 18_000,
						reset_at: 1_893_456_000,
					},
				},
			},
			{
				plan_type: "plus",
				rate_limit: {
					primary_window: {
						used_percent: 25,
						limit_window_seconds: "18000",
						reset_at: 1_893_456_000,
					},
				},
			},
			{
				plan_type: "plus",
				rate_limit: {
					primary_window: {
						used_percent: 25,
						limit_window_seconds: 18_000,
						reset_at: Number.MAX_SAFE_INTEGER,
					},
				},
			},
		];

		for (const payload of invalidPayloads) {
			const result = await readWith(
				source({
					fetch: vi
						.fn<typeof globalThis.fetch>()
						.mockResolvedValue(jsonResponse(payload)),
				}),
			);
			expect(result).toEqual({
				kind: "failure",
				failure: { reason: "invalid-response" },
			});
		}
	});
});

import { describe, expect, it, vi } from "vitest";

import type { AllowanceSource, SourceResult } from "../meter.js";
import { createXaiSuperGrokProvider } from "./xai-supergrok.js";

const USER_URL = "https://cli-chat-proxy.grok.com/v1/user?include=subscription";
const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const TOKEN = "synthetic-oauth-token";
const USER_ID = "synthetic-user";

type ResolvedAuth = { readonly auth: { readonly apiKey?: string } } | undefined;

function source(options: {
	readonly fetch?: typeof globalThis.fetch;
	readonly isUsingOAuth?: () => boolean;
	readonly resolveAuth?: () => Promise<ResolvedAuth>;
}): AllowanceSource {
	const provider = createXaiSuperGrokProvider({
		isUsingOAuth: options.isUsingOAuth ?? (() => true),
		resolveAuth:
			options.resolveAuth ?? (async () => ({ auth: { apiKey: TOKEN } })),
		...(options.fetch ? { fetch: options.fetch } : {}),
	});
	if (provider.support !== "live") throw new Error("Expected live provider");
	return provider.source;
}

function billingPayload(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		config: {
			creditUsagePercent: 37.5,
			currentPeriod: {
				type: "USAGE_PERIOD_TYPE_WEEKLY",
				start: "2026-07-27T12:00:00Z",
				end: "2026-08-03T12:00:00Z",
			},
			isUnifiedBillingUser: true,
		},
		...overrides,
	};
}

function jsonResponse(
	payload: unknown,
	status = 200,
	headers?: Record<string, string>,
): Response {
	return new Response(JSON.stringify(payload), { status, headers });
}

function successfulFetch(
	billing: unknown = billingPayload(),
	user: unknown = { userId: USER_ID, subscriptionTier: "SuperGrokPro" },
): ReturnType<typeof vi.fn<typeof globalThis.fetch>> {
	return vi
		.fn<typeof globalThis.fetch>()
		.mockResolvedValueOnce(jsonResponse(user))
		.mockResolvedValueOnce(jsonResponse(billing));
}

async function readWith(
	allowanceSource: AllowanceSource,
	signal = new AbortController().signal,
): Promise<SourceResult> {
	return allowanceSource.read(signal);
}

function expectFailure(result: SourceResult, reason: string): void {
	expect(result).toEqual({ kind: "failure", failure: { reason } });
}

describe("xAI SuperGrok provider", () => {
	it("creates the evidence-backed live provider definition", () => {
		const provider = createXaiSuperGrokProvider({
			isUsingOAuth: () => false,
			resolveAuth: async () => undefined,
			fetch: vi.fn(),
		});

		expect(provider).toMatchObject({
			support: "live",
			id: "xai",
			displayName: "xAI SuperGrok",
			evidence: "first-party-source",
		});
	});

	it("uses the fixed two-request protocol and normalizes weekly usage", async () => {
		const fetchMock = successfulFetch();
		const signal = new AbortController().signal;
		const result = await readWith(source({ fetch: fetchMock }), signal);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		const [userUrl, userInit] = fetchMock.mock.calls[0] ?? [];
		expect(userUrl).toBe(USER_URL);
		expect(userInit).toMatchObject({ method: "GET" });
		expect(userInit?.signal).toBe(signal);
		expect(userInit?.body).toBeUndefined();
		expect(userInit?.headers).toEqual({
			Authorization: `Bearer ${TOKEN}`,
			"X-XAI-Token-Auth": "xai-grok-cli",
			"x-grok-client-version": "0.1.220-alpha.4",
			"x-grok-client-mode": "interactive",
		});

		const [billingUrl, billingInit] = fetchMock.mock.calls[1] ?? [];
		expect(billingUrl).toBe(BILLING_URL);
		expect(billingInit).toMatchObject({ method: "GET" });
		expect(billingInit?.signal).toBe(signal);
		expect(billingInit?.body).toBeUndefined();
		expect(billingInit?.headers).toEqual({
			Authorization: `Bearer ${TOKEN}`,
			"X-XAI-Token-Auth": "xai-grok-cli",
			"x-grok-client-version": "0.1.220-alpha.4",
			"x-grok-client-mode": "interactive",
			"x-userid": USER_ID,
		});

		expect(result).toEqual({
			kind: "success",
			observation: {
				plan: "SuperGrokPro",
				windows: [
					{
						id: "xai-supergrok-weekly",
						label: "Weekly",
						usedPercent: 37.5,
						windowMinutes: 10_080,
						resetsAt: new Date("2026-08-03T12:00:00Z"),
					},
				],
			},
		});
		expect(JSON.stringify(result)).not.toMatch(
			/synthetic|authorization|bearer|x-userid|cli-chat-proxy|raw/i,
		);
	});

	it("accepts omitted optional period and plan facts", async () => {
		const result = await readWith(
			source({
				fetch: successfulFetch(
					{ config: { creditUsagePercent: 0 } },
					{ userId: USER_ID, subscriptionTier: null },
				),
			}),
		);

		expect(result).toEqual({
			kind: "success",
			observation: {
				windows: [
					{
						id: "xai-supergrok-weekly",
						label: "Weekly",
						usedPercent: 0,
					},
				],
			},
		});
	});

	it.each([
		[
			"API-key auth",
			(): boolean => false,
			async (): Promise<ResolvedAuth> => ({ auth: { apiKey: TOKEN } }),
		],
		[
			"OAuth guard failure",
			(): boolean => {
				throw new Error("private guard detail");
			},
			async (): Promise<ResolvedAuth> => ({ auth: { apiKey: TOKEN } }),
		],
		[
			"missing auth",
			(): boolean => true,
			async (): Promise<ResolvedAuth> => undefined,
		],
		[
			"missing token",
			(): boolean => true,
			async (): Promise<ResolvedAuth> => ({ auth: {} }),
		],
		[
			"unsafe token",
			(): boolean => true,
			async (): Promise<ResolvedAuth> => ({
				auth: { apiKey: "unsafe\ncredential" },
			}),
		],
	] as const)("returns not-configured for %s without fetching", async (_, isUsingOAuth, resolveAuth) => {
		const fetchMock = vi.fn<typeof globalThis.fetch>();
		const result = await readWith(
			source({ isUsingOAuth, resolveAuth, fetch: fetchMock }),
		);

		expectFailure(result, "not-configured");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("maps auth resolution failure to a sanitized network failure", async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>();
		const result = await readWith(
			source({
				resolveAuth: async () => {
					throw new Error("private refresh detail");
				},
				fetch: fetchMock,
			}),
		);

		expectFailure(result, "network");
		expect(JSON.stringify(result)).not.toContain("private refresh detail");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		["user", 0],
		["billing", 1],
	] as const)("maps unauthorized %s responses without exposing bodies", async (_, responseIndex) => {
		const responses = [
			jsonResponse({ userId: USER_ID }),
			jsonResponse(billingPayload()),
		];
		responses[responseIndex] = new Response("private body", { status: 401 });
		const fetchMock = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(responses[0]!)
			.mockResolvedValueOnce(responses[1]!);
		const result = await readWith(source({ fetch: fetchMock }));

		expectFailure(result, "unauthorized");
		expect(JSON.stringify(result)).not.toContain("private body");
		expect(fetchMock).toHaveBeenCalledTimes(responseIndex + 1);
	});

	it.each([
		401, 403,
	])("maps billing HTTP %s to unauthorized", async (status) => {
		const fetchMock = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(jsonResponse({ userId: USER_ID }))
			.mockResolvedValueOnce(new Response(null, { status }));
		expectFailure(await readWith(source({ fetch: fetchMock })), "unauthorized");
	});

	it("maps rate limiting from either request and parses Retry-After", async () => {
		const now = new Date("2026-07-27T12:00:00.000Z");
		vi.useFakeTimers({ now });
		try {
			const userLimited = await readWith(
				source({
					fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
						new Response(null, {
							status: 429,
							headers: { "Retry-After": "30" },
						}),
					),
				}),
			);
			expect(userLimited).toEqual({
				kind: "failure",
				failure: {
					reason: "rate-limited",
					retryAt: new Date(now.getTime() + 30_000),
				},
			});

			const retryAt = new Date(now.getTime() + 60 * 60 * 1_000);
			const billingLimited = await readWith(
				source({
					fetch: vi
						.fn<typeof globalThis.fetch>()
						.mockResolvedValueOnce(jsonResponse({ userId: USER_ID }))
						.mockResolvedValueOnce(
							new Response(null, {
								status: 429,
								headers: { "Retry-After": retryAt.toUTCString() },
							}),
						),
				}),
			);
			expect(billingLimited).toEqual({
				kind: "failure",
				failure: { reason: "rate-limited", retryAt },
			});

			const malformed = await readWith(
				source({
					fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
						new Response(null, {
							status: 429,
							headers: { "Retry-After": "-5" },
						}),
					),
				}),
			);
			expectFailure(malformed, "rate-limited");
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		["user", 0],
		["billing", 1],
	] as const)("maps %s transport and server failures to sanitized results", async (_, responseIndex) => {
		const networkFetch = vi.fn<typeof globalThis.fetch>();
		if (responseIndex === 1) {
			networkFetch.mockResolvedValueOnce(jsonResponse({ userId: USER_ID }));
		}
		networkFetch.mockRejectedValueOnce(new Error("socket secret"));
		const network = await readWith(source({ fetch: networkFetch }));
		expectFailure(network, "network");

		const serverFetch = vi.fn<typeof globalThis.fetch>();
		if (responseIndex === 1) {
			serverFetch.mockResolvedValueOnce(jsonResponse({ userId: USER_ID }));
		}
		serverFetch.mockResolvedValueOnce(
			new Response("private response", { status: 500 }),
		);
		const server = await readWith(source({ fetch: serverFetch }));
		expectFailure(server, "network");
		expect(JSON.stringify([network, server])).not.toMatch(
			/socket secret|private response/i,
		);
	});

	it("maps an aborted request to timeout and never starts billing", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetchMock = vi
			.fn<typeof globalThis.fetch>()
			.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));
		const result = await readWith(
			source({ fetch: fetchMock }),
			controller.signal,
		);

		expectFailure(result, "timeout");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("does not start billing when cancellation follows user enrichment", async () => {
		const controller = new AbortController();
		const fetchMock = vi
			.fn<typeof globalThis.fetch>()
			.mockImplementationOnce(async () => {
				controller.abort();
				return jsonResponse({ userId: USER_ID });
			});
		const result = await readWith(
			source({ fetch: fetchMock }),
			controller.signal,
		);

		expectFailure(result, "timeout");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each([
		["user", new Response("{")],
		["user", jsonResponse(null)],
		["user", jsonResponse({})],
		["user", jsonResponse({ userId: "" })],
		["user", jsonResponse({ userId: "unsafe\nheader" })],
		[
			"user",
			jsonResponse({
				userId: USER_ID,
				subscriptionTier: "unsafe\u001b[2J",
			}),
		],
		["user", jsonResponse({ userId: USER_ID, subscriptionTier: " padded " })],
	] as const)("rejects malformed %s responses without requesting billing", async (_, response) => {
		const fetchMock = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(response);
		const result = await readWith(source({ fetch: fetchMock }));

		expectFailure(result, "invalid-response");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("rejects invalid billing JSON", async () => {
		const fetchMock = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(jsonResponse({ userId: USER_ID }))
			.mockResolvedValueOnce(new Response("{"));
		expectFailure(
			await readWith(source({ fetch: fetchMock })),
			"invalid-response",
		);
	});

	it.each([
		null,
		{},
		{ config: null },
		{ config: {} },
		{ config: { creditUsagePercent: "25" } },
		{ config: { creditUsagePercent: -0.1 } },
		{ config: { creditUsagePercent: 100.1 } },
		{ config: { creditUsagePercent: 25, isUnifiedBillingUser: "true" } },
		{ config: { creditUsagePercent: 25, isUnifiedBillingUser: false } },
		{
			config: {
				creditUsagePercent: 25,
				currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY" },
			},
		},
		{
			config: {
				creditUsagePercent: 25,
				currentPeriod: {
					type: "USAGE_PERIOD_TYPE_WEEKLY",
					start: "not-a-date",
					end: "2026-08-03T12:00:00Z",
				},
			},
		},
		{
			config: {
				creditUsagePercent: 25,
				currentPeriod: {
					type: "USAGE_PERIOD_TYPE_WEEKLY",
					start: "2026-02-31T12:00:00Z",
					end: "2026-03-10T12:00:00Z",
				},
			},
		},
		{
			config: {
				creditUsagePercent: 25,
				currentPeriod: {
					type: "USAGE_PERIOD_TYPE_WEEKLY",
					start: "2026-08-03T12:00:00Z",
					end: "2026-07-27T12:00:00Z",
				},
			},
		},
	] as const)("rejects malformed or unsupported billing shape %#", async (payload) => {
		const result = await readWith(source({ fetch: successfulFetch(payload) }));
		expectFailure(result, "invalid-response");
	});
});

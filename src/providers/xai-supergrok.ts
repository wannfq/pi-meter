import type {
	AllowanceSource,
	ProviderDefinition,
	SourceFailure,
	SourceObservation,
	SourceResult,
} from "../meter.js";

export const XAI_PROVIDER_ID = "xai";

// Reviewed first-party Grok Build origin and client contract at
// b189869b7755d2b482969acf6c92da3ecfeffd36.
// pi-lens-ignore: hardcoded-url
const XAI_PROXY_ORIGIN = "https://cli-chat-proxy.grok.com/v1";
// pi-lens-ignore: hardcoded-url
const XAI_USER_URL = `${XAI_PROXY_ORIGIN}/user?include=subscription`;
// pi-lens-ignore: hardcoded-url
const XAI_BILLING_URL = `${XAI_PROXY_ORIGIN}/billing?format=credits`;
const XAI_TOKEN_AUTH = "xai-grok-cli";
const XAI_CLIENT_VERSION = "0.1.220-alpha.4";
const XAI_CLIENT_MODE = "interactive";
const WEEKLY_PERIOD_TYPE = "USAGE_PERIOD_TYPE_WEEKLY";
const RFC3339_PATTERN =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

interface ResolvedXaiAuth {
	readonly auth: {
		readonly apiKey?: string;
	};
}

type ResolveAuth = () => Promise<ResolvedXaiAuth | undefined>;

export interface XaiSuperGrokProviderOptions {
	readonly isUsingOAuth: () => boolean;
	readonly resolveAuth: ResolveAuth;
	readonly fetch?: typeof globalThis.fetch;
}

export function createXaiSuperGrokProvider(
	options: XaiSuperGrokProviderOptions,
): ProviderDefinition {
	return {
		support: "live",
		id: XAI_PROVIDER_ID,
		displayName: "xAI SuperGrok",
		evidence: "first-party-source",
		source: createXaiSuperGrokSource(options),
	};
}

function createXaiSuperGrokSource(
	options: XaiSuperGrokProviderOptions,
): AllowanceSource {
	const fetchImplementation = options.fetch ?? globalThis.fetch;

	return {
		async read(signal): Promise<SourceResult> {
			let usesOAuth: boolean;
			try {
				usesOAuth = options.isUsingOAuth();
			} catch {
				return failure("not-configured");
			}
			if (!usesOAuth) return failure("not-configured");

			let resolvedAuth: ResolvedXaiAuth | undefined;
			try {
				resolvedAuth = await options.resolveAuth();
			} catch {
				return failure("network");
			}

			const bearerToken = resolvedAuth?.auth.apiKey;
			if (!bearerToken || !isSafeHeaderValue(bearerToken, 16_384)) {
				return failure("not-configured");
			}

			const userResponse = await request(fetchImplementation, XAI_USER_URL, {
				bearerToken,
				signal,
			});
			if (userResponse.kind === "failure") return userResponse;

			const userPayload = await readJson(userResponse.response);
			if (userPayload === undefined) return failure("invalid-response");
			const user = decodeUser(userPayload);
			if (!user) return failure("invalid-response");
			if (signal.aborted) return failure("timeout");

			const billingResponse = await request(
				fetchImplementation,
				XAI_BILLING_URL,
				{ bearerToken, userId: user.id, signal },
			);
			if (billingResponse.kind === "failure") return billingResponse;

			const billingPayload = await readJson(billingResponse.response);
			if (billingPayload === undefined) return failure("invalid-response");
			const observation = decodeObservation(billingPayload, user.plan);
			return observation
				? { kind: "success", observation }
				: failure("invalid-response");
		},
	};
}

async function request(
	fetchImplementation: typeof globalThis.fetch,
	url: string,
	options: {
		readonly bearerToken: string;
		readonly userId?: string;
		readonly signal: AbortSignal;
	},
): Promise<
	| { readonly kind: "success"; readonly response: Response }
	| Extract<SourceResult, { kind: "failure" }>
> {
	let response: Response;
	try {
		response = await fetchImplementation(url, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${options.bearerToken}`,
				"X-XAI-Token-Auth": XAI_TOKEN_AUTH,
				"x-grok-client-version": XAI_CLIENT_VERSION,
				"x-grok-client-mode": XAI_CLIENT_MODE,
				...(options.userId ? { "x-userid": options.userId } : {}),
			},
			signal: options.signal,
		});
	} catch {
		return failure(options.signal.aborted ? "timeout" : "network");
	}

	if (response.status === 401 || response.status === 403) {
		return failure("unauthorized");
	}
	if (response.status === 429) {
		return {
			kind: "failure",
			failure: {
				reason: "rate-limited",
				...retryAfter(response.headers.get("Retry-After")),
			},
		};
	}
	if (!response.ok) return failure("network");
	return { kind: "success", response };
}

async function readJson(response: Response): Promise<unknown | undefined> {
	try {
		return (await response.json()) as unknown;
	} catch {
		return undefined;
	}
}

function decodeUser(
	payload: unknown,
): { readonly id: string; readonly plan?: string } | undefined {
	if (!isRecord(payload)) return undefined;
	const userId = payload.userId;
	if (typeof userId !== "string" || !isSafeHeaderValue(userId, 256)) {
		return undefined;
	}

	const plan = decodePlan(payload.subscriptionTier);
	if (plan === null) return undefined;
	return { id: userId, ...(plan ? { plan } : {}) };
}

function decodeObservation(
	payload: unknown,
	plan: string | undefined,
): SourceObservation | undefined {
	if (!isRecord(payload) || !isRecord(payload.config)) return undefined;
	const config = payload.config;

	const usedPercent = parseUsedPercent(config.creditUsagePercent);
	if (usedPercent === undefined) return undefined;
	if (
		config.isUnifiedBillingUser !== undefined &&
		typeof config.isUnifiedBillingUser !== "boolean"
	) {
		return undefined;
	}
	if (config.isUnifiedBillingUser === false) return undefined;

	const period = decodePeriod(config.currentPeriod);
	if (period === null) return undefined;

	return {
		...(plan ? { plan } : {}),
		windows: [
			{
				id: "xai-supergrok-weekly",
				label: "Weekly",
				usedPercent,
				...(period
					? {
							windowMinutes: period.windowMinutes,
							resetsAt: period.resetsAt,
						}
					: {}),
			},
		],
	};
}

function decodePeriod(
	value: unknown,
):
	| { readonly windowMinutes: number; readonly resetsAt: Date }
	| undefined
	| null {
	if (value === undefined || value === null) return undefined;
	if (!isRecord(value) || value.type !== WEEKLY_PERIOD_TYPE) return null;

	const start = parseRfc3339(value.start);
	const end = parseRfc3339(value.end);
	if (!start || !end) return null;

	const durationMs = end.getTime() - start.getTime();
	const windowMinutes = durationMs / 60_000;
	if (!Number.isSafeInteger(windowMinutes) || windowMinutes <= 0) return null;

	return { windowMinutes, resetsAt: end };
}

function decodePlan(value: unknown): string | undefined | null {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string") return null;
	const plan = value.trim();
	return plan === value && isSafeDisplayValue(plan, 64) ? plan : null;
}

function parseUsedPercent(value: unknown): number | undefined {
	return typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= 100
		? value
		: undefined;
}

function parseRfc3339(value: unknown): Date | undefined {
	if (typeof value !== "string") return undefined;
	const match = RFC3339_PATTERN.exec(value);
	if (!match) return undefined;

	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6]);
	const calendarCheck = new Date(
		Date.UTC(year, month - 1, day, hour, minute, second),
	);
	if (
		calendarCheck.getUTCFullYear() !== year ||
		calendarCheck.getUTCMonth() !== month - 1 ||
		calendarCheck.getUTCDate() !== day ||
		calendarCheck.getUTCHours() !== hour ||
		calendarCheck.getUTCMinutes() !== minute ||
		calendarCheck.getUTCSeconds() !== second
	) {
		return undefined;
	}

	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? new Date(timestamp) : undefined;
}

function isSafeHeaderValue(value: string, maximumLength: number): boolean {
	return (
		value.length > 0 &&
		value.length <= maximumLength &&
		/^[\x20-\x7e]+$/.test(value)
	);
}

function isSafeDisplayValue(value: string, maximumLength: number): boolean {
	return (
		value.length > 0 &&
		value.length <= maximumLength &&
		/^[\x20-\x7e]+$/.test(value)
	);
}

function failure(
	reason: SourceFailure["reason"],
): Extract<SourceResult, { kind: "failure" }> {
	return { kind: "failure", failure: { reason } };
}

function retryAfter(value: string | null): { readonly retryAt?: Date } {
	if (!value) return {};

	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) {
		const retryAt = new Date(Date.now() + seconds * 1_000);
		return Number.isNaN(retryAt.getTime()) ? {} : { retryAt };
	}

	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && timestamp > Date.now()
		? { retryAt: new Date(timestamp) }
		: {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

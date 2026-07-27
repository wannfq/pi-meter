import type {
	AllowanceSource,
	AllowanceWindow,
	ProviderDefinition,
	SourceFailure,
	SourceObservation,
	SourceResult,
} from "../meter.js";

export const OPENAI_CODEX_PROVIDER_ID = "openai-codex";

// pi-lens-ignore: hardcoded-url
const OPENAI_CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
// JWT claim namespace, not a request origin.
// pi-lens-ignore: hardcoded-url
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

interface ResolvedOpenAiCodexAuth {
	readonly auth: {
		readonly apiKey?: string;
	};
}

interface OpenAiCodexRequestMaterial {
	readonly bearerToken: string;
	readonly accountId: string;
}

type ResolveAuth = () => Promise<ResolvedOpenAiCodexAuth | undefined>;

export interface OpenAiCodexProviderOptions {
	readonly resolveAuth: ResolveAuth;
	readonly fetch?: typeof globalThis.fetch;
}

export function createOpenAiCodexProvider(
	options: OpenAiCodexProviderOptions,
): ProviderDefinition {
	return {
		support: "live",
		id: OPENAI_CODEX_PROVIDER_ID,
		displayName: "OpenAI Codex",
		evidence: "first-party-source",
		source: createOpenAiCodexSource(options),
	};
}

function createOpenAiCodexSource(
	options: OpenAiCodexProviderOptions,
): AllowanceSource {
	const fetchImplementation = options.fetch ?? globalThis.fetch;

	return {
		async read(signal): Promise<SourceResult> {
			let resolvedAuth: ResolvedOpenAiCodexAuth | undefined;
			try {
				resolvedAuth = await options.resolveAuth();
			} catch {
				return failure("network");
			}

			const requestMaterial = resolveOpenAiCodexRequestMaterial(resolvedAuth);
			if (!requestMaterial) return failure("not-configured");

			let response: Response;
			try {
				response = await fetchImplementation(OPENAI_CODEX_USAGE_URL, {
					method: "GET",
					headers: {
						Accept: "application/json",
						Authorization: `Bearer ${requestMaterial.bearerToken}`,
						"ChatGPT-Account-Id": requestMaterial.accountId,
					},
					signal,
				});
			} catch {
				return failure(signal.aborted ? "timeout" : "network");
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

			let payload: unknown;
			try {
				payload = await response.json();
			} catch {
				return failure("invalid-response");
			}

			const observation = decodeObservation(payload);
			return observation
				? { kind: "success", observation }
				: failure("invalid-response");
		},
	};
}

function resolveOpenAiCodexRequestMaterial(
	resolvedAuth: ResolvedOpenAiCodexAuth | undefined,
): OpenAiCodexRequestMaterial | undefined {
	const bearerToken = resolvedAuth?.auth.apiKey;
	if (!bearerToken) return undefined;

	const accountId = readAccountIdClaim(bearerToken);
	if (!accountId) return undefined;

	return { bearerToken, accountId };
}

function readAccountIdClaim(token: string): string | undefined {
	try {
		const [, payloadPart] = token.split(".");
		if (!payloadPart) return undefined;

		const payload: unknown = JSON.parse(
			Buffer.from(payloadPart, "base64url").toString("utf8"),
		);
		if (!isRecord(payload)) return undefined;

		const auth = payload[OPENAI_AUTH_CLAIM];
		if (!isRecord(auth)) return undefined;

		const accountId = auth.chatgpt_account_id;
		return typeof accountId === "string" && isSafeHeaderValue(accountId)
			? accountId
			: undefined;
	} catch {
		return undefined;
	}
}

function isSafeHeaderValue(value: string): boolean {
	return value.length > 0 && /^[\x20-\x7e]+$/.test(value);
}

function failure(reason: SourceFailure["reason"]): SourceResult {
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

function decodeObservation(payload: unknown): SourceObservation | undefined {
	if (!isRecord(payload)) return undefined;

	const planType = payload.plan_type;
	if (
		typeof planType !== "string" ||
		planType.length > 64 ||
		!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(planType)
	) {
		return undefined;
	}

	const rateLimit = payload.rate_limit;
	if (!isRecord(rateLimit)) return undefined;

	const primary = decodeWindow("primary", rateLimit.primary_window);
	const secondary = decodeWindow("secondary", rateLimit.secondary_window);
	if (primary === null || secondary === null) return undefined;

	const windows = [primary, secondary].filter(
		(window): window is AllowanceWindow => window !== undefined,
	);
	if (windows.length === 0) return undefined;

	return { plan: formatPlan(planType), windows };
}

function decodeWindow(
	id: "primary" | "secondary",
	value: unknown,
): AllowanceWindow | undefined | null {
	if (value === undefined || value === null) return undefined;
	if (!isRecord(value)) return null;

	const usedPercent = parseUsedPercent(value.used_percent);
	const windowSeconds = parseSafeInteger(value.limit_window_seconds, 1);
	const resetAtSeconds = parseSafeInteger(value.reset_at, 0);
	if (
		usedPercent === undefined ||
		windowSeconds === undefined ||
		resetAtSeconds === undefined
	) {
		return null;
	}

	const resetsAt = new Date(resetAtSeconds * 1_000);
	if (Number.isNaN(resetsAt.getTime())) return null;

	const windowMinutes = Math.ceil(windowSeconds / 60);
	return {
		id,
		label: windowLabel(windowSeconds, windowMinutes),
		usedPercent,
		windowMinutes,
		resetsAt,
	};
}

function parseUsedPercent(value: unknown): number | undefined {
	return typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= 100
		? value
		: undefined;
}

function parseSafeInteger(value: unknown, minimum: number): number | undefined {
	return typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= minimum
		? value
		: undefined;
}

function windowLabel(windowSeconds: number, windowMinutes: number): string {
	const daySeconds = 24 * 60 * 60;
	const weekSeconds = 7 * daySeconds;
	const monthSeconds = 30 * daySeconds;

	if (windowSeconds === monthSeconds) return "Monthly";
	if (windowSeconds === weekSeconds) return "Weekly";
	if (windowSeconds % weekSeconds === 0) {
		const weeks = windowSeconds / weekSeconds;
		return `${weeks} weeks`;
	}
	if (windowSeconds % daySeconds === 0) {
		const days = windowSeconds / daySeconds;
		return `${days} ${days === 1 ? "day" : "days"}`;
	}
	if (windowMinutes % 60 === 0) {
		return `${windowMinutes / 60} hour`;
	}
	return `${windowMinutes} min`;
}

function formatPlan(value: string): string {
	return value
		.split("_")
		.flatMap((part) =>
			part ? [`${part.charAt(0).toUpperCase()}${part.slice(1)}`] : [],
		)
		.join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

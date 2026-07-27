export type ProviderId = string;
export type SourceEvidence = "documented" | "first-party-source";

export interface AllowanceWindow {
	readonly id: string;
	readonly label: string;
	readonly usedPercent: number;
	readonly windowMinutes?: number;
	readonly resetsAt?: Date;
}

export interface SourceObservation {
	readonly observedAt?: Date;
	readonly plan?: string;
	readonly windows: readonly AllowanceWindow[];
}

export type SourceFailureReason =
	| "not-configured"
	| "unauthorized"
	| "rate-limited"
	| "timeout"
	| "network"
	| "invalid-response";

export interface SourceFailure {
	readonly reason: SourceFailureReason;
	readonly retryAt?: Date;
}

export type SourceResult =
	| { readonly kind: "success"; readonly observation: SourceObservation }
	| { readonly kind: "failure"; readonly failure: SourceFailure };

export interface AllowanceSource {
	read(signal: AbortSignal): Promise<SourceResult>;
}

export type ProviderDefinition =
	| {
			readonly support: "live";
			readonly id: ProviderId;
			readonly displayName: string;
			readonly evidence: SourceEvidence;
			readonly source: AllowanceSource;
	  }
	| {
			readonly support: "awaiting-interface";
			readonly id: ProviderId;
			readonly displayName: string;
			readonly explanation: string;
	  };

export interface AllowanceReading extends SourceObservation {
	readonly provider: ProviderId;
	readonly fetchedAt: Date;
}

export interface AttemptFailure extends SourceFailure {
	readonly failedAt: Date;
}

export interface LiveProviderSnapshot {
	readonly support: "live";
	readonly id: ProviderId;
	readonly displayName: string;
	readonly evidence: SourceEvidence;
	readonly freshness: "absent" | "current" | "stale" | "expired";
	readonly visibleReading?: AllowanceReading;
	readonly lastSuccessAt?: Date;
	readonly latestFailure?: AttemptFailure;
	readonly nextRefreshAt?: Date;
	readonly refreshing: boolean;
}

export interface AwaitingProviderSnapshot {
	readonly support: "awaiting-interface";
	readonly id: ProviderId;
	readonly displayName: string;
	readonly explanation: string;
}

export type ProviderSnapshot = LiveProviderSnapshot | AwaitingProviderSnapshot;

export interface Meter {
	snapshot(): readonly ProviderSnapshot[];
	subscribe(listener: () => void): () => void;
	refresh(options?: {
		readonly force?: boolean;
		readonly signal?: AbortSignal;
	}): Promise<readonly ProviderSnapshot[]>;
}

export interface MeterOptions {
	readonly now?: () => Date;
	readonly requestFloorMs?: number;
	readonly requestDeadlineMs?: number;
}

interface LiveProviderState {
	readonly definition: Extract<ProviderDefinition, { support: "live" }>;
	reading?: AllowanceReading;
	latestFailure?: AttemptFailure;
	lastAttemptStartedAt?: Date;
	retryAt?: Date;
	refreshing: boolean;
	generation: number;
	inFlight?: Promise<void>;
}

interface AwaitingProviderState {
	readonly definition: Extract<
		ProviderDefinition,
		{ support: "awaiting-interface" }
	>;
}

type ProviderState = LiveProviderState | AwaitingProviderState;

const CURRENT_MAX_AGE_MS = 60_000;
const VISIBLE_MAX_AGE_MS = 5 * 60_000;
const DEFAULT_REQUEST_FLOOR_MS = 10_000;
const DEFAULT_REQUEST_DEADLINE_MS = 8_000;
const PROVIDER_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function createMeter(
	definitions: readonly ProviderDefinition[],
	options: MeterOptions = {},
): Meter {
	validateDefinitions(definitions);

	const now = options.now ?? (() => new Date());
	const requestFloorMs = options.requestFloorMs ?? DEFAULT_REQUEST_FLOOR_MS;
	const requestDeadlineMs =
		options.requestDeadlineMs ?? DEFAULT_REQUEST_DEADLINE_MS;

	if (requestFloorMs < 0 || requestDeadlineMs < 0) {
		throw new Error("Meter timing options must be non-negative");
	}

	const states: ProviderState[] = definitions.map((definition) =>
		definition.support === "live"
			? { definition, refreshing: false, generation: 0 }
			: { definition },
	);
	const listeners = new Set<() => void>();

	const notify = (): void => {
		for (const listener of [...listeners]) {
			try {
				listener();
			} catch {
				// A subscriber cannot prevent other subscribers or providers settling.
			}
		}
	};

	const snapshot = (): readonly ProviderSnapshot[] => {
		const at = now();
		return states.map((state) => makeSnapshot(state, at, requestFloorMs));
	};

	const refresh = async (
		refreshOptions: {
			readonly force?: boolean;
			readonly signal?: AbortSignal;
		} = {},
	): Promise<readonly ProviderSnapshot[]> => {
		if (refreshOptions.signal?.aborted) return snapshot();

		const attempts: Promise<void>[] = [];
		for (const state of states) {
			if (!("refreshing" in state)) continue;
			if (!shouldStart(state, now(), requestFloorMs, refreshOptions.force)) {
				continue;
			}

			const attempt = startAttempt(state, {
				now,
				requestDeadlineMs,
				callerSignal: refreshOptions.signal,
				notify,
			});
			state.inFlight = attempt;
			attempts.push(attempt);
		}

		await Promise.all(attempts);
		return snapshot();
	};

	return {
		snapshot,
		subscribe(listener): () => void {
			listeners.add(listener);
			let subscribed = true;
			return () => {
				if (!subscribed) return;
				subscribed = false;
				listeners.delete(listener);
			};
		},
		refresh,
	};
}

function validateDefinitions(definitions: readonly ProviderDefinition[]): void {
	const ids = new Set<string>();
	for (const definition of definitions) {
		if (!PROVIDER_ID_PATTERN.test(definition.id)) {
			throw new Error(`Invalid provider ID: ${definition.id}`);
		}
		if (ids.has(definition.id)) {
			throw new Error(`Duplicate provider ID: ${definition.id}`);
		}
		ids.add(definition.id);
	}
}

function makeSnapshot(
	state: ProviderState,
	at: Date,
	requestFloorMs: number,
): ProviderSnapshot {
	if (!("refreshing" in state)) {
		return {
			support: "awaiting-interface",
			id: state.definition.id,
			displayName: state.definition.displayName,
			explanation: state.definition.explanation,
		};
	}

	const freshness = getFreshness(state.reading, at);
	const nextRefreshAt = getNextRefreshAt(state, requestFloorMs);
	return {
		support: "live",
		id: state.definition.id,
		displayName: state.definition.displayName,
		evidence: state.definition.evidence,
		freshness,
		...(freshness !== "expired" && state.reading
			? { visibleReading: state.reading }
			: {}),
		...(state.reading ? { lastSuccessAt: state.reading.fetchedAt } : {}),
		...(state.latestFailure ? { latestFailure: state.latestFailure } : {}),
		...(nextRefreshAt ? { nextRefreshAt } : {}),
		refreshing: state.refreshing,
	};
}

function getFreshness(
	reading: AllowanceReading | undefined,
	at: Date,
): LiveProviderSnapshot["freshness"] {
	if (!reading) return "absent";
	const age = at.getTime() - reading.fetchedAt.getTime();
	if (age <= CURRENT_MAX_AGE_MS) return "current";
	if (age <= VISIBLE_MAX_AGE_MS) return "stale";
	return "expired";
}

function getNextRefreshAt(
	state: LiveProviderState,
	requestFloorMs: number,
): Date | undefined {
	const floorAt = state.lastAttemptStartedAt
		? new Date(state.lastAttemptStartedAt.getTime() + requestFloorMs)
		: undefined;
	if (!floorAt) return state.retryAt;
	if (!state.retryAt) return floorAt;
	return floorAt.getTime() >= state.retryAt.getTime() ? floorAt : state.retryAt;
}

function shouldStart(
	state: LiveProviderState,
	at: Date,
	requestFloorMs: number,
	force = false,
): boolean {
	if (state.inFlight || state.refreshing) return false;
	const nextRefreshAt = getNextRefreshAt(state, requestFloorMs);
	if (nextRefreshAt && at.getTime() < nextRefreshAt.getTime()) return false;
	return force || getFreshness(state.reading, at) !== "current";
}

function startAttempt(
	state: LiveProviderState,
	context: {
		readonly now: () => Date;
		readonly requestDeadlineMs: number;
		readonly callerSignal?: AbortSignal;
		readonly notify: () => void;
	},
): Promise<void> {
	const { now, requestDeadlineMs, callerSignal, notify } = context;
	const generation = ++state.generation;
	state.lastAttemptStartedAt = now();
	state.refreshing = true;
	notify();

	const controller = new AbortController();
	let endedBy: "source" | "caller" | "timeout" | undefined;
	let resolveAbort!: () => void;
	const aborted = new Promise<void>((resolve) => {
		resolveAbort = resolve;
	});

	const end = (reason: "caller" | "timeout"): void => {
		if (endedBy) return;
		endedBy = reason;
		controller.abort();
		resolveAbort();
	};
	const onCallerAbort = (): void => end("caller");
	callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
	const deadline = setTimeout(() => end("timeout"), requestDeadlineMs);

	const sourceResult = Promise.resolve()
		.then(() => state.definition.source.read(controller.signal))
		.then(
			(result) => ({ status: "result" as const, result }),
			() => ({
				status: "result" as const,
				result: {
					kind: "failure" as const,
					failure: { reason: "network" as const },
				},
			}),
		);

	return (async (): Promise<void> => {
		const outcome = await Promise.race([
			sourceResult,
			aborted.then(() => ({ status: "aborted" as const })),
		]);

		if (outcome.status === "result" && !endedBy) endedBy = "source";
		if (state.generation !== generation) return;

		if (outcome.status === "result" && endedBy === "source") {
			commitResult(state, outcome.result, now());
		} else if (endedBy === "timeout") {
			commitFailure(state, { reason: "timeout" }, now());
		}
	})().finally(() => {
		clearTimeout(deadline);
		callerSignal?.removeEventListener("abort", onCallerAbort);
		if (state.generation === generation) {
			state.refreshing = false;
			state.inFlight = undefined;
			notify();
		}
	});
}

function commitResult(
	state: LiveProviderState,
	result: SourceResult,
	at: Date,
): void {
	if (result.kind === "failure") {
		commitFailure(state, result.failure, at);
		return;
	}
	if (!isValidObservation(result.observation)) {
		commitFailure(state, { reason: "invalid-response" }, at);
		return;
	}

	state.reading = {
		...result.observation,
		provider: state.definition.id,
		fetchedAt: at,
	};
}

function commitFailure(
	state: LiveProviderState,
	failure: SourceFailure,
	at: Date,
): void {
	state.latestFailure = { ...failure, failedAt: at };
	if (
		failure.reason === "rate-limited" &&
		failure.retryAt &&
		failure.retryAt.getTime() > at.getTime()
	) {
		state.retryAt = failure.retryAt;
	}
}

function isValidObservation(observation: SourceObservation): boolean {
	return observation.windows.every(
		(window) =>
			Number.isFinite(window.usedPercent) &&
			window.usedPercent >= 0 &&
			window.usedPercent <= 100,
	);
}

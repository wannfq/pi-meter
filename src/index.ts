import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createMeter, type Meter, type ProviderDefinition } from "./meter.js";
import {
	createOpenAiCodexProvider,
	OPENAI_CODEX_PROVIDER_ID,
} from "./providers/openai-codex.js";
import {
	createXaiSuperGrokProvider,
	XAI_PROVIDER_ID,
} from "./providers/xai-supergrok.js";
import { showMeterOverlay } from "./ui/meter-overlay.js";

const CLAUDE_PROVIDER = {
	support: "awaiting-interface",
	id: "anthropic",
	displayName: "Claude",
	explanation: "Waiting for Anthropic to publish a supported Claude allowance interface",
} satisfies ProviderDefinition;

const OPENCODE_GO_PROVIDER = {
	support: "awaiting-interface",
	id: "opencode-go",
	displayName: "OpenCode Go",
	explanation: "Waiting for a public OpenCode Go quota API",
} satisfies ProviderDefinition;

/** Pi package entry point. Provider work starts only when /meter opens. */
export default function meterExtension(pi: ExtensionAPI): void {
	let meter: Meter | undefined;

	pi.registerCommand("meter", {
		description: "Show provider allowance windows",
		handler: async (args, ctx) => {
			const argument = args.trim();
			if (argument !== "" && argument !== "refresh") {
				ctx.ui.notify("Usage: /meter [refresh]", "warning");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/meter is available in interactive mode", "warning");
				return;
			}

			const isUsingXaiOAuth = (): boolean => {
				try {
					const model = ctx.modelRegistry
						.getAll()
						.find(({ provider }) => provider === XAI_PROVIDER_ID);
					return model ? ctx.modelRegistry.isUsingOAuth(model) : false;
				} catch {
					return false;
				}
			};

			meter ??= createMeter([
				createOpenAiCodexProvider({
					resolveAuth: () =>
						ctx.modelRegistry.getProviderAuth(OPENAI_CODEX_PROVIDER_ID),
				}),
				CLAUDE_PROVIDER,
				OPENCODE_GO_PROVIDER,
				createXaiSuperGrokProvider({
					isUsingOAuth: isUsingXaiOAuth,
					resolveAuth: () => ctx.modelRegistry.getProviderAuth(XAI_PROVIDER_ID),
				}),
			]);
			await showMeterOverlay(ctx, meter, {
				forceRefresh: argument === "refresh",
			});
		},
	});
}

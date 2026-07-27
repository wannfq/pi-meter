import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createMeter, type Meter } from "./meter.js";
import {
	createOpenAiCodexProvider,
	OPENAI_CODEX_PROVIDER_ID,
} from "./providers/openai-codex.js";
import {
	createXaiSuperGrokProvider,
	XAI_PROVIDER_ID,
} from "./providers/xai-supergrok.js";
import { showMeterOverlay } from "./ui/meter-overlay.js";

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

			let openAiAuth;
			try {
				openAiAuth = await ctx.modelRegistry.getProviderAuth(
					OPENAI_CODEX_PROVIDER_ID,
				);
			} catch {
				openAiAuth = undefined;
			}
			if (!openAiAuth && !isUsingXaiOAuth()) {
				ctx.ui.notify("No authenticated providers available", "info");
				return;
			}

			meter ??= createMeter([
				createOpenAiCodexProvider({
					resolveAuth: () =>
						ctx.modelRegistry.getProviderAuth(OPENAI_CODEX_PROVIDER_ID),
				}),
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

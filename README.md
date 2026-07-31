# pi-meter

`pi-meter` is a [Pi](https://github.com/earendil-works/pi-mono) extension that
shows provider allowance windows in a compact `/meter` overlay.

## Features

- Shows OpenAI Codex subscription allowance and reset times through Pi's
  existing `openai-codex` login.
- Shows xAI SuperGrok's shared weekly usage through Pi's SuperGrok / X Premium
  OAuth login.
- Keeps successful provider readings visible when another provider fails.
- Shows Claude as awaiting-interface support while Anthropic's allowance API
  remains unpublished.
- Keeps OpenCode Go as `awaiting-interface` until a public quota API exists.
- Fetches only when `/meter` opens or you request a refresh. It performs no
  startup requests or background polling.

## Install

Pi packages run with full system access. Review the source before installing.

```sh
pi install npm:@wannfq/pi-meter
```

You can also install directly from GitHub:

```sh
pi install git:github.com/wannfq/pi-meter
```

To try the extension without installing it:

```sh
pi -e npm:@wannfq/pi-meter
```

## Use

Run Pi in interactive mode, then enter:

```text
/meter
```

Use `r` to request a refresh and `Esc` or `q` to close the overlay. You can also
open the overlay with a forced refresh:

```text
/meter refresh
```

A forced refresh bypasses cached freshness, but it still respects provider rate
protection. OpenAI Codex requires an `openai-codex` account in Pi. SuperGrok
requires Pi's xAI OAuth login; an `XAI_API_KEY` alone does not grant access to
consumer subscription usage.

## Develop

This project requires Node.js and the pnpm version declared in `package.json`.

```sh
pnpm install
pnpm check
pnpm test
pnpm dev
```

`pnpm dev` starts Pi with only this extension loaded. See
[`docs/providers.md`](docs/providers.md) before adding or changing a provider.
Project conventions and validation requirements are in
[`AGENTS.md`](AGENTS.md).

## License

[MIT](LICENSE)

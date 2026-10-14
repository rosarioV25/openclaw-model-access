# openclaw-model-access

OpenClaw model provider for **130+ AI models**: Claude, GPT-5, Gemini, Grok, Kimi, GLM, DeepSeek, Llama and more. It supports tool calling.

Every request is paid on its own, in **USDC on Base** via [x402](https://x402.org), from a wallet on your own machine. There is no account, no API key and no subscription.

- **Price per request**, quoted before payment. On the same request it is usually about 5% below BlockRun for Claude, GPT-5, Gemini, Kimi and Grok. Short calls start at $0.002.
- **Spending limits**: by default at most $0.50 per call and $5 per day. Both limits are checked before anything is signed.
- **Payee locked**: the plugin only ever pays the gateway's own wallet, only in USDC on Base. A quote that names any other address is refused.
- **Tool calling**: OpenClaw agents can read files, run tools and loop exactly as they do with any other provider.

## Install

```bash
openclaw plugins install clawhub:openclaw-model-access --accept-capabilities
npx openclaw-model-access setup --write --default anthropic/claude-sonnet-5.5
openclaw gateway restart
```

The plugin is on [ClawHub](https://clawhub.ai) (security scan clean, source-linked to this repository) and on [npm](https://www.npmjs.com/package/openclaw-model-access). Installing straight from npm also works: `openclaw plugins install openclaw-model-access --force --accept-capabilities`. OpenClaw asks for `--force` because npm sources sit outside ClawHub's review.

`setup` creates a wallet in `~/.openclaw/model-access/wallet.key` (file mode 0600) and prints its address. That key file is the only copy, so back it up.

Next, send some USDC **on Base** to that address. $2–5 is enough to start. You can send it from Coinbase, from any exchange that withdraws to Base, or from your own wallet. Gas is sponsored, so the wallet does not need ETH.

Pick a model with `/model model-access/anthropic/claude-sonnet-5.5` or any other id listed by `openclaw models list`.

## Commands

| Command | What it does |
|---|---|
| `openclaw-model-access setup [--write] [--default <model>] [--port N]` | Creates the wallet and the local proxy token, then prints the `openclaw.json` block. With `--write` it merges that block into the file. |
| `openclaw-model-access wallet` | Shows the wallet address and its USDC balance on Base. |
| `openclaw-model-access spend` | Shows what was paid today, in total, and the number of calls. |
| `openclaw-model-access doctor` | Checks the configuration, the gateway, the proxy and the spending. |
| `openclaw-model-access proxy` | Runs the paying proxy on its own, for any OpenAI-compatible client (Cline, Continue, scripts). |

## Configuration (`plugins.entries.openclaw-model-access.config`)

| Key | Default | Meaning |
|---|---|---|
| `maxPerCallUsd` | `0.5` | Highest price paid for one request. |
| `maxPerDayUsd` | `5` | Highest total paid per UTC day. |
| `contextTokens` | `60000` | Context budget per request. OpenClaw compacts the session above it. |
| `port` | `8423` | Port of the local proxy (127.0.0.1 only). |
| `walletKey` | — | Pays from this key instead of `wallet.key`. You can also use the `MODEL_ACCESS_WALLET_KEY` environment variable. |
| `gateway`, `payTo` | the Model Access gateway and its wallet | Change these only together. |

## How it works

OpenClaw talks to a local OpenAI-compatible proxy at `127.0.0.1:8423`. The proxy starts with the OpenClaw Gateway; for embedded runs such as `openclaw agent exec` it starts on the first request. The proxy accepts only OpenClaw's random token, refuses browser requests, and answers `/health` without details unless the token is given. For each chat completion it goes through these steps:

1. It asks the gateway for the price. The gateway answers with an HTTP 402 x402 quote.
2. It checks the quote: token, network, payee and both limits.
3. It signs a USDC `transferWithAuthorization` for exactly that amount.
4. It sends the request again with the signed authorization and returns the answer. If OpenClaw asked for streaming, the answer comes back as streamed chunks.

Every signed payment counts toward the daily limit as soon as it is signed. It is given back only when the gateway answers that it was not charged (for example a refused request, or a refund after a model failure). A timeout or a lost connection keeps it counted. The per-call limit applies to the total paid for one request, even if the gateway re-quotes it once.

If the model fails after payment, the gateway refunds the payment automatically. The private key never leaves your machine; only signatures are sent. If the key comes from `MODEL_ACCESS_WALLET_KEY`, the plugin removes that variable from its process environment, so tools started by the agent never see it.

## Security

- The wallet key stays in `~/.openclaw/model-access/wallet.key` (0600) or in `MODEL_ACCESS_WALLET_KEY`. It is used only to sign EIP-3009 USDC authorizations locally and is never sent anywhere.
- Signing is limited to: USDC on Base, the pinned payee, the `exact` scheme with EIP-3009 (never Permit2), at most 10 minutes of validity, and the per-call and per-day limits.
- Files written: `~/.openclaw/model-access/` (wallet key, local proxy token, spending ledger, cached model list). `setup --write` also merges its block into `openclaw.json`, keeping everything else in that file.
- Network: the local proxy listens on 127.0.0.1 only. Prompts and tool definitions are sent to the gateway, and from there to the model supplier that answers.

## Limits

- Only text is accepted. Images in a prompt are replaced by a short note.
- Each request can be at most about 384 KB (roughly 90k tokens) and can ask for at most 16,384 output tokens.

## Uninstall

```bash
openclaw plugins uninstall openclaw-model-access
```

Before deleting `~/.openclaw/model-access/`, move any USDC left in the wallet elsewhere. The key is in `wallet.key`.

## Terms

Paying for a request means accepting the gateway's terms at `<gateway>/terms`. The gateway is independent and is not affiliated with any model provider.

MIT license.

# Tomorrow's Witness

*"I have traveled two years into the future and I know what happens next."*

An AI-powered time traveler that answers questions about the future, grounded in live prediction market data and real-time web search. Built with a multi-model scaffolding approach: three parallel AI "lenses" (optimist, cautionary, base-rate) are synthesized into a single coherent narrative.

## Features

- **Multi-model forecasting** — Three AI perspectives synthesized into one grounded narrative
- **Web search grounding** — Responses anchored in real current news and signals
- **Live prediction markets** — Pulls from Polymarket and Metaculus
- **Confidence calibration** — Each response rated 1-5 on how grounded the prediction is
- **Conversation memory** — Remembers past discussions across sessions
- **Dynamic dates** — Always set exactly two years from the current date

## Setup

### Prerequisites
- Node.js 18+
- An Anthropic API key

### Local development

```bash
npm install
export ANTHROPIC_API_KEY=your-key-here
npm run dev
```

Then visit `http://localhost:5173`

Note: For local dev, you'll need to run the Express server separately for the API proxy:
```bash
npm run build && npm start
```

### Deploy to Heroku

See the deployment guide below.

## Architecture

```
Browser → /api/claude (Express proxy) → Anthropic API
                                          ↓
                              Web Search → 3 Lens Calls → Synthesizer
```

The Express server keeps the Anthropic API key server-side. The browser never sees it.

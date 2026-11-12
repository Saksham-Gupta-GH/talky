# Talky

A chat agent with web search and durable, timestamped memory.

## Quick start

```bash
cp .env.example .env        # then add your GEMINI_API_KEY
npm install                 # zero third-party runtime packages
npm run dev                 # open http://localhost:3000
```

Requires **Node 20+**.  
Get a free Gemini API key at <https://aistudio.google.com/app/apikey>.

## Features

- **Web search** via Gemini 2.5 Flash's native Google Search grounding
- **Streaming responses** – first tokens appear in ~1 s
- **Timestamped memory** – recall what you asked on any specific date, weekday, or week
- **Change detection** – asks minimi-style questions like "has the pricing changed since Monday?"
- **Citations** – grounding sources shown under each answer
- **Zero dependencies** – pure Node built-ins only

## Architecture

See [DESIGN.md](./DESIGN.md) for the full architecture write-up.

## Environment

| Variable | Required | Default | Description |
|---|---|---|---|
| `GEMINI_API_KEY` | ✅ | — | Gemini API key |
| `GEMINI_MODEL` | | `gemini-2.5-flash` | Model name |
| `PORT` | | `3000` | HTTP port |

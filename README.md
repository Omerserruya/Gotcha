# GOTCHA ChatCenter

Enterprise conversational platform for customer engagement, built on modular microservices.

## Quick Start

```bash
npm install
docker compose up
```

Services start on the following ports:
- **frontend** (port 3000) - React/Next.js UI
- **gateway** (port 8080) - Nginx reverse proxy
- **auth** (port 4001) - Identity and RBAC
- **conversation** (port 4002) - Messaging and conversation threads
- **incoming-worker** (port 4003) - Inbound channel processors (email, SMS, webhook)
- **ai** (port 4006) - AI reasoning, approval engine, tool execution
- **voice-copilot** (port 4007) - Twilio Media Streams ingress; dual-channel audio → STT → voice_stream events to ai-assist. See services/voice-copilot/README.md.

## Services

| Service | Port | Purpose |
|---------|------|---------|
| **ai** | 4006 | AI assistant, copilot, reasoning, tool invocation, approval queue |
| **auth** | 4001 | Identity, authentication, RBAC |
| **conversation** | 4002 | Conversations, messages, threads, broadcast history |
| **incoming-worker** | 4003 | Inbound channels (email, SMS, Messenger, WhatsApp, Slack, webchat) |
| **voice-copilot** | 4007 | Voice call ingestion via Twilio Media Streams |

## Documentation

- **[Voice Copilot Service](services/voice-copilot/README.md)** - Real-time call transcription and copilot dispatch
- **[Architecture](CLAUDE.md)** - System design principles and AI execution boundaries

## Development

Run tests across all services:
```bash
npm run test
```

Start development servers:
```bash
npm run dev
```

## License

Proprietary.

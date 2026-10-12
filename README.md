# Shahid Ma3i

A production-ready remote visual assistance application built with WebRTC and Socket.io.

## Features

- Temporary room links
- Camera and microphone streaming
- Automatic Socket.io reconnection
- ICE restart and peer recovery on failure
- TURN support via environment variables
- Security middleware for production

## Local development

```bash
npm install
npm start
```

Open:

```text
http://localhost:3000
```

## Environment variables

Copy `.env.example` to `.env` and adjust the values:

- `PORT`
- `CORS_ORIGIN`
- `TURN_URL`
- `TURN_USERNAME`
- `TURN_PASSWORD`

### TURN behavior

- If `TURN_URL`, `TURN_USERNAME`, and `TURN_PASSWORD` are set, the client uses STUN + TURN.
- If they are missing, the client uses STUN only.

## Railway deployment

1. Push the repository to GitHub.
2. Create a Railway service from the repo.
3. Set the environment variables in Railway.
4. Use `npm start` as the start command.
5. Add the Railway domain to `CORS_ORIGIN`.

## Project structure

- `index.html` — application shell
- `style.css` — responsive UI
- `app.js` — client-side WebRTC and Socket.io logic
- `server.js` — Express + Socket.io server
- `.env.example` — environment sample
- `docs/TURN_SETUP.md` — Coturn setup guide

## Production notes

The server includes:

- `helmet`
- `compression`
- `cors`
- `express-rate-limit`
- `dotenv`

The room system also includes cleanup for empty rooms and clearer lifecycle handling.

## TURN setup

See `docs/TURN_SETUP.md` for:

- Coturn installation on Ubuntu 22.04
- Required firewall ports
- TLS configuration
- TURN user creation
- Server testing

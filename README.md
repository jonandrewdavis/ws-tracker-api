# ws-tracker-api

This is a simple Cloudflare Worker designed to provide extra utility for ws-tracker-server, including:

- `/turn`: Retrieves a JSON response with new Ice Servers to use for TURN
- `/queue`: Request matchmaking with exactly 1 other peer

TODO: Improve the name of the queue

```
wrangler queues create my-first-queue
```

## Local Development

Uses `yarn` and `wrangler`

```
yarn start
```

Then access on:

```
[wrangler:info] Ready on http://localhost:8787
```

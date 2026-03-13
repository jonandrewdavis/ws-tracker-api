# ws-tracker-api

This is a simple Cloudflare Worker designed to provide extra utility for ws-tracker-server, including:

- `/turn`: Retrieves a JSON response with new Ice Servers to use for TURN
- `/queue`: (TBD) an in development endpoint for simple matchmaking to get matched up with a room given a certain tracker

TODO: Improve the name of the queue

```
wrangler queues create my-first-queue
```

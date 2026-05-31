# event-matcher

Parallel Node.js matcher service for the Node event-matcher path.

## Endpoints

| Path             | Method | Purpose                                                       |
| ---------------- | ------ | ------------------------------------------------------------- |
| `/healthz`       | GET    | Service health and enabled stages                             |
| `/config`        | GET    | Effective event-matcher config                                |
| `/match/run-now` | POST   | Run matcher against selected decisions or available snapshots |
| `/match/cron`    | POST   | Cron-shaped run endpoint                                      |
| `/impact`        | GET    | Matcher-help impact rollups                                   |

## Run locally

```bash
npx tsx services/event-matcher/server.ts
```

The service reads provider snapshots from `provider_event_snapshots` and writes
event-matcher decisions. Cron runs may apply canonical merges immediately;
manual selected runs require operator confirmation from Matcher Lab.

# Changelog

## 0.1.108

- agy 1.5.12 selects the model through `configOptions`. When `session/new` comes back without that catalog (empty or missing `configOptions`, or no `model` select), the session is closed and the request fails as a retryable 502. It is not sent to legacy `session/set_model` with an effort-suffixed id, and it is not reported as HTTP 400 "unavailable to this agy account" (plugins#1360).
- A catalog that is present and simply lacks the requested model is still 400. An older agy that selects models with `session/set_model` still does. An account Google refused is still 403.

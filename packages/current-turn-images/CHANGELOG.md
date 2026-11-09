# Changelog

## 0.4.3

- Prepare the existing 0.4.2 plugin for the community registry under
  `@magpie-community/gateway-current-turn-images`.
- Declare hook/page metadata, safe default budgets and no page read permissions.
- Keep published statistics empty; omit local install state and real test logs.
- Document aggressive request-batch filtering, Windows x64 codec support,
  caching/billing caveats, local storage and third-party licenses.
- Use an XDG data directory instead of a Windows-style path on other platforms.

## 0.4.2

- Add lossless embedded PNG/APNG, JPEG, GIF and WebP optimization with limits,
  fallback, integrity checks and per-image metrics.

## 0.4.1

- Keep the latest model request's input images instead of an entire user task.

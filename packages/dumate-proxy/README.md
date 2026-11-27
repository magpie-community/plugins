# magpie-dumate-proxy

Provider plugin for Magpie and OpenCode. Provider id: `dumate`.

The plugin connects directly to the official DuMate gateway. No local reverse proxy URL is required.

## Features

- Three sign-in methods: read-only desktop login, browser Cookie paste, and manual Cookie paste.
- Multiple independent accounts with display-name identity and upstream `uid`.
- Enumerates all available chat models and one unified image model (`dumate-image2.2`).
- Exposes one image model only; the backend always uses the strongest available `dumate-image*` model. Current strongest: `dumate-image2.2`.
- Native DuMate image tools (`image_generate_v3/async`) with task polling.
- Reference images are converted to structured prompts by a vision model, avoiding unsupported upstream edit endpoints and oversized data URLs.
- `auth.usage` exposes point balance and check-in days.
- `auth.checkin` performs automatic daily check-in and reports the actual credit delta.

## Install

```sh
magpie plugin add @magpie-community/magpie-dumate-proxy
```

Sign in with one of the DuMate methods, then refresh the model list.

## Documentation

See [docs/image-generation.md](docs/image-generation.md) for the full image-generation tutorial.

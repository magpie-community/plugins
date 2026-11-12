import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit


@dataclass(frozen=True)
class GrokTarget:
    api_url: str
    api_key: str
    source: str
    label: str


class Config:
    _instance = None
    _DEFAULT_MODEL = "grok-4.20-beta"
    _MODEL_ALIASES = {
        "grok-4.20-bate": "grok-4.20-beta",
    }

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._config_file = None
            cls._instance._cached_model = None
        return cls._instance

    @property
    def config_file(self) -> Path:
        if self._config_file is None:
            config_dir = Path(os.environ.get('GROK_CONFIG_DIR', str(Path.home() / '.magpie-search-center' / 'backend')))
            try:
                config_dir.mkdir(parents=True, exist_ok=True)
            except OSError:
                config_dir = Path.cwd() / ".grok-search"
                config_dir.mkdir(parents=True, exist_ok=True)
            self._config_file = config_dir / "config.json"
        return self._config_file

    def _load_config_file(self) -> dict:
        if not self.config_file.exists():
            return {}
        try:
            with open(self.config_file, "r", encoding="utf-8") as f:
                value = json.load(f)
            return value if isinstance(value, dict) else {}
        except (json.JSONDecodeError, IOError):
            return {}

    def _save_config_file(self, config_data: dict) -> None:
        with open(self.config_file, "w", encoding="utf-8") as f:
            json.dump(config_data, f, ensure_ascii=False, indent=2)

    def _normalize_url(self, url: str) -> str:
        value = (url or "").strip().rstrip("/")
        if not value:
            return value
        parts = urlsplit(value)
        return urlunsplit(
            (parts.scheme, parts.netloc, parts.path.rstrip("/"), parts.query, parts.fragment)
        )

    def _normalize_grok_api_url(self, url: str) -> str:
        value = self._normalize_url(url)
        if not value:
            return value
        parts = urlsplit(value)
        path = parts.path.rstrip("/")
        if path.endswith("/v1"):
            return value
        normalized_path = f"{path}/v1" if path else "/v1"
        return urlunsplit(
            (parts.scheme, parts.netloc, normalized_path, parts.query, parts.fragment)
        )

    def _split_grok_keys(self, value: str) -> list[str]:
        raw = (value or "").strip()
        if not raw:
            return []
        if raw.startswith("["):
            try:
                decoded = json.loads(raw)
            except json.JSONDecodeError:
                decoded = None
            if isinstance(decoded, list):
                values = [str(item).strip() for item in decoded]
                return [item for item in values if item]
        parts = [item.strip() for item in re.split(r"[\r\n,]+", raw)]
        return [item for item in parts if item]

    def _split_models(self, value: str) -> list[str]:
        raw = (value or "").strip()
        if not raw:
            return []
        if raw.startswith("["):
            try:
                decoded = json.loads(raw)
            except json.JSONDecodeError:
                decoded = None
            if isinstance(decoded, list):
                values = [self._MODEL_ALIASES.get(str(item).strip(), str(item).strip()) for item in decoded]
                return [item for item in values if item]
        parts = [self._MODEL_ALIASES.get(item.strip(), item.strip()) for item in re.split(r"[\r\n,]+", raw)]
        return [item for item in parts if item]

    @property
    def debug_enabled(self) -> bool:
        return os.getenv("GROK_DEBUG", "false").lower() in ("true", "1", "yes")

    @property
    def retry_max_attempts(self) -> int:
        return int(os.getenv("GROK_RETRY_MAX_ATTEMPTS", "3"))

    @property
    def retry_multiplier(self) -> float:
        return float(os.getenv("GROK_RETRY_MULTIPLIER", "1"))

    @property
    def retry_max_wait(self) -> int:
        return int(os.getenv("GROK_RETRY_MAX_WAIT", "10"))

    @property
    def grok_api_url(self) -> str:
        url = os.getenv("GROK_API_URL")
        if not url:
            raise ValueError("Missing GROK_API_URL")
        return self._normalize_grok_api_url(url)

    @property
    def grok_api_key(self) -> str:
        key = os.getenv("GROK_API_KEY", "").strip()
        if not key:
            raise ValueError("Missing GROK_API_KEY")
        return key

    @property
    def grok_api_keys(self) -> list[str]:
        keys = self._split_grok_keys(os.getenv("GROK_API_KEYS", ""))
        if keys:
            return keys

        key = os.getenv("GROK_API_KEY", "").strip()
        if key:
            return [key]

        raise ValueError("Missing GROK_API_KEY or GROK_API_KEYS")

    @property
    def grok_fallback_target(self) -> GrokTarget | None:
        url = os.getenv("GROK_FALLBACK_API_URL", "").strip()
        key = os.getenv("GROK_FALLBACK_API_KEY", "").strip()
        if not url or not key:
            return None
        return GrokTarget(
            api_url=self._normalize_grok_api_url(url),
            api_key=key,
            source="fallback",
            label="fallback",
        )

    @property
    def grok_targets(self) -> list[GrokTarget]:
        targets = [
            GrokTarget(
                api_url=self.grok_api_url,
                api_key=key,
                source="primary",
                label=f"primary-{index}",
            )
            for index, key in enumerate(self.grok_api_keys, start=1)
        ]
        fallback = self.grok_fallback_target
        if fallback is not None:
            targets.append(fallback)
        return targets

    @property
    def primary_grok_target(self) -> GrokTarget:
        targets = self.grok_targets
        if not targets:
            raise ValueError("Missing Grok targets")
        return targets[0]

    @property
    def tavily_enabled(self) -> bool:
        return os.getenv("TAVILY_ENABLED", "true").lower() in ("true", "1", "yes")

    @property
    def tavily_api_url(self) -> str:
        return self._normalize_url(os.getenv("TAVILY_API_URL", "https://api.tavily.com"))

    @property
    def tavily_api_key(self) -> str | None:
        value = os.getenv("TAVILY_API_KEY", "").strip()
        return value or None

    @property
    def firecrawl_api_url(self) -> str:
        return self._normalize_url(os.getenv("FIRECRAWL_API_URL", "https://api.firecrawl.dev"))

    @property
    def firecrawl_api_key(self) -> str | None:
        value = os.getenv("FIRECRAWL_API_KEY", "").strip()
        return value or None

    @property
    def exa_enabled(self) -> bool:
        return os.getenv("EXA_ENABLED", "true").lower() in ("true", "1", "yes")

    @property
    def exa_api_url(self) -> str:
        return self._normalize_url(os.getenv("EXA_API_URL", "https://api.exa.ai"))

    @property
    def exa_api_key(self) -> str | None:
        value = os.getenv("EXA_API_KEY", "").strip()
        return value or None

    @property
    def log_level(self) -> str:
        return os.getenv("GROK_LOG_LEVEL", "INFO").upper()

    @property
    def log_dir(self) -> Path:
        log_dir_str = os.getenv("GROK_LOG_DIR", "logs")
        log_dir = Path(log_dir_str)
        if log_dir.is_absolute():
            return log_dir

        home_log_dir = Path.home() / ".config" / "grok-search" / log_dir_str
        try:
            home_log_dir.mkdir(parents=True, exist_ok=True)
            return home_log_dir
        except OSError:
            pass

        cwd_log_dir = Path.cwd() / log_dir_str
        cwd_log_dir.mkdir(parents=True, exist_ok=True)
        return cwd_log_dir

    def _apply_model_suffix(self, model: str) -> str:
        normalized_model = self._MODEL_ALIASES.get(model, model)
        if "openrouter" in self.grok_api_url and ":online" not in normalized_model:
            return f"{normalized_model}:online"
        return normalized_model

    @property
    def grok_multi_race_models(self) -> list[str]:
        raw = os.getenv("GROK_MULTI_RACE_MODELS", "").strip()
        if not raw:
            return []
        return [m.strip() for m in raw.split(",") if m.strip()]

    @property
    def grok_models(self) -> list[str]:
        config_data = self._load_config_file()
        models = self._split_models(os.getenv("GROK_MODELS", ""))
        if not models:
            file_models = config_data.get("models")
            if isinstance(file_models, list):
                models = [self._MODEL_ALIASES.get(str(item).strip(), str(item).strip()) for item in file_models if str(item).strip()]
            elif isinstance(file_models, str):
                models = self._split_models(file_models)
        if not models:
            model = os.getenv("GROK_MODEL") or config_data.get("model") or self._DEFAULT_MODEL
            models = [self._apply_model_suffix(model)]
        return [self._apply_model_suffix(model) for model in models]

    @property
    def grok_model(self) -> str:
        if self._cached_model is not None:
            return self._cached_model
        self._cached_model = self.grok_models[0]
        return self._cached_model

    def set_model(self, model: str) -> None:
        config_data = self._load_config_file()
        config_data["model"] = model
        config_data.pop("models", None)
        self._save_config_file(config_data)
        self._cached_model = self._apply_model_suffix(model)

    def set_models(self, models: list[str]) -> None:
        normalized = [self._apply_model_suffix(model.strip()) for model in models if model and model.strip()]
        if not normalized:
            raise ValueError("At least one model is required")
        config_data = self._load_config_file()
        config_data["models"] = normalized
        config_data["model"] = normalized[0]
        self._save_config_file(config_data)
        self._cached_model = normalized[0]

    @staticmethod
    def mask_api_key(key: str | None) -> str:
        if not key:
            return "not configured"
        if len(key) <= 8:
            return "***"
        return f"{key[:4]}{'*' * (len(key) - 8)}{key[-4:]}"

    def get_config_info(self) -> dict:
        try:
            grok_url = self.grok_api_url
            grok_keys = [self.mask_api_key(key) for key in self.grok_api_keys]
            grok_key = grok_keys[0]
            fallback = self.grok_fallback_target
            fallback_url = fallback.api_url if fallback else "not configured"
            fallback_key = self.mask_api_key(fallback.api_key if fallback else None)
            status = "configured"
        except ValueError as exc:
            grok_url = "not configured"
            grok_key = "not configured"
            grok_keys = []
            fallback_url = "not configured"
            fallback_key = "not configured"
            status = f"config error: {exc}"

        return {
            "GROK_API_URL": grok_url,
            "GROK_API_KEY": grok_key,
            "GROK_API_KEYS": grok_keys,
            "GROK_KEY_COUNT": len(grok_keys),
            "GROK_FAILOVER_STRATEGY": "sticky-immediate-failover",
            "GROK_MODELS": self.grok_models,
            "GROK_FALLBACK_API_URL": fallback_url,
            "GROK_FALLBACK_API_KEY": fallback_key,
            "GROK_MODEL": self.grok_model,
            "GROK_DEBUG": self.debug_enabled,
            "GROK_LOG_LEVEL": self.log_level,
            "GROK_LOG_DIR": str(self.log_dir),
            "TAVILY_API_URL": self.tavily_api_url,
            "TAVILY_ENABLED": self.tavily_enabled,
            "TAVILY_API_KEY": self.mask_api_key(self.tavily_api_key),
            "FIRECRAWL_API_URL": self.firecrawl_api_url,
            "FIRECRAWL_API_KEY": self.mask_api_key(self.firecrawl_api_key),
            "EXA_API_URL": self.exa_api_url,
            "EXA_ENABLED": self.exa_enabled,
            "EXA_API_KEY": self.mask_api_key(self.exa_api_key),
            "config_status": status,
        }


config = Config()

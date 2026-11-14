import logging
import os
from datetime import datetime
from pathlib import Path
from .config import config

logger = logging.getLogger("grok_search")
logger.setLevel(getattr(logging, config.log_level, logging.INFO))
if not logger.handlers:
    logger.addHandler(logging.NullHandler())

_formatter = logging.Formatter(
    "%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
_file_handler_dir: Path | None = None


def _ensure_debug_handler() -> None:
    global _file_handler_dir
    raw = os.getenv("GROK_LOG_DIR", "").strip()
    if not raw:
        return
    log_dir = config.log_dir
    if _file_handler_dir == log_dir:
        return
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
        log_file = log_dir / f"grok_search_{datetime.now().strftime('%Y%m%d')}.log"
        file_handler = logging.FileHandler(log_file, encoding="utf-8")
        file_handler.setLevel(getattr(logging, config.log_level, logging.INFO))
        file_handler.setFormatter(_formatter)
        logger.addHandler(file_handler)
        _file_handler_dir = log_dir
    except OSError:
        pass


async def log_info(ctx, message: str, is_debug: bool = False):
    if is_debug:
        _ensure_debug_handler()
        logger.info(message)

    if ctx is not None and hasattr(ctx, "info"):
        await ctx.info(message)

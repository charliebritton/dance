from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=Path(__file__).parent / ".env", extra="ignore")

    anthropic_api_key: str = ""
    claude_model: str = "claude-opus-5-5"
    # Who may call Claude: "admin" (just Charlie for now) or "all" members, each capped per day.
    ai_access: str = "admin"
    ai_daily_limit: int = 10
    # USD per million tokens for claude-opus-5-5, used to estimate cost in the usage log.
    ai_price_in: float = 4.0
    ai_price_out: float = 20.0

    session_secret: str = "changeme-too"
    secure_cookies: bool = False      # True behind HTTPS in production
    # Shown in the header and striping the bar, e.g. "dev" for https://chza.me/dance-dev/. Empty in production.
    env_label: str = ""
    base_path: str = ""               # e.g. "/dance" when served at chza.me/dance (the proxy strips it)

    # Passkeys: the relying-party id is the bare domain, the origin is scheme + host (+ port) of the site.
    rp_id: str = "localhost"
    rp_name: str = "Rise & Fall"
    origin: str = "http://localhost:8021"

    db_path: Path = ROOT / "data" / "dance.db"
    upload_dir: Path = ROOT / "data" / "uploads"
    max_upload_mb: int = 500
    # Shared secret for the render worker (render/worker.mjs) that uploads each figure's 3D video.
    render_token: str = ""

    # Lesson recordings, transcribed on this server with faster-whisper (see transcribe.py). No paid API.
    whisper_model: str = "base"       # tiny | base | small; downloaded into model_dir on first use
    whisper_threads: int = 1          # keep at 1: the VPS has one CPU shared with live sites
    model_dir: Path = ROOT / "data" / "models"
    max_audio_mb: int = 300
    max_audio_minutes: int = 120
    transcribe_worker: bool = True    # the tests switch the background worker off and run jobs themselves


settings = Settings()

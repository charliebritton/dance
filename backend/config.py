from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=Path(__file__).parent / ".env", extra="ignore")

    anthropic_api_key: str = ""
    claude_model: str = "claude-opus-5-5"

    # New accounts need this code, so only you and your partner can sign up.
    invite_code: str = "changeme"
    session_secret: str = "changeme-too"
    secure_cookies: bool = False      # True behind HTTPS in production
    base_path: str = ""               # e.g. "/dance" when served at chza.me/dance (the proxy strips it)
    read_only: bool = False           # public preview: anyone can browse, nobody can sign in or save

    db_path: Path = ROOT / "data" / "dance.db"
    upload_dir: Path = ROOT / "data" / "uploads"
    max_upload_mb: int = 300


settings = Settings()

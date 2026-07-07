"""Runtime configuration via environment variables."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    openai_api_key: str = ""
    openai_model: str = "gpt-4o-mini"
    openai_ocr_model: str = "gpt-4o"
    brain_api_base_url: str = "http://localhost:3001"
    brain_api_token: str = ""

    # Anomaly scheduler (autopilot). Off by default; provide tenant ids to enable.
    brain_anomaly_scan_interval_seconds: int = 3600
    brain_anomaly_scan_tenants: str = ""  # comma-separated
    brain_anomaly_scan_batch_size: int = 100


settings = Settings()

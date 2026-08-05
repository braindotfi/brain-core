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
    # Same secret the api side uses to HMAC-sign inbound X-Brain-Auth. Reused
    # here (opposite direction) so post_parsed and propose can prove to the
    # api side that a caller-supplied tenant_id is trustworthy, not just any
    # bearer JWT.
    brain_agents_inbound_secret: str = ""
    # BRAIN_PLATFORM_SERVICE_SECRET (shared with the api side's platform-only
    # routes). When set, BrainApiClient refreshes BRAIN_API_TOKEN via the
    # return-or-rotate POST /v1/tenants/{id}/agent-token route instead of
    # running on one static token forever (F4). Left unset, refresh stays
    # dormant and behavior is unchanged.
    brain_platform_service_secret: str = ""

    # Anomaly scheduler (autopilot). Off by default; provide tenant ids to enable.
    brain_anomaly_scan_interval_seconds: int = 3600
    brain_anomaly_scan_tenants: str = ""  # comma-separated
    brain_anomaly_scan_batch_size: int = 100


settings = Settings()

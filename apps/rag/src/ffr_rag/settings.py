from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Environment configuration. Missing required values fail at startup with a clear error."""

    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    database_url: str
    ollama_base_url: str = "http://host.docker.internal:11434"
    embedding_model: str = "bge-m3"
    embedding_dim: int = 1024
    local_chat_model: str = ""
    anthropic_api_key: str = ""
    claude_model: str = "claude-haiku-4-5"
    retrieval_top_k: int = 5
    data_dir: str = "/data"


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]  # populated from the environment

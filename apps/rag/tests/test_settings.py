import pytest
from pydantic import ValidationError

from ffr_rag.settings import Settings


def test_defaults_with_database_url(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@db:5432/ffr")
    s = Settings()  # type: ignore[call-arg]
    assert s.embedding_model == "bge-m3"
    assert s.embedding_dim == 1024
    assert s.retrieval_top_k == 5


def test_missing_database_url_fails(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    with pytest.raises(ValidationError):
        Settings()  # type: ignore[call-arg]

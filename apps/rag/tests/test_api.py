from fastapi.testclient import TestClient

from ffr_rag.api import app


def test_health_ok():
    response = TestClient(app).get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}

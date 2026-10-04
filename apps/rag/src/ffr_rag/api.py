from fastapi import FastAPI

app = FastAPI(title="ffr-rag", version="0.0.0")


@app.get("/health")
def health() -> dict[str, str]:
    # Phase 5 extends this with DB + Ollama + document-store checks.
    return {"status": "ok"}

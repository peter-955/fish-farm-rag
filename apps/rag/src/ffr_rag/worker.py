"""Ingestion worker entrypoint (`python -m ffr_rag.worker`).

Phase 2 placeholder: stays alive and idle so the container is healthy under
`restart: unless-stopped`. The real job-claim loop arrives in Phase 5.
"""

import logging
import signal
import threading

logger = logging.getLogger("ffr_rag.worker")


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())

    logger.info("worker started (idle: job loop not implemented until Phase 5)")
    while not stop.wait(timeout=30):
        logger.debug("idle")
    logger.info("worker stopped")


if __name__ == "__main__":
    main()

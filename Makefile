COMPOSE      = docker compose --env-file .env -f infra/compose.yml
COMPOSE_DEV  = $(COMPOSE) -f infra/compose.dev.yml

.PHONY: help env dirs check-env up up-dev down logs ps build psql migrate pull-models

help: ## list targets
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-12s %s\n", $$1, $$2}'

env: ## create .env from the template if missing
	@test -f .env || (cp .env.example .env && echo "Created .env - set POSTGRES_PASSWORD before 'make up'")

dirs:
	@mkdir -p data/raw data/ocr data/backups

check-env:
	@! grep -q '^POSTGRES_PASSWORD=change-me' .env || { echo "Set a real POSTGRES_PASSWORD in .env first"; exit 1; }

up: env dirs check-env ## build and start the stack (Mac mini / prod-like)
	$(COMPOSE) up -d --build

up-dev: env dirs ## start with dev overrides (db port, uvicorn reload)
	$(COMPOSE_DEV) up -d --build

down: ## stop the stack (volumes are kept)
	$(COMPOSE) down

build: ## build all images
	$(COMPOSE) build

ps: ## service status
	$(COMPOSE) ps

logs: ## tail logs: make logs s=api
	$(COMPOSE) logs -f --tail=100 $(s)

psql: ## open psql in the db container
	$(COMPOSE) exec db sh -c 'psql -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"'

migrate: ## run TypeORM migrations inside the api container
	$(COMPOSE) exec api node_modules/.bin/typeorm migration:run -d dist/database/data-source.js

pull-models: ## pull the embedding model into native Ollama
	ollama pull bge-m3

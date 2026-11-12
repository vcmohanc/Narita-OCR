## =============================================================================
## Makefile — shortcuts for Docker operations
## Usage: make <target>
## =============================================================================

.PHONY: build up down logs shell db-shell restart clean ps help

## Build the app image
build:
	docker compose build --no-cache

## Start all services (detached)
up:
	docker compose up -d

## Stop all services (keep volumes)
down:
	docker compose down

## Stop all services and remove data volumes
down-v:
	docker compose down -v

## Tail app logs
logs:
	docker compose logs -f app

## Tail DB logs
logs-db:
	docker compose logs -f db

## Open a shell in the running app container
shell:
	docker compose exec app bash

## Open a MySQL shell in the DB container
db-shell:
	docker compose exec db mariadb -u ocruser -pocrpassword ocrdatabasedb

## Restart the app only (without rebuilding)
restart:
	docker compose restart app

## Full rebuild + restart
rebuild:
	docker compose down
	docker compose build --no-cache
	docker compose up -d

## Remove stopped containers, dangling images, unused networks
clean:
	docker system prune -f

## Show running containers
ps:
	docker compose ps

## GPU build + run (requires NVIDIA Container Toolkit)
up-gpu:
	docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d

## Show this help
help:
	@grep -E '^##' Makefile | sed 's/## //'


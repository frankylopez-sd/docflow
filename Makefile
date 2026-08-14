.PHONY: help setup build up down logs test clean restart shell health

# Default target
help:
	@echo "DocFlow Docker Commands"
	@echo "======================="
	@echo ""
	@echo "Setup:"
	@echo "  make setup         - Initialize Docker environment (.env, build image)"
	@echo ""
	@echo "Services:"
	@echo "  make up            - Start all services (background)"
	@echo "  make down          - Stop and remove containers"
	@echo "  make restart       - Restart all services"
	@echo "  make status        - Show container status"
	@echo ""
	@echo "Logging & Monitoring:"
	@echo "  make logs          - Follow DocFlow logs"
	@echo "  make logs-azurite  - Follow Azurite logs"
	@echo "  make logs-all      - Follow all service logs"
	@echo "  make health        - Check service health"
	@echo ""
	@echo "Development:"
	@echo "  make test          - Run test suite"
	@echo "  make test-watch    - Run tests in watch mode"
	@echo "  make coverage      - Run tests with coverage report"
	@echo "  make shell         - Open shell in DocFlow container"
	@echo "  make node          - Open Node REPL in container"
	@echo ""
	@echo "Maintenance:"
	@echo "  make clean         - Stop services and remove containers/volumes"
	@echo "  make build         - Build Docker image (no cache)"
	@echo "  make prune         - Clean up unused Docker resources"
	@echo ""

# Setup and Build
setup: .env
	@echo "Setting up Docker environment..."
	@mkdir -p azurite-data
	docker-compose build
	@echo "✓ Setup complete. Run 'make up' to start services."

.env:
	@if [ ! -f .env ]; then \
		echo "Creating .env from .env.example..."; \
		cp .env.example .env; \
		echo "✓ .env created. Update with your credentials."; \
	fi

build:
	docker-compose build --no-cache

# Service Management
up:
	docker-compose up -d
	@echo "✓ Services started. Run 'make logs' to view logs."

down:
	docker-compose down
	@echo "✓ Services stopped."

restart:
	docker-compose restart
	@echo "✓ Services restarted."

status:
	docker-compose ps

clean: down
	docker-compose down -v
	@echo "✓ All containers and volumes removed."

# Logging
logs:
	docker-compose logs -f docflow

logs-azurite:
	docker-compose logs -f azurite

logs-all:
	docker-compose logs -f

# Health Checks
health:
	@echo "Checking DocFlow health..."
	@curl -s http://localhost:7071/api/health && echo "✓ DocFlow is healthy" || echo "✗ DocFlow is not responding"
	@echo ""
	@echo "Checking Azurite health..."
	@curl -s http://localhost:10000/devstoreaccount1 >/dev/null && echo "✓ Azurite is healthy" || echo "✗ Azurite is not responding"
	@echo ""
	docker-compose ps

# Testing
test:
	docker-compose exec docflow npm test

test-watch:
	docker-compose exec docflow npm test -- --watch

coverage:
	docker-compose exec docflow npm run test:coverage

# Development Tools
shell:
	docker-compose exec docflow sh

node:
	docker-compose exec docflow node

bash:
	docker-compose exec docflow bash

# Maintenance
prune:
	@echo "Cleaning up Docker system..."
	docker system prune -f
	docker image prune -f
	docker volume prune -f
	@echo "✓ Cleanup complete."

# Docker-specific utilities
docker-stats:
	docker stats

docker-inspect:
	docker-compose exec docflow docker ps

volumes:
	docker volume ls | grep docflow

network:
	docker network inspect docflow-network

# Development convenience
install-deps:
	docker-compose exec docflow npm install

update-deps:
	docker-compose exec docflow npm update

audit:
	docker-compose exec docflow npm audit

format:
	docker-compose exec docflow npm run format 2>/dev/null || echo "No format script defined"

lint:
	docker-compose exec docflow npm run lint 2>/dev/null || echo "No lint script defined"

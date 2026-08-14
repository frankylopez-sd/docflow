#!/bin/bash

# DocFlow Docker Setup Script
# Initializes local development environment with Docker

set -e

echo "========================================"
echo "DocFlow Local Docker Setup"
echo "========================================"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo -e "${RED}Error: Docker is not installed${NC}"
    echo "Please install Docker from https://www.docker.com/products/docker-desktop"
    exit 1
fi

# Check if Docker Compose is installed
if ! command -v docker-compose &> /dev/null; then
    echo -e "${RED}Error: Docker Compose is not installed${NC}"
    echo "Please install Docker Compose (included with Docker Desktop)"
    exit 1
fi

echo -e "${GREEN}✓ Docker and Docker Compose are installed${NC}"
echo ""

# Check if .env file exists
if [ ! -f .env ]; then
    echo -e "${YELLOW}Creating .env file from .env.example...${NC}"
    cp .env.example .env
    echo -e "${GREEN}✓ .env file created${NC}"
    echo -e "${YELLOW}Warning: Update .env with your actual credentials before running services${NC}"
else
    echo -e "${GREEN}✓ .env file already exists${NC}"
fi
echo ""

# Create Azurite data directory if it doesn't exist
echo "Creating Azurite data directory..."
mkdir -p azurite-data
echo -e "${GREEN}✓ Azurite data directory ready${NC}"
echo ""

# Build Docker image
echo -e "${YELLOW}Building Docker image...${NC}"
docker-compose build

echo ""
echo -e "${GREEN}✓ Docker setup complete!${NC}"
echo ""
echo "========================================"
echo "Quick Start Commands:"
echo "========================================"
echo ""
echo "Start services:"
echo "  docker-compose up -d"
echo ""
echo "View logs:"
echo "  docker-compose logs -f docflow"
echo ""
echo "Run tests:"
echo "  docker-compose exec docflow npm test"
echo ""
echo "Stop services:"
echo "  docker-compose down"
echo ""
echo "Access Azure Functions:"
echo "  http://localhost:7071"
echo ""
echo "Access Azure Storage Emulator (Azurite):"
echo "  Blob: http://localhost:10000"
echo "  Queue: http://localhost:10001"
echo "  Table: http://localhost:10002"
echo ""
echo "========================================"

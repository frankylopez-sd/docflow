# Build stage
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm ci --only=production

# Install Azure Functions Core Tools
RUN npm install -g azure-functions-core-tools@4 --unsafe-perm

# Runtime stage
FROM node:18-alpine

WORKDIR /app

# Install curl for health checks and required system dependencies
RUN apk add --no-cache curl bash

# Copy node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy installed global tools
COPY --from=builder /usr/local/lib/node_modules /usr/local/lib/node_modules

# Create symlink for azure-functions-core-tools
RUN ln -s /usr/local/lib/node_modules/azure-functions-core-tools/bin/func /usr/local/bin/func

# Copy application code
COPY . .

# Set environment variables
ENV NODE_ENV=development \
    ENVIRONMENT=local \
    PORT=7071 \
    AzureWebJobsStorage=DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXstg9AQOLsWxAebk7zRobRciujWDUEL5R7KrHQBxWxLro6aC8roWcNA==;BlobEndpoint=http://azurite:10000/devstoreaccount1;QueueEndpoint=http://azurite:10001/devstoreaccount1;TableEndpoint=http://azurite:10002/devstoreaccount1; \
    AzureWebJobsDashboard=DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXstg9AQOLsWxAebk7zRobRciujWDUEL5R7KrHQBxWxLro6aC8roWcNA==;BlobEndpoint=http://azurite:10000/devstoreaccount1;QueueEndpoint=http://azurite:10001/devstoreaccount1;TableEndpoint=http://azurite:10002/devstoreaccount1;

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:7071/api/health || exit 1

# Expose Azure Functions default port
EXPOSE 7071

# Start Azure Functions
CMD ["func", "start", "--csharp"]

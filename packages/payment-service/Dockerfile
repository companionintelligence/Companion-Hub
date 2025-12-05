# Payment Service Dockerfile
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install

# Copy source code
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Production image
FROM node:22-alpine

WORKDIR /app

# Install production dependencies only
COPY package.json ./
RUN npm install --production

# Copy built files
COPY --from=builder /app/dist ./dist

# Create data directory for SQLite
RUN mkdir -p /data

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3001
ENV DATABASE_PATH=/data/payments.db

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/api/health || exit 1

# Run the application
CMD ["node", "dist/index.js"]

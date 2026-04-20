# =============================================================================
# Stage 1: Dependencies
# =============================================================================
FROM node:20-bookworm-slim AS deps

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# =============================================================================
# Stage 2: Builder
# =============================================================================
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Disable telemetry during build
ENV NEXT_TELEMETRY_DISABLED=1

# Build the Next.js application
# Note: NODE_ENV is set inline to avoid Next.js 16 prerendering bug
RUN NODE_ENV=production npm run build

# =============================================================================
# Stage 3: Production Runner
# =============================================================================
FROM node:20-bookworm-slim AS runner

WORKDIR /app

# Install Playwright system dependencies for Chromium
# Required for browser automation (Pinnacle token capture)
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Chromium dependencies
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    # Additional utilities
    ca-certificates \
    fonts-liberation \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user for security
RUN groupadd --gid 1001 nodejs \
    && useradd --uid 1001 --gid nodejs --shell /bin/bash --create-home nextjs

# Set production environment
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Copy built application from builder stage
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Copy Playwright for browser automation
COPY --from=builder /app/node_modules/playwright ./node_modules/playwright
COPY --from=builder /app/node_modules/playwright-core ./node_modules/playwright-core

# Create directories for persistent data (mounted as volumes in production)
RUN mkdir -p /app/sessions/betjili /app/data /app/logs \
    && chown -R nextjs:nodejs /app

# Switch to non-root user BEFORE installing Playwright
# This ensures browsers are installed to /home/nextjs/.cache/ms-playwright
USER nextjs

# Install Playwright Chromium browser (as nextjs user)
RUN node ./node_modules/playwright-core/cli.js install chromium

# Expose port
EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:3000/api/health?simple=true || exit 1

# Start the application
CMD ["node", "server.js"]

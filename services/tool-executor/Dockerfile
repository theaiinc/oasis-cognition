FROM python:3.12-slim

# Install common CLI tools + ripgrep + Node.js for code tasks
RUN apt-get update && apt-get install -y --no-install-recommends \
    coreutils findutils grep gawk sed jq tree file git ripgrep \
    curl ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user for sandboxed execution
RUN useradd -m -s /bin/bash tooluser

WORKDIR /app

COPY services/tool-executor/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# Install Playwright Chromium browser + all system deps in a shared location
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
RUN mkdir -p /opt/playwright-browsers \
    && playwright install --with-deps chromium

COPY packages/shared-utils/ ./packages/shared_utils/
RUN touch packages/__init__.py

COPY services/tool-executor/ ./services/tool_executor/
RUN touch services/__init__.py

ENV PYTHONPATH=/app

EXPOSE 8007

# Run as non-root for additional security
USER tooluser

CMD ["uvicorn", "services.tool_executor.main:app", "--host", "0.0.0.0", "--port", "8007"]

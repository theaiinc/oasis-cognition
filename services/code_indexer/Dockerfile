FROM python:3.12-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements
COPY services/code_indexer/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# Copy shared packages
COPY packages/reasoning_schema/ ./packages/reasoning_schema/
COPY packages/event_types/ ./packages/event_types/
COPY packages/shared_utils/ ./packages/shared_utils/

# Create __init__.py files for packages
RUN touch packages/__init__.py

# Copy service code
COPY services/code_indexer/ ./services/code_indexer/
RUN touch services/__init__.py

# Set environment (8010 — 8009 is observer-service)
ENV PYTHONPATH=/app
ENV PORT=8010

EXPOSE 8010

CMD ["python", "-m", "uvicorn", "services.code_indexer.main:app", "--host", "0.0.0.0", "--port", "8010"]

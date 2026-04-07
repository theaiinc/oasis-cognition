FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg tesseract-ocr && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY services/artifact_service/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# Copy shared packages (hyphen dirs → underscore dirs for Python imports)
COPY packages/reasoning-schema/ ./packages/reasoning_schema/
COPY packages/event-types/ ./packages/event_types/
COPY packages/shared-utils/ ./packages/shared_utils/
RUN touch packages/__init__.py

# Copy service
COPY services/artifact_service/ ./services/artifact_service/
RUN touch services/__init__.py

ENV PYTHONPATH=/app

EXPOSE 8012

CMD ["uvicorn", "services.artifact_service.main:app", "--host", "0.0.0.0", "--port", "8012"]

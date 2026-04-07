FROM python:3.12-slim

WORKDIR /app

COPY services/memory_service/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY packages/reasoning-schema/ ./packages/reasoning_schema/
COPY packages/event-types/ ./packages/event_types/
COPY packages/shared-utils/ ./packages/shared_utils/
RUN touch packages/__init__.py

COPY services/memory_service/ ./services/memory_service/
RUN touch services/__init__.py

ENV PYTHONPATH=/app

EXPOSE 8004

CMD ["uvicorn", "services.memory_service.main:app", "--host", "0.0.0.0", "--port", "8004"]

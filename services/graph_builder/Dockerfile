FROM python:3.12-slim

WORKDIR /app

COPY services/graph_builder/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY packages/reasoning-schema/ ./packages/reasoning_schema/
COPY packages/event-types/ ./packages/event_types/
COPY packages/shared-utils/ ./packages/shared_utils/
RUN touch packages/__init__.py

COPY services/graph_builder/ ./services/graph_builder/
RUN touch services/__init__.py

ENV PYTHONPATH=/app

EXPOSE 8002

CMD ["uvicorn", "services.graph_builder.main:app", "--host", "0.0.0.0", "--port", "8002"]

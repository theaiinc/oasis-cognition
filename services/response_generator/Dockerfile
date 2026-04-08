FROM python:3.12-slim

WORKDIR /app

COPY services/response_generator/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY packages/reasoning_schema/ ./packages/reasoning_schema/
COPY packages/event_types/ ./packages/event_types/
COPY packages/shared_utils/ ./packages/shared_utils/
RUN touch packages/__init__.py

COPY services/response_generator/ ./services/response_generator/
RUN touch services/__init__.py

# Project context for LLM awareness
COPY .oasis-context.md /workspace/.oasis-context.md

ENV PYTHONPATH=/app

EXPOSE 8005

CMD ["uvicorn", "services.response_generator.main:app", "--host", "0.0.0.0", "--port", "8005"]

FROM python:3.12-slim

WORKDIR /app

COPY services/interpreter/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# Copy shared packages (hyphen dirs → underscore dirs for Python imports)
COPY packages/reasoning_schema/ ./packages/reasoning_schema/
COPY packages/event_types/ ./packages/event_types/
COPY packages/shared_utils/ ./packages/shared_utils/
RUN touch packages/__init__.py

# Copy service
COPY services/interpreter/ ./services/interpreter/
RUN touch services/__init__.py

ENV PYTHONPATH=/app

EXPOSE 8001

CMD ["uvicorn", "services.interpreter.main:app", "--host", "0.0.0.0", "--port", "8001"]

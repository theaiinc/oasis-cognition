FROM python:3.12-slim

WORKDIR /app

COPY services/observer-service/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY packages/reasoning_schema/ ./packages/reasoning_schema/
COPY packages/shared_utils/ ./packages/shared_utils/
RUN touch packages/__init__.py

COPY services/observer-service/ ./services/observer_service/
RUN touch services/__init__.py

ENV PYTHONPATH=/app

EXPOSE 8009

CMD ["uvicorn", "services.observer_service.main:app", "--host", "0.0.0.0", "--port", "8009"]

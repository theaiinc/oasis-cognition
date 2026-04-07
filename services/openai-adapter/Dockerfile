FROM python:3.12-slim

WORKDIR /app

COPY services/openai-adapter/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY services/openai-adapter/ ./services/openai_adapter/
RUN touch services/__init__.py

ENV PYTHONPATH=/app

EXPOSE 8080

CMD ["uvicorn", "services.openai_adapter.main:app", "--host", "0.0.0.0", "--port", "8080"]

FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg libsndfile1 tesseract-ocr tesseract-ocr-eng \
    gcc build-essential && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY services/voice_agent/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY services/voice_agent/ ./services/voice_agent/
RUN touch services/__init__.py

ENV PYTHONPATH=/app

EXPOSE 8090

CMD ["uvicorn", "services.voice_agent.main:http_app", "--host", "0.0.0.0", "--port", "8090"]

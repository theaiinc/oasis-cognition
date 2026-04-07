FROM python:3.12-slim

# Install Tesseract OCR (needed by pytesseract for text extraction from screenshots)
RUN apt-get update && \
    apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY services/ui_parser/requirements.txt /app/requirements.txt

# Install CPU-only torch first (smaller), then the rest
RUN pip install --no-cache-dir \
    torch --extra-index-url https://download.pytorch.org/whl/cpu && \
    pip install --no-cache-dir -r requirements.txt

# Pre-download GroundingDINO model so it's baked into the image
RUN python -c "from transformers import AutoProcessor, AutoModelForZeroShotObjectDetection; \
    AutoProcessor.from_pretrained('IDEA-Research/grounding-dino-tiny'); \
    AutoModelForZeroShotObjectDetection.from_pretrained('IDEA-Research/grounding-dino-tiny')"

COPY packages/ /app/packages/
COPY services/ui_parser/ /app/

EXPOSE 8011

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8011"]

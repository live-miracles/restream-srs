FROM python:3.12-alpine
RUN apk add --no-cache ffmpeg
COPY restreamer.py /app/restreamer.py
CMD ["python", "/app/restreamer.py"]

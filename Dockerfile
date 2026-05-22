FROM python:3.12-slim

WORKDIR /app
COPY . /app

ENV IRIS_HOST=0.0.0.0
ENV IRIS_PORT=8000

EXPOSE 8000
CMD ["python", "-m", "equalify_iris"]

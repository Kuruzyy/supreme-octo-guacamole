#!/bin/bash

set -e  # Exit immediately if a command exits with a non-zero status

echo "Building Docker image 'wa-tools'..."
sudo docker build -t wa-tools .

echo "Stopping and removing existing 'wa-tools' container (if any)..."
sudo docker rm -f wa-tools 2>/dev/null || true

echo "Running new 'wa-tools' container..."
sudo docker run --name wa-tools \
  -p 80:3000 \
  -v ~/wa-tools/data:/home/node/app/serverData \
  -v ~/wa-tools/uploads:/home/node/app/uploads \
  -d wa-tools

echo "Container 'wa-tools' is up and running on http://localhost"
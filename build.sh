#!/bin/bash
set -e

echo "Downloading latest yt-dlp..."
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o yt-dlp
chmod a+rx yt-dlp

echo "Downloading wireproxy..."
curl -L https://github.com/pufferffish/wireproxy/releases/download/v1.0.16/wireproxy_linux_amd64.tar.gz -o wireproxy.tar.gz
tar -xzf wireproxy.tar.gz
chmod +x wireproxy
rm wireproxy.tar.gz

echo "Installing npm dependencies..."
npm install

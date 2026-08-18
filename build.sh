#!/bin/bash
set -e

echo "Downloading latest yt-dlp..."
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o yt-dlp
chmod a+rx yt-dlp

echo "Downloading aria2c..."
curl -L https://github.com/q3aql/aria2-static-builds/releases/download/v1.36.0/aria2-1.36.0-linux-gnu-64bit-build1.tar.bz2 -o aria2.tar.bz2
tar -xjf aria2.tar.bz2
mv aria2-1.36.0-linux-gnu-64bit-build1/aria2c .
chmod +x aria2c
rm -rf aria2-1.36.0-linux-gnu-64bit-build1 aria2.tar.bz2

echo "Downloading wireproxy..."
curl -L https://github.com/pufferffish/wireproxy/releases/download/v1.0.16/wireproxy_linux_amd64.tar.gz -o wireproxy.tar.gz
tar -xzf wireproxy.tar.gz
chmod +x wireproxy
rm wireproxy.tar.gz

echo "Installing npm dependencies..."
npm install

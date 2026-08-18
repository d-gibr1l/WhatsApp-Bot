#!/bin/bash
set -e

echo "Installing yt-dlp via pip..."
pip install --break-system-packages --upgrade yt-dlp

echo "Downloading aria2c..."
curl -L https://github.com/q3aql/aria2-static-builds/releases/download/v1.36.0/aria2-1.36.0-linux-gnu-64bit-build1.tar.bz2 -o aria2.tar.bz2
tar -xjf aria2.tar.bz2
mv aria2-1.36.0-linux-gnu-64bit-build1/aria2c .
chmod +x aria2c
rm -rf aria2-1.36.0-linux-gnu-64bit-build1 aria2.tar.bz2


echo "Installing npm dependencies..."
npm install

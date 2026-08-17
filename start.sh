#!/bin/bash

# Start wireproxy in the background
echo "Starting wireproxy..."
./wireproxy -c wireproxy.conf &

# Wait for WARP to establish connection
echo "Waiting 3 seconds for WARP connection..."
sleep 3

# Start the main bot process
echo "Starting WhatsApp Bot..."
node index.js

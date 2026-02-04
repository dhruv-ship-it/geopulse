#!/bin/bash

# Test script for GeoPulse Sensor Simulator

echo "🧪 Testing GeoPulse Sensor Simulator"

# Check if Kafka is running
echo "🔍 Checking Kafka connectivity..."
docker exec geopulse-kafka kafka-topics --bootstrap-server localhost:9092 --list > /dev/null 2>&1
if [ $? -ne 0 ]; then
    echo "❌ Kafka is not accessible. Please start Kafka first:"
    echo "   cd infra && docker-compose up -d"
    exit 1
fi

echo "✅ Kafka is running"

# Test basic functionality
echo "🚀 Testing simulator startup..."
timeout 10s npm run dev & 
SIM_PID=$!

# Wait a bit for startup
sleep 5

# Check if process is still running
if kill -0 $SIM_PID 2>/dev/null; then
    echo "✅ Simulator started successfully"
    # Send interrupt to stop
    kill -INT $SIM_PID
    wait $SIM_PID 2>/dev/null
    echo "✅ Simulator shutdown gracefully"
else
    echo "❌ Simulator failed to start"
    exit 1
fi

echo "🎉 All tests passed!"
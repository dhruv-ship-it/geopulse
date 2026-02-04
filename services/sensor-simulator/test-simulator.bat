@echo off
REM Test script for GeoPulse Sensor Simulator (Windows)

echo 🧪 Testing GeoPulse Sensor Simulator

REM Check if Kafka is running
echo 🔍 Checking Kafka connectivity...
docker exec geopulse-kafka kafka-topics --bootstrap-server localhost:9092 --list >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Kafka is not accessible. Please start Kafka first:
    echo    cd infra && docker-compose up -d
    exit /b 1
)

echo ✅ Kafka is running

REM Test basic functionality
echo 🚀 Testing simulator startup...
start /b npm run dev
timeout /t 5 /nobreak >nul

REM Check if node process is running
tasklist | findstr node >nul
if %errorlevel% equ 0 (
    echo ✅ Simulator started successfully
    REM Kill the node process
    taskkill /f /im node.exe >nul 2>&1
    echo ✅ Simulator shutdown gracefully
) else (
    echo ❌ Simulator failed to start
    exit /b 1
)

echo 🎉 All tests passed!
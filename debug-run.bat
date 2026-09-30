@echo off
cd /d D:\下载\minecraft-companion
set DEBUG=minecraft-protocol:*,minecraft-protocol
node dist\main.js > debug.log 2>&1

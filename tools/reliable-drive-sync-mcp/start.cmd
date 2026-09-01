@echo off
setlocal

if not defined RELIABLE_DRIVE_SYNC_INGRESS_URL (
  >&2 echo RELIABLE_DRIVE_SYNC_INGRESS_URL is required.
  exit /b 2
)
if not defined RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET (
  >&2 echo RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET is required.
  exit /b 2
)

set "NODE_EXE=%RELIABLE_DRIVE_SYNC_NODE_PATH%"
if not defined NODE_EXE set "NODE_EXE=node"

"%NODE_EXE%" "%~dp0stdio-bridge.mjs"
exit /b %ERRORLEVEL%

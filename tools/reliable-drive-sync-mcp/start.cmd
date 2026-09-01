@echo off
setlocal

rem A long-running desktop app can start after the user variables were set but
rem before its own process environment was refreshed. Read missing values from
rem the current user's persistent environment without echoing their contents.
if not defined RELIABLE_DRIVE_SYNC_INGRESS_URL (
  for /f "tokens=2,*" %%A in ('reg query "HKCU\Environment" /v RELIABLE_DRIVE_SYNC_INGRESS_URL 2^>nul') do if /I "%%A"=="REG_SZ" set "RELIABLE_DRIVE_SYNC_INGRESS_URL=%%B"
)
if not defined RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET (
  for /f "tokens=2,*" %%A in ('reg query "HKCU\Environment" /v RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET 2^>nul') do if /I "%%A"=="REG_SZ" set "RELIABLE_DRIVE_SYNC_INGRESS_SHARED_SECRET=%%B"
)

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

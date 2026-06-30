@echo off
setlocal
rem ---------------------------------------------------------------------------
rem Monthly LOCAL run of the JSA Job Creation ingest (Data Forge).
rem jobsandskills.gov.au hard-blocks our GitHub CI runner IPs, so this runs on
rem this PC instead, started by the Windows scheduled task
rem   "Performance Forge - JSA Job Creation (monthly)"
rem cd to the repo root (one level up from \scripts) so .env + relative paths
rem resolve, then run the ingest and append output to logs\jsa-jobcreation.log.
rem ---------------------------------------------------------------------------
cd /d "%~dp0.."
if not exist logs mkdir logs
echo ============================================================ >> logs\jsa-jobcreation.log
echo Run started %DATE% %TIME% >> logs\jsa-jobcreation.log
node scripts\ingest-jsa-jobcreation.mjs --write >> logs\jsa-jobcreation.log 2>&1
echo Run finished %DATE% %TIME% exit %ERRORLEVEL% >> logs\jsa-jobcreation.log
endlocal

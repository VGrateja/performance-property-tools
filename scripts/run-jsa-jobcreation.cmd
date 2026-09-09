@echo off
setlocal
rem ---------------------------------------------------------------------------
rem Monthly LOCAL run of the Data Forge ingests our CI cannot reach.
rem Started by the Windows scheduled task
rem   "Performance Forge - JSA Job Creation (monthly)"
rem The task name is kept so the registered schedule keeps working, but this
rem now runs BOTH local-run sources:
rem   - JSA Job Creation: jobsandskills.gov.au hard-blocks our CI runner IPs
rem     (connection refused, not a UA filter).
rem   - OECD Consumer Confidence: sdmx.oecd.org returns HTTP 500 "languageTag1"
rem     to the GitHub runners while the identical request from Australia
rem     returns 200 (proven twice on 2026-09-09, and it reddened 2026-08 too).
rem cd to the repo root (one level up from \scripts) so .env + relative paths
rem resolve, then run each ingest, appending output to logs\jsa-jobcreation.log.
rem ---------------------------------------------------------------------------
cd /d "%~dp0.."
if not exist logs mkdir logs
echo ============================================================ >> logs\jsa-jobcreation.log
echo Run started %DATE% %TIME% >> logs\jsa-jobcreation.log
echo -- JSA Job Creation -- >> logs\jsa-jobcreation.log
node scripts\ingest-jsa-jobcreation.mjs --write >> logs\jsa-jobcreation.log 2>&1
set JSA_RC=%ERRORLEVEL%
echo -- OECD Consumer Confidence -- >> logs\jsa-jobcreation.log
node scripts\ingest-oecd-consumer-confidence.mjs --write >> logs\jsa-jobcreation.log 2>&1
set CCI_RC=%ERRORLEVEL%
echo Run finished %DATE% %TIME% jsa=%JSA_RC% cci=%CCI_RC% >> logs\jsa-jobcreation.log
endlocal

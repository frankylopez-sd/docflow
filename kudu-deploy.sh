#!/bin/bash
cd /d "D:\home\site\wwwroot"
rm -rf * 2>/dev/null || true
curl -X POST \
  -H "Content-Type: application/octet-stream" \
  --data-binary @"C:\Users\Franky.Lopez\docflow\deploy-docflow.zip" \
  "https://doc-automation-func.scm.azurewebsites.net/api/zipdeploy?isAsync=false"
npm install --production
echo "DONE - Restart app in Portal"

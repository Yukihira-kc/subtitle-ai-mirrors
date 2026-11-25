#!/usr/bin/env bash
# Run in the dedicated repository checkout using an authenticated Azure CLI.
set -euo pipefail
cd "$(dirname "$0")"
group=rg-subtitle-ai-mirrors
plan=asp-subtitle-ai-mirrors
location=${AZURE_LOCATION:-japaneast}
sub=$(az account show --query id -o tsv)
suffix=$(printf %s "$sub" | sha256sum | cut -c1-10)
app="subtitle-ai-mirrors-$suffix"
if [[ $(az group exists --name "$group") != false ]]; then
  echo "作成を中止しました。専用リソースグループ名が使用中です。" >&2
  exit 1
fi
if [[ $(az webapp list --query "[?name=='$app'] | length(@)" -o tsv) != 0 ]]; then
  echo "作成を中止しました。アプリ名が使用中です。" >&2
  exit 1
fi
archive=$(mktemp -d)
trap 'rm -rf "$archive"' EXIT
zip -qr "$archive/app.zip" public server.js rooms.js boxes.js ai-box-review.js gemini-review.js gemini-dictionary.js reviewer-draft.js pagination.js speech-usage.js package.json package-lock.json
az group create --name "$group" --location "$location" --tags application=subtitle-ai-mirrors --output none
az appservice plan create -g "$group" -n "$plan" --is-linux --sku F1 --output none
az webapp create -g "$group" -p "$plan" -n "$app" --runtime 'NODE:22-lts' --output none
az webapp config appsettings set -g "$group" -n "$app" --settings SCM_DO_BUILD_DURING_DEPLOYMENT=true ROOM_STORE_PATH=/home/data/subtitle-ai-mirrors/rooms.json --output none
az webapp config set -g "$group" -n "$app" --web-sockets-enabled true --startup-file 'node server.js' --output none
az webapp deploy -g "$group" -n "$app" --src-path "$archive/app.zip" --type zip --output none
host=$(az webapp show -g "$group" -n "$app" --query defaultHostName -o tsv)
curl --fail --retry 8 --retry-all-errors "https://$host/healthz"
echo "https://$host/rooms.html"

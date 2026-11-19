#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 || ( $1 != inspect && $1 != apply ) ]]; then
  printf '%s\n' 'Usage: bash setup-speech-usage.sh inspect|apply F0_RESOURCE_NAME [SPEECH_GROUP]' >&2
  exit 2
fi

mode=$1
free_name=$2
speech_group=${3:-音声認識}
paid_name=subtitle-speech-s0
app_name=subtitle-ai-mirrors-th6k36zl5ltja
app_host=$app_name.azurewebsites.net

az account show --query id --output none

# Query one account object, without requesting any keys, to verify its tier.
require_speech(){
  local name=$1 required_tier=$2
  local resource='' tier='' kind=''
  read -r resource tier kind < <(az cognitiveservices account show \
    --resource-group "$speech_group" --name "$name" --query '[id, sku.name, kind]' --output tsv) || true
  if [[ -z $resource || $tier != "$required_tier" ||
        ( $kind != SpeechServices && $kind != AIServices && $kind != CognitiveServices ) ]]; then
    printf 'Speech リソースと価格レベル（%s）を確認してください。対象名: %s\n' "$required_tier" "$name" >&2
    return 1
  fi
  printf '%s\n' "$resource"
}

free_id=$(require_speech "$free_name" F0)
paid_id=$(require_speech "$paid_name" S0)
if [[ $mode == inspect ]]; then
  month_start=$(date -u -d "$(TZ=Asia/Tokyo date +%Y-%m-01T00:00:00%z)" +%Y-%m-%dT%H:%M:%SZ)
  checked_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  for speech_scope in "$free_id" "$paid_id"; do
    printf '%s\n' "${speech_scope##*/}"
    az monitor metrics list --resource "$speech_scope" --metrics AudioSecondsTranscribed \
      --aggregation Total --interval 1h --start-time "$month_start" --end-time "$checked_at" \
      --query 'value[].timeseries[].data[].total | {samples: length(@), seconds: length(@) > `0` && sum(@) || `null`}' \
      --output json
  done
  exit 0
fi

app_group='' detected_host=''
read -r app_group detected_host < <(az webapp list \
  --query "[?name=='$app_name'].[resourceGroup, defaultHostName] | [0]" --output tsv) || true
if [[ -z $app_group || $detected_host != "$app_host" ]]; then
  printf '%s\n' '選択中のサブスクリプションに音声版 App Service がありません。' >&2
  exit 1
fi

key_hashes(){
  az cognitiveservices account keys list --resource-group "$speech_group" --name "$1" \
    --query '[key1, key2]' --output tsv |
    python3 -c '
import hashlib,sys
keys=[key.strip() for key in sys.stdin.read().split() if key.strip()]
if len(keys)!=2: sys.exit("Azure Speech のキーを2つ取得できませんでした。")
print(",".join(hashlib.sha256(("subtitle-mirror-usage:v1:"+key).encode()).hexdigest() for key in keys))
'
}

free_hashes=$(key_hashes "$free_name")
paid_hashes=$(key_hashes "$paid_name")

identity_type=$(az webapp identity show --name "$app_name" --resource-group "$app_group" \
  --query type --output tsv)
case $identity_type in
  *SystemAssigned*)
    principal=$(az webapp identity show --name "$app_name" --resource-group "$app_group" \
      --query principalId --output tsv)
    ;;
  ''|None|none)
    principal=$(az webapp identity assign --name "$app_name" --resource-group "$app_group" \
      --query principalId --output tsv)
    ;;
  *)
    printf '%s\n' 'Azure ポータルで、既存の ID を維持したままシステム割り当て ID を有効にしてください。' >&2
    exit 1
    ;;
esac

if [[ ! $principal =~ ^[0-9a-fA-F-]{36}$ ]]; then
  printf '%s\n' 'App Service のマネージド ID を確認できませんでした。' >&2
  exit 1
fi

for speech_scope in "$free_id" "$paid_id"; do
  az role assignment create --assignee-object-id "$principal" --assignee-principal-type ServicePrincipal \
    --role Reader --scope "$speech_scope" --output none
done

az webapp config appsettings set --name "$app_name" --resource-group "$app_group" --settings \
  "SPEECH_F0_RESOURCE_ID=$free_id" "SPEECH_S0_RESOURCE_ID=$paid_id" \
  "SPEECH_F0_KEY_HASHES=$free_hashes" "SPEECH_S0_KEY_HASHES=$paid_hashes" --output none
printf '%s\n' '音声版 App Service の使用量表示設定を登録しました。'

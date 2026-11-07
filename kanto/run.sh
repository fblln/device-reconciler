#!/bin/sh
# Kanto writes its log to a file by default and its working directory must be
# writable for the bbolt twin database. Both are here rather than in the
# Dockerfile so the flags stay readable next to the compose file.
set -eu
exec /opt/kanto/local-digital-twins/local-digital-twins \
  -address "${KANTO_HUB_ADDRESS}" \
  -localAddress "${KANTO_LOCAL_ADDRESS}" \
  -tenantId "${KANTO_TENANT}" \
  -deviceId "${KANTO_DEVICE_ID}" \
  -authId "${KANTO_AUTH_ID}" \
  -password "${KANTO_PASSWORD}" \
  -policyId "${KANTO_POLICY_ID}" \
  -thingsDb /var/lib/kanto/things.db \
  -logFile "" \
  -logLevel "${KANTO_LOG_LEVEL:-INFO}"

#!/usr/bin/env bash
# 端到端验证：用 Docker Compose 启动一套干净的测试环境，创建测试账号，然后运行 Playwright 测试。
# 用法：bash scripts/run-e2e.sh [playwright 参数，如 e2e/02-pdf.spec.ts]
# 测试环境使用 .env.test（端口 8088，数据目录 .e2e-data），不会影响正式数据。
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=.env.test
if [ ! -f "$ENV_FILE" ]; then
  py=$(command -v python3 || command -v python)
  cat > "$ENV_FILE" <<EOF
WEB_PORT=8088
DATA_PATH=./.e2e-data
POSTGRES_PASSWORD=e2e-$($py -c "import secrets;print(secrets.token_hex(8))")
SECRET_KEY=$($py -c "import secrets;print(secrets.token_urlsafe(48))")
FIRST_SUPERUSER=admin@everread.test
FIRST_SUPERUSER_PASSWORD=admin-e2e-password
EOF
fi
DC="docker compose -p everread-test --env-file $ENV_FILE"

echo "== 重建测试环境"
$DC down -v --remove-orphans >/dev/null 2>&1 || true
rm -rf .e2e-data
$DC up -d --build --wait

echo "== 生成测试样本"
(cd backend && uv run python scripts/make_samples.py ../samples/generated)

echo "== 创建测试账号"
CLI="$DC exec -T backend python -m app.cli"
$CLI create-user alice@everread.test --name 阿丽 --password alice-password-1
$CLI create-user bob@everread.test --name 小博 --password bob-password-1
TEMP=$($CLI create-user carol@everread.test --name 卡萝 | sed -n 's/^临时密码：\([^（]*\).*/\1/p')

echo "== 运行 Playwright"
cd frontend
E2E_TEMP_PASSWORD="$TEMP" npx playwright test "$@"

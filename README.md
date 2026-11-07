# 永读 EverRead


- 后端：Python 3.12 + FastAPI + SQLModel + PostgreSQL（uv 管理依赖）
- 前端：React + TypeScript + Vite + Tailwind CSS，PDF.js 渲染 PDF，epub.js 渲染 EPUB
- 部署：Docker Compose（nginx 前端 + FastAPI + PostgreSQL），只对外暴露一个网页端口

详细需求与设计见 [plan/README.md](plan/README.md)。

## 功能

- 账号：管理员用命令行创建/停用账号、重置临时密码；不开放注册；首次登录强制改密
- 导入：书架工具栏“上传”按钮，或把文件直接拖到书架页面，校验真实文件类型；显示上传、解析、成功/失败；重复上传提示；加密 PDF、DRM EPUB、损坏文件给出提示；TXT 自动识别编码（UTF-8 / GB18030 等），乱码时可手动指定
- 书架：未读/在读/已读/已移出筛选、书名搜索、排序、继续阅读；移出书架不删除原书与记录
- 图书馆：上传者可把书设为公开（仅已登录成员可见），成员加入书架后各自的进度、笔记互不可见；改回私有或删除原书时，其他成员的笔记保留但不可跳转原文
- 阅读器：翻页式阅读，默认双页（封面单独，之后两两成对），可切换单页，窗口较窄时自动单页；点击左右两侧、方向键 / PageUp / PageDown / 空格、滚轮翻页；PDF 底部可输入页码跳转。目录 / 书签 / 标注侧栏，右侧笔记栏（手机为抽屉），亮色 / 暗色 / 暖黄主题；PDF 缩放、旋转、暖色/暗色显示；EPUB/TXT 字号与行距
- 自动保存进度：滚动稳定后保存、定时保存、页面隐藏时补存；断网时本机暂存，恢复后同步；多设备冲突时提示选择
- 标注与笔记：多色高亮（跨页 PDF 选区拆成同组标注）、选段写笔记、当前位置笔记、整书笔记；自动保存，失败可重试不重复创建
- 书签：同一本书多个书签，可命名、备注、按名称筛选，点击跳转
- 搜索：当前书内“正文 / 我的笔记 / 我的标注”，结果可跳转并高亮，支持返回跳转前位置
- 扫描版 PDF（无文字层）：可阅读、保存进度、书签、页级笔记；首版不做 OCR

## 部署（NAS / 任意 Docker 主机）

```bash
cp .env.example .env      # 修改其中的数据库密码、SECRET_KEY、管理员账号
docker compose up -d --build
```

浏览器访问 `http://<主机地址>:8080`，用 `.env` 里的 `FIRST_SUPERUSER` 登录。镜像基于官方多架构镜像，amd64 / arm64 的 NAS 都可以构建。

### 管理朋友账号

```bash
docker compose exec backend python -m app.cli create-user friend@example.com --name 小明   # 生成临时密码
docker compose exec backend python -m app.cli reset-password friend@example.com
docker compose exec backend python -m app.cli disable-user friend@example.com             # 立即使其登录失效
docker compose exec backend python -m app.cli enable-user friend@example.com
docker compose exec backend python -m app.cli list-users
```

### 数据与备份

所有数据都在 `DATA_PATH`（默认 `./data`）下：`postgres/` 是数据库，`books/` 是书籍原文件与解析产物。容器重建不会丢失数据。

```bash
# 备份：导出数据库 + 打包书籍目录
docker compose exec -T db pg_dump -U everread everread > backup-$(date +%F).sql
tar czf books-$(date +%F).tar.gz -C data books

# 恢复：先停后端，清空现有表结构（后端启动时会自动建表），导入数据库，再解压书籍目录
docker compose stop backend
docker compose exec -T db psql -U everread -d everread -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
docker compose exec -T db psql -U everread -d everread < backup-2026-11-07.sql
tar xzf books-2026-11-07.tar.gz -C data
docker compose start backend
```

升级前先备份；后端启动时会自动执行数据库迁移（`alembic upgrade head`）。

### HTTPS

应用同时支持 HTTP 与 HTTPS（登录使用 Bearer 令牌，不依赖 Cookie）。若要从外网访问，建议在 NAS 自带的反向代理或 Caddy 等前面加 HTTPS，再转发到 `WEB_PORT`。

## 本地开发（Windows）

```bash
# 数据库
docker run -d --name everread-devdb -e POSTGRES_USER=everread -e POSTGRES_PASSWORD=everread -e POSTGRES_DB=everread -p 55432:5432 postgres:17-alpine

# 后端（另开终端）
cd backend
set DATABASE_URL=postgresql+psycopg://everread:everread@localhost:55432/everread   # PowerShell: $env:DATABASE_URL="..."
uv run alembic upgrade head
uv run python -m app.cli create-user me@example.com --admin --password 你的密码
uv run fastapi dev app/main.py

# 前端（另开终端），开发服务器把 /api 代理到 localhost:8000
cd frontend
npm install
npm run dev
```

## 测试

```bash
# 后端单元/接口测试（SQLite，无需数据库）
cd backend && uv run pytest

# 端到端测试：用 Docker Compose 启动一套干净的测试环境（端口 8088），创建测试账号后运行 Playwright
bash scripts/run-e2e.sh
```

测试样本由 `backend/scripts/make_samples.py` 自动生成（自写内容）；自己的书可以放进 `samples/`，该目录不会提交到 Git。
